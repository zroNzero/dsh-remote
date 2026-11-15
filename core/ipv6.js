import { createServer } from 'node:net'
import { networkInterfaces } from 'node:os'
import { isIPv6 } from 'node:net'

export function listIPv6Addresses() {
  const rows = []
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    for (const entry of entries || []) {
      const family = entry.family === 6 || entry.family === 'IPv6'
      if (!family) continue
      const address = entry.address
      const linkLocal = /^fe[89ab][0-9a-f]:/i.test(address)
      rows.push({
        interface: name,
        address,
        scopeid: entry.scopeid || 0,
        internal: Boolean(entry.internal),
        loopback: address === '::1',
        linkLocal,
        global: !entry.internal && address !== '::1' && !linkLocal,
        url: address.includes('%') ? address : (linkLocal && entry.scopeid ? `${address}%${entry.scopeid}` : address),
      })
    }
  }
  rows.sort((left, right) => rank(left) - rank(right) || left.address.localeCompare(right.address))
  return rows
}

function rank(item) {
  if (item.loopback) return 3
  if (item.linkLocal) return 2
  if (item.global) return 0
  return 1
}

export function primaryIPv6() {
  const rows = listIPv6Addresses()
  return rows.find((item) => item.global) || rows.find((item) => !item.internal && !item.loopback) || rows.find((item) => item.loopback) || null
}

export function hasIPv6Literal(host) {
  return typeof host === 'string' && isIPv6(host.split('%')[0])
}

export function stripBrackets(host) {
  if (typeof host !== 'string') return ''
  let value = host.trim()
  if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1)
  return value.replace(/%25/g, '%')
}

export function bracketHost(host) {
  const value = stripBrackets(host)
  const zoneAt = value.indexOf('%')
  const address = zoneAt >= 0 ? value.slice(0, zoneAt) : value
  const zone = zoneAt >= 0 ? encodeURIComponent(value.slice(zoneAt + 1)) : ''
  return `[${address}${zone ? `%25${zone}` : ''}]`
}

export function toWsUrl(host, port, pathname = '/ws') {
  const path = pathname.startsWith('/') ? pathname : `/${pathname}`
  return `ws://${bracketHost(host)}:${Number(port)}${path}`
}

export function toHttpUrl(host, port, pathname = '/health') {
  const path = pathname.startsWith('/') ? pathname : `/${pathname}`
  return `http://${bracketHost(host)}:${Number(port)}${path}`
}

export function bindProbe(host, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const server = createServer()
    let settled = false
    const done = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { server.close() } catch { /* 已关闭 */ }
      resolve(value)
    }
    const timer = setTimeout(() => done({ ok: false, error: 'ETIMEDOUT' }), timeoutMs)
    server.once('error', (error) => done({ ok: false, error: error.code || error.message }))
    server.listen({ host, port: 0, ipv6Only: false }, () => {
      const address = server.address()
      done({ ok: true, address: address.address, family: address.family, port: address.port })
    })
  })
}

export async function probeIPv6() {
  const addresses = listIPv6Addresses()
  const any = await bindProbe('::')
  const loopback = addresses.some((item) => item.loopback)
  return {
    available: any.ok,
    bindAny: any.ok,
    bindError: any.ok ? null : any.error,
    loopback,
    hasGlobal: addresses.some((item) => item.global),
    hasLinkLocal: addresses.some((item) => item.linkLocal),
    addresses,
  }
}
