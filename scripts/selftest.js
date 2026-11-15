import { createServer as createNetServer } from 'node:net'
import { get as httpGet } from 'node:http'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'
import { dispatchControl, dispatchTask } from '../core/client.js'
import { ERROR_CODES } from '../core/errors.js'
import { loadConfig, normalizeConfig, saveConfig } from '../core/config.js'
import { isMobileRuntime } from '../core/platform.js'
import { toWsUrl } from '../core/ipv6.js'
import { normalizeTask } from '../core/protocol.js'
import { WorkerServer } from '../core/server.js'

let passed = 0
let failed = 0

async function check(name, fn) {
  try {
    await fn()
    passed += 1
    process.stdout.write(`PASS ${name}\n`)
  } catch (error) {
    failed += 1
    process.stderr.write(`FAIL ${name}: ${error && error.stack ? error.stack : error}\n`)
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'assert failed')
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

class FakeExecution {
  constructor(spec) {
    this.spec = spec
    this.stdout = ''
    this.stderr = ''
    this.exitCode = 0
    this.signal = null
    this.timedOut = false
    this.aborted = false
    this.settled = false
    this.resultPromise = deferred()
    this.timers = []
    this.abortListener = () => this.abort()
    if (spec.signal) spec.signal.addEventListener('abort', this.abortListener, { once: true })
    const timeout = setTimeout(() => {
      this.timedOut = true
      this.exitCode = null
      this.finish(null)
    }, spec.timeoutMs)
    if (typeof timeout.unref === 'function') timeout.unref()
    this.timers.push(timeout)
    this.start()
  }

  start() {
    const command = this.spec.command
    if (command.startsWith('echo ')) {
      this.stdout = command.slice(5) + '\n'
      this.after(20, () => this.finish(0))
      return
    }
    if (command === 'big') {
      this.stdout = 'x'.repeat(70000)
      this.after(20, () => this.finish(0))
      return
    }
    if (command === 'fail') {
      this.stderr = 'boom\n'
      this.after(20, () => this.finish(3))
      return
    }
    if (command === 'stderrbig') {
      this.stderr = 'e'.repeat(3000)
      this.after(20, () => this.finish(0))
      return
    }
    if (command === 'slow') {
      this.stdout = 'started\n'
      this.after(50, () => { this.stderr = 'nearly\n' })
      this.after(1200, () => this.finish(0))
      return
    }
    this.stderr = `unknown:${command}\n`
    this.after(20, () => this.finish(127))
  }

  after(ms, fn) {
    const timer = setTimeout(fn, ms)
    if (typeof timer.unref === 'function') timer.unref()
    this.timers.push(timer)
  }

  abort() {
    if (this.settled) return
    this.aborted = true
    this.exitCode = null
    this.finish(null)
  }

  finish(exitCode) {
    if (this.settled) return
    this.settled = true
    for (const timer of this.timers) clearTimeout(timer)
    try { this.spec.signal?.removeEventListener('abort', this.abortListener) } catch { /* 蹇界暐 */ }
    this.exitCode = exitCode
    this.resultPromise.resolve({
      exitCode,
      signal: null,
      timedOut: this.timedOut,
      aborted: this.aborted,
      durationMs: 1,
    })
  }

  reader(stream) {
    return {
      readFrom: (fromByte) => {
        const text = this[stream]
        const buffer = Buffer.from(text, 'utf8')
        const from = Math.min(fromByte, buffer.length)
        return {
          text: buffer.subarray(from).toString('utf8'),
          nextOffset: buffer.length,
          lossy: false,
        }
      },
    }
  }

  get observed() {
    return { stdout: this.reader('stdout'), stderr: this.reader('stderr') }
  }

  result() {
    return this.resultPromise.promise
  }

  kill() {
    this.abort()
    return true
  }
}

function fakeShell() {
  return {
    resolve(request) {
      return {
        command: request.command,
        workdir: request.workdir,
        timeoutMs: request.timeoutMs,
        signal: request.signal,
      }
    },
    async execute(spec) {
      return new FakeExecution(spec)
    },
  }
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = createNetServer()
    server.once('error', reject)
    server.listen({ host: '::', port: 0, ipv6Only: false }, () => {
      const port = server.address().port
      server.close(() => resolve(port))
    })
  })
}

