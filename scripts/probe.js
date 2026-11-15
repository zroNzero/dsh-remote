// Runtime probe. This file is the only place allowed to attempt spawn.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createSocket } from 'node:dgram'
import { writeFile } from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createNetServer, connect } from 'node:net'
import { networkInterfaces, hostname } from 'node:os'
import { join } from 'node:path'

function ipv6Addresses() {
  const rows = []
  for (const [name, list] of Object.entries(networkInterfaces())) {
    for (const item of list || []) {
      const family = item.family === 6 || item.family === 'IPv6'
      if (!family) continue
      const address = item.address
      rows.push({
        interface: name,
        address,
        internal: Boolean(item.internal),
        scopeid: item.scopeid ?? 0,
        loopback: address === '::1',
        linkLocal: /^fe[89ab][0-9a-f]:/i.test(address),
        global: !item.internal && address !== '::1' && !/^fe[89ab][0-9a-f]:/i.test(address),
      })
    }
  }
  return rows
}

function bindProbe(host) {
  return new Promise((resolve) => {
    const server = createNetServer()
    const timer = setTimeout(() => {
      server.close()
      resolve({ host, ok: false, error: 'ETIMEDOUT' })
    }, 3000)
    server.once('error', (error) => {
      clearTimeout(timer)
      resolve({ host, ok: false, error: error.code || error.message })
    })
    server.listen({ host, port: 0, ipv6Only: false }, () => {
      const address = server.address()
      clearTimeout(timer)
      server.close(() => resolve({ host, ok: true, address: address.address, family: address.family, port: address.port }))
    })
  })
}

function connectProbe(host) {
  return new Promise((resolve) => {
    const server = createNetServer()
    server.once('error', (error) => resolve({ host, ok: false, error: error.code || error.message }))
    server.listen({ host: '::', port: 0, ipv6Only: false }, () => {
      const port = server.address().port
      const socket = connect({ host, port })
      const timer = setTimeout(() => {
        socket.destroy()
        server.close()
        resolve({ host, ok: false, error: 'ETIMEDOUT' })
      }, 1500)
      socket.once('connect', () => {
        clearTimeout(timer)
        socket.destroy()
        server.close()
        resolve({ host, ok: true, port })
      })
      socket.once('error', (error) => {
        clearTimeout(timer)
        server.close()
        resolve({ host, ok: false, error: error.code || error.message })
      })
    })
  })
}

function modulesProbe() {
  const result = {}
  try { result.net = typeof createNetServer === 'function' } catch { result.net = false }
  try {
    const socket = createSocket('udp4')
    socket.close()
    result.dgram = true
  } catch { result.dgram = false }
  try { result.http = typeof createHttpServer === 'function' } catch { result.http = false }
  try { result.crypto = createHash('sha1').update('dsh').digest('hex').length === 40 } catch { result.crypto = false }
  return result
}

function spawnProbe() {
  try {
    const result = spawnSync(process.execPath, ['-e', 'process.exit(0)'], {
      timeout: 2000,
      windowsHide: true,
      encoding: 'utf8',
    })
    const signal = result.signal || null
    const error = result.error || null
    const errno = error && typeof error.errno === 'number' ? error.errno : null
    const code = error && error.code ? error.code : null
    const blocked = signal === 'SIGSYS' || errno === 13 || errno === -13 || code === 'EACCES'
    return {
      ok: result.status === 0,
      status: result.status,
      signal,
      errno,
      code,
      blocked,
      stderr: result.stderr ? result.stderr.trim().slice(0, 300) : '',
    }
  } catch (error) {
    const errno = typeof error.errno === 'number' ? error.errno : null
    return {
      ok: false,
      status: null,
      signal: error.signal || null,
      errno,
      code: error.code || null,
      blocked: error.signal === 'SIGSYS' || errno === 13 || errno === -13 || error.code === 'EACCES',
      stderr: String(error.message || error).slice(0, 300),
    }
  }
}

async function main() {
  const addresses = ipv6Addresses()
  const bindAny = await bindProbe('::')
  const bindLoopback = await bindProbe('::1')
  const bindV4 = await bindProbe('0.0.0.0')
  const connectLoopback = await connectProbe('::1')
  const spawn = spawnProbe()
  const result = {
    at: new Date().toISOString(),
    hostname: hostname(),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    ipv6: {
      addresses,
      hasGlobal: addresses.some((item) => item.global),
      hasLinkLocal: addresses.some((item) => item.linkLocal),
      hasLoopback: addresses.some((item) => item.loopback),
      bindAny,
      bindLoopback,
      bindV4,
      connectLoopback,
    },
    modules: modulesProbe(),
    spawn,
    env: {
      UV_USE_IO_URING: process.env.UV_USE_IO_URING ?? null,
      DSH_HOME: process.env.DSH_HOME ?? null,
    },
  }
  const text = JSON.stringify(result, null, 2)
  process.stdout.write(text + '\n')
  await writeFile(join(process.cwd(), 'probe-result.json'), text + '\n', 'utf8')
}

main().catch((error) => {
  process.stderr.write(String(error && error.stack ? error.stack : error) + '\n')
  process.exit(1)
})
