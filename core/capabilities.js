import { PROBE_DEFAULTS } from './probe-defaults.js'
import { probeIPv6 } from './ipv6.js'
import { isMobileRuntime, runtimeKind } from './platform.js'

export async function detectCapabilities(ctx) {
  let ipv6
  try {
    ipv6 = await probeIPv6()
  } catch (error) {
    ipv6 = {
      available: PROBE_DEFAULTS.ipv6.bindAny,
      bindAny: PROBE_DEFAULTS.ipv6.bindAny,
      bindError: error.code || error.message,
      loopback: PROBE_DEFAULTS.ipv6.hasLoopback,
      hasGlobal: PROBE_DEFAULTS.ipv6.hasGlobal,
      hasLinkLocal: PROBE_DEFAULTS.ipv6.hasLinkLocal,
      addresses: [],
    }
  }
  const mobile = isMobileRuntime()
  const loadedShell = mobile ? null : await waitForShell(ctx, 1500)
  const shell = loadedShell || readShell(ctx)
  const canSpawn = shell !== null && !mobile && PROBE_DEFAULTS.spawnBlocked !== true
  const canServe = canSpawn && ipv6.bindAny
  const canDispatch = true
  return {
    canServe,
    canDispatch,
    canSpawn,
    shell,
    mobile,
    kind: runtimeKind(),
    ipv6,
    platform: process.platform,
    node: process.version,
    probeSource: 'live',
  }
}

export function waitForShell(ctx, timeoutMs = 1500) {
  const immediate = readShell(ctx)
  if (immediate) return Promise.resolve(immediate)
  if (!ctx || typeof ctx.inject !== 'function') return Promise.resolve(null)
  return new Promise((resolve) => {
    let settled = false
    let found = null
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(found)
    }
    const timer = setTimeout(finish, timeoutMs)
    try {
      ctx.inject(['shell'], (sub) => {
        found = readShell(sub) || readShell(ctx)
        finish()
      })
    } catch {
      finish()
    }
  })
}

export function readShell(ctx) {
  if (!ctx || typeof ctx.get !== 'function') return null
  let shell = null
  try { shell = ctx.get('shell') } catch { shell = null }
  if (!shell || typeof shell.resolve !== 'function' || typeof shell.execute !== 'function') return null
  return shell
}

export function resolveRole(config, capabilities) {
  if (config.role === 'host' || config.role === 'client') return config.role
  return capabilities.canServe ? 'host' : 'client'
}