function portReleased(port) {
  return new Promise((resolve) => {
    const server = createNetServer()
    server.once('error', () => resolve(false))
    server.listen({ host: '::', port, ipv6Only: false }, () => {
      server.close(() => resolve(true))
    })
  })
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function makeConfig(overrides) {
  return normalizeConfig({
    role: 'host',
    port: 0,
    token: 'secret-token',
    peerHost: '::1',
    peerPort: 3099,
    allowCommands: ['*'],
    allowCwd: [homedir()],
    connectTimeoutMs: 2000,
    defaultTimeoutMs: 5000,
    maxTaskMs: 60000,
    maxConcurrent: 1,
    onOffline: 'offline-hook',
    ...overrides,
  })
}

async function startServer(overrides = {}) {
  const config = makeConfig(overrides)
  const control = overrides.control === undefined ? null : overrides.control
  const server = new WorkerServer({ config, shell: fakeShell(), control })
  await server.start()
  config.peerPort = server.actualPort
  return { server, config }
}

async function main() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-remote-worker-selftest-'))
  process.env.DSH_HOME = home
  try {
    await check('control channel reads and writes target', async () => {
      const state = { cwd: 'D:\\PC\\dsh', sessionId: '' }
      const control = {
        get: () => ({ qq: { ...state }, workspaces: [{ id: 'w1', path: 'D:\\PC\\dsh', title: 'dsh' }] }),
        set: (patch) => {
          if (patch && typeof patch.cwd === 'string') state.cwd = patch.cwd
          if (patch && typeof patch.sessionId === 'string') state.sessionId = patch.sessionId
          return { qq: { ...state } }
        },
      }
      const { server, config } = await startServer({ control })
      try {
        const read = await dispatchControl({ config, request: { type: 'cfg.get' } })
        assert(read.ok === true, 'get ok')
        assert(read.data.qq.cwd === 'D:\\PC\\dsh', `cwd ${read.data.qq.cwd}`)
        assert(read.data.workspaces.length === 1, 'workspaces')
        const written = await dispatchControl({
          config,
          request: { type: 'cfg.set', patch: { cwd: 'D:\\PC\\dsh\\dsh-remote', sessionId: 'session-x' } },
        })
        assert(written.ok === true, 'set ok')
        assert(written.data.qq.sessionId === 'session-x', `sessionId ${written.data.qq.sessionId}`)
        const reread = await dispatchControl({ config, request: { type: 'cfg.get' } })
        assert(reread.data.qq.cwd === 'D:\\PC\\dsh\\dsh-remote', 'persisted cwd')
      } finally {
        await server.dispose()
      }
    })

    await check('control channel rejects without handler', async () => {
      const { server, config } = await startServer()
      try {
        let error = null
        try { await dispatchControl({ config, request: { type: 'cfg.get' } }) } catch (reason) { error = reason }
        assert(error !== null, 'expected error')
        assert(error.code === 'ERR_ROLE_UNSUPPORTED', `code ${error.code}`)
      } finally {
        await server.dispose()
      }
    })

    await check('mobile runtime detection', async () => {
      assert(isMobileRuntime('/data/storage/el2/base/files/engine/bin/node', 'linux', '/system/bin:/usr/bin') === true, 'engine path')
      assert(isMobileRuntime('/data/data/app.kxxy/files/engine/bin/node', 'android', '') === true, 'android')
      assert(isMobileRuntime('C:\\Program Files\\nodejs\\node.exe', 'win32', '') === false, 'windows')
      assert(toWsUrl('::1', 3099) === 'ws://[::1]:3099/ws', 'bracket url')
    })

    await check('health endpoint over IPv6', async () => {
      const { server } = await startServer()
      try {
        const body = await new Promise((resolve, reject) => {
          const req = httpGet({ hostname: '::1', port: server.actualPort, path: '/health' }, (res) => {
            let text = ''
            res.setEncoding('utf8')
            res.on('data', (chunk) => { text += chunk })
            res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }))
          })
          req.on('error', reject)
        })
        assert(body.status === 200, 'health status')
        assert(body.body.ok === true, 'health body')
      } finally {
        await server.dispose()
      }
    })

    await check('port in use reports ERR_PORT_IN_USE', async () => {
      const { server } = await startServer()
      const second = new WorkerServer({
        config: makeConfig({ port: server.actualPort }),
        shell: fakeShell(),
      })
      try {
        let error = null
        try { await second.start() } catch (reason) { error = reason }
        assert(error && error.code === ERROR_CODES.PORT, `code ${error && error.code}`)
      } finally {
        await second.dispose().catch(() => {})
        await server.dispose()
      }
    })

    await check('echo over IPv6 WebSocket', async () => {
      const { server, config } = await startServer()
      try {
        const task = normalizeTask({ command: 'echo hello', cwd: homedir(), timeoutMs: 3000 }, config).task
        const result = await dispatchTask({ config, task })
        assert(result.exitCode === 0, 'exit 0')
        assert(result.stdout === 'hello\n', `stdout ${JSON.stringify(result.stdout)}`)
        assert(result.stderr === '', 'stderr empty')
      } finally {
        await server.dispose()
      }
    })

    await check('64KB stream framing and sequence', async () => {
      const { server, config } = await startServer()
      try {
        const task = normalizeTask({ command: 'big', cwd: homedir(), timeoutMs: 3000 }, config).task
        const chunks = []
        const result = await dispatchTask({ config, task, onStdout: (text) => chunks.push(text) })
        assert(result.exitCode === 0, 'exit 0')
        assert(result.stdout.length === 70000, `stdout length ${result.stdout.length}`)
        assert(chunks.length >= 2, `chunks ${chunks.length}`)
      } finally {
        await server.dispose()
      }
    })

    await check('stderr and non-zero exit', async () => {
      const { server, config } = await startServer()
      try {
        const task = normalizeTask({ command: 'fail', cwd: homedir(), timeoutMs: 3000 }, config).task
        let error = null
        try { await dispatchTask({ config, task }) } catch (reason) { error = reason }
        assert(error && error.code === ERROR_CODES.EXEC, 'ERR_EXEC')
        assert(error.details && error.details.exitCode === 3, 'exit 3')
        assert(error.details.stderr === 'boom\n', 'stderr tail')
      } finally {
        await server.dispose()
      }
    })

    await check('stderr tail 2KB', async () => {
      const { server, config } = await startServer()
      try {
        const task = normalizeTask({ command: 'stderrbig', cwd: homedir(), timeoutMs: 3000 }, config).task
        const result = await dispatchTask({ config, task })
        assert(result.exitCode === 0, 'exit 0')
        assert(result.stderr.length === 2048, `stderr length ${result.stderr.length}`)
      } finally {
        await server.dispose()
      }
    })

    await check('auth failure', async () => {
      const { server, config } = await startServer()
      try {
        const task = normalizeTask({ command: 'echo hello', cwd: homedir(), timeoutMs: 3000 }, config).task
        const wrong = { ...config, token: 'wrong-token' }
        let error = null
        try { await dispatchTask({ config: wrong, task }) } catch (reason) { error = reason }
        assert(error && error.code === ERROR_CODES.AUTH, `code ${error && error.code}`)
      } finally {
        await server.dispose()
      }
    })

    await check('empty whitelist rejects', async () => {
      const { server, config } = await startServer({ allowCommands: [] })
      try {
        const task = normalizeTask({ command: 'echo hello', cwd: homedir(), timeoutMs: 3000 }, config).task
        let error = null
        try { await dispatchTask({ config, task }) } catch (reason) { error = reason }
        assert(error && error.code === ERROR_CODES.REJECTED, `code ${error && error.code}`)
      } finally {
        await server.dispose()
      }
    })

    await check('cwd whitelist rejects outside home', async () => {
      await mkdir(join(home, 'allowed'), { recursive: true })
      const { server, config } = await startServer({ allowCwd: [join(home, 'allowed')] })
      try {
        const task = normalizeTask({ command: 'echo hello', cwd: home, timeoutMs: 3000 }, config).task
        let error = null
        try { await dispatchTask({ config, task }) } catch (reason) { error = reason }
        assert(error && error.code === ERROR_CODES.REJECTED, `code ${error && error.code}`)
      } finally {
        await server.dispose()
      }
    })

    await check('offline error carries fallback and task', async () => {
      const port = await getFreePort()
      const config = makeConfig({ peerHost: '::1', peerPort: port, onOffline: 'hook-1' })
      const task = normalizeTask({ command: 'echo hello', cwd: homedir(), timeoutMs: 1234 }, config).task
      let error = null
      try { await dispatchTask({ config, task }) } catch (reason) { error = reason }
      assert(error && error.code === ERROR_CODES.OFFLINE, `code ${error && error.code}`)
      assert(error.fallback === 'offline_queue', 'fallback')
      assert(error.onOffline === 'hook-1', 'onOffline')
      assert(error.task.command === 'echo hello', 'task command')
      assert(error.task.timeoutMs === 1234, 'task timeoutMs')
    })

    await check('client timeout', async () => {
      const { server, config } = await startServer()
      try {
        const task = normalizeTask({ command: 'slow', cwd: homedir(), timeoutMs: 200 }, config).task
        let error = null
        const started = Date.now()
        try { await dispatchTask({ config, task }) } catch (reason) { error = reason }
        assert(error && error.code === ERROR_CODES.TIMEOUT, `code ${error && error.code}`)
        assert(Date.now() - started < 3000, 'timeout prompt')
      } finally {
        await server.dispose()
      }
    })

    await check('interrupted connection is not guessed', async () => {
      const { server, config } = await startServer()
      try {
        const task = normalizeTask({ command: 'slow', cwd: homedir(), timeoutMs: 5000 }, config).task
        const pending = dispatchTask({ config, task })
        await wait(150)
        for (const peer of server.connections) peer.destroy()
        let error = null
        try { await pending } catch (reason) { error = reason }
        assert(error && error.code === ERROR_CODES.INTERRUPTED, `code ${error && error.code}`)
      } finally {
        await server.dispose()
      }
    })

    await check('port released after dispose', async () => {
      const { server } = await startServer()
      const port = server.actualPort
      await server.dispose()
      assert(server.connections.size === 0, 'connections remain')
      assert(await portReleased(port), 'port still in use')
    })

    await check('plugin apply registers remote_execute and dispatches', async () => {
      const port = await getFreePort()
      const tools = []
      let toolDefinition = null
      const fake = {
        logger: { info: () => {} },
        get(name) {
          if (name === 'shell') return fakeShell()
          if (name === 'tools') return { register: (definition) => { toolDefinition = definition; tools.push(definition); return () => {} } }
          if (name === 'systemPrompt') return { section: () => () => {} }
          if (name === 'webServer') return { register: () => () => {} }
          return null
        },
        effect(fn) { const cleanup = fn(); if (cleanup) fake.cleanups.push(cleanup); return cleanup },
        inject(_names, callback) { callback(fake) },
        cleanups: [],
      }
      await apply(fake, {
        role: 'host',
        port,
        peerPort: port,
        token: 'secret-token',
        peerHost: '::1',
        allowCommands: ['*'],
        allowCwd: [homedir()],
        connectTimeoutMs: 2000,
        defaultTimeoutMs: 5000,
      })
      try {
        assert(toolDefinition && toolDefinition.name === 'remote_execute', 'tool registered')
        const value = await toolDefinition.execute({ command: 'echo plugin' })
        assert(value.ok === true, 'tool ok')
        assert(value.stdout === 'plugin\n', `tool stdout ${JSON.stringify(value.stdout)}`)
      } finally {
        for (const cleanup of fake.cleanups.reverse()) {
          try { await cleanup() } catch { /* 蹇界暐 */ }
        }
        await wait(50)
        assert(await portReleased(port), 'plugin port still in use')
      }
    })

    await check('remote_execute exposes offline fallback to model text', async () => {
      const listenPort = await getFreePort()
      const offlinePort = await getFreePort()
      let toolDefinition = null
      const ctx = {
        logger: { info: () => {} },
        get(name) {
          if (name === 'shell') return fakeShell()
          if (name === 'tools') return { register: (definition) => { toolDefinition = definition; return () => {} } }
          if (name === 'systemPrompt') return { section: () => () => {} }
          if (name === 'webServer') return { register: () => () => {} }
          return null
        },
        effect(fn) { const cleanup = fn(); if (cleanup) ctx.cleanups.push(cleanup); return cleanup },
        inject(_names, callback) { callback(ctx) },
        cleanups: [],
      }
      await apply(ctx, {
        role: 'host',
        port: listenPort,
        peerPort: offlinePort,
        token: 'secret-token',
        peerHost: '::1',
        allowCommands: ['*'],
        allowCwd: [homedir()],
        connectTimeoutMs: 500,
        defaultTimeoutMs: 5000,
        onOffline: 'offline-hook',
      })
      try {
        assert(toolDefinition, 'tool missing')
        const value = await toolDefinition.execute({ command: 'echo offline', cwd: homedir(), timeoutMs: 1234 })
        assert(value.ok === false, 'should fail')
        assert(value.error.code === ERROR_CODES.OFFLINE, 'offline code')
        assert(value.error.fallback === 'offline_queue', 'fallback')
        assert(value.error.task.command === 'echo offline', 'task command')
        assert(value.error.task.timeoutMs === 1234, 'task timeout')
        const text = toolDefinition.output.render({}, value)[0].text
        assert(text.includes('fallback=offline_queue'), 'model text fallback')
        assert(text.includes('task='), 'model text task')
      } finally {
        for (const cleanup of ctx.cleanups.reverse()) {
          try { await cleanup() } catch { /* 蹇界暐 */ }
        }
      }
    })

    await check('mobile host role rejected', async () => {
      const original = process.execPath
      process.execPath = '/data/storage/el2/base/files/engine/bin/node'
      const ctx = {
        logger: { info: () => {} },
        get(name) {
          if (name === 'shell') return fakeShell()
          if (name === 'tools') return { register: () => () => {} }
          if (name === 'systemPrompt') return { section: () => () => {} }
          if (name === 'webServer') return { register: () => () => {} }
          return null
        },
        effect(fn) { const cleanup = fn(); if (cleanup) ctx.cleanups.push(cleanup); return cleanup },
        inject(_names, callback) { callback(ctx) },
        cleanups: [],
      }
      try {
        let error = null
        try {
          await apply(ctx, { role: 'host', token: 'secret-token', peerHost: '::1', allowCommands: ['*'] })
        } catch (reason) {
          error = reason
        }
        assert(error && error.code === ERROR_CODES.ROLE, `code ${error && error.code}`)
      } finally {
        process.execPath = original
        for (const cleanup of ctx.cleanups.reverse()) {
          try { await cleanup() } catch { /* 蹇界暐 */ }
        }
      }
    })

    await check('config roundtrip', async () => {
      const saved = normalizeConfig({
        role: 'client',
        token: 'roundtrip-token',
        peerHost: '::1',
        peerPort: 3099,
        allowCommands: ['echo *'],
        allowCwd: [home],
        onOffline: 'hook-roundtrip',
      })
      await saveConfig(saved)
      const loaded = await loadConfig({})
      assert(loaded.config.role === 'client', 'role')
      assert(loaded.config.token === 'roundtrip-token', 'token')
      assert(loaded.config.allowCommands[0] === 'echo *', 'allowCommands')
      assert(loaded.config.onOffline === 'hook-roundtrip', 'onOffline')
    })

    process.stdout.write(`\n${passed} passed, ${failed} failed\n`)
    if (failed > 0) process.exitCode = 1
  } finally {
    try { await rm(home, { recursive: true, force: true }) } catch { /* 蹇界暐 */ }
  }
}

main().catch((error) => {
  process.stderr.write(String(error && error.stack ? error.stack : error) + '\n')
  process.exit(1)
})
