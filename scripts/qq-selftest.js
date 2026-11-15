import { createServer } from 'node:http'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { zstdCompressSync } from 'node:zlib'
import { join } from 'node:path'
import { normalizeConfig, normalizeQqConfig } from '../core/config.js'
import { QqChannel } from '../core/qq/channel.js'
import { cleanupResults, resultDir, writeResult } from '../core/qq/result-sink.js'
import { listWorkspaces, sessionDirName } from '../core/workspaces.js'
import { readConsumed, writeConsumed } from '../core/qq/consumed.js'
import {
  readerLockPath,
  readerStateBackupPath,
  readerStatePath,
  SyncResultReader,
} from '../core/sync-reader.js'
import { isUpgradeRequest, WsPeer, writeUpgradeResponse } from '../core/ws.js'

let passed = 0
let failed = 0

function assert(condition, message) {
  if (!condition) throw new Error(message || 'assert failed')
}

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

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(fn, timeoutMs = 5000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const value = await fn()
    if (value) return value
    await wait(25)
  }
  throw new Error('waitFor timeout')
}

function fakeShell() {
  return {
    resolve(request) { return request },
    async execute(spec) {
      const stdout = spec.command.startsWith('echo ') ? `${spec.command.slice(5)}\n` : 'ok\n'
      const result = { exitCode: 0, signal: null, timedOut: false, aborted: false, durationMs: 1 }
      return {
        observed: {
          stdout: { readFrom: (from) => ({ text: Buffer.from(stdout).subarray(from).toString('utf8'), nextOffset: Buffer.byteLength(stdout), lossy: false }) },
          stderr: { readFrom: (from) => ({ text: '', nextOffset: from, lossy: false }) },
        },
        result: async () => result,
        done: Promise.resolve(),
        kill() {},
      }
    },
  }
}

class FakeAgent {
  constructor() {
    this.id = 'session-1'
    this.status = 'idle'
    this.messages = []
    this.resolveIdle = null
  }

  get session() {
    return { deriveMessages: () => this.messages.slice() }
  }

  followup(message) {
    this.messages.push(message)
    this.messages.push({
      id: 'reply-1',
      role: 'assistant',
      content: [{ type: 'text', text: `reply:${message.content[0].text}` }],
      source: { kind: 'model', provider: 'test', model: 'test' },
    })
  }

  whenIdle() {
    return Promise.resolve()
  }

  cancel() {
    this.status = 'idle'
  }
}

function fakeAgents(agent) {
  return {
    list: () => [agent],
    get: (id) => (id === agent.id ? agent : null),
  }
}

function fakeWorkspaceAgents() {
  const created = []
  const resumed = []
  const live = new Map()
  const make = (id, cwd) => {
    const agent = new FakeAgent()
    agent.id = id
    agent.cwd = cwd
    live.set(id, agent)
    return {
      agent,
      dispose() { live.delete(id) },
    }
  }
  return {
    created,
    resumed,
    live,
    list: () => [...live.values()],
    get: (id) => live.get(id) ?? null,
    create: async (options) => {
      created.push({ sessionId: options.sessionId, cwd: options.meta && options.meta.cwd })
      return make(options.sessionId, options.meta ? options.meta.cwd : '')
    },
    resume: async (options) => {
      resumed.push(options.resumeSessionId)
      return make(options.resumeSessionId, 'resumed')
    },
  }
}

async function createServerState() {
  const state = {
    server: null,
    port: 0,
    tokenRequests: 0,
    gatewayRequests: 0,
    identifyCount: 0,
    resumeCount: 0,
    heartbeatCount: 0,
    opcodes: [],
    peers: new Set(),
    lastIdentifiedToken: '',
    lastGatewayAuth: '',
    ready: false,
  }
  const server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/token') {
      state.tokenRequests += 1
      let body = ''
      req.setEncoding('utf8')
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => {
        const parsed = JSON.parse(body || '{}')
        assert(parsed.appId === 'app-id', 'token appId')
        assert(parsed.clientSecret === 'app-secret', 'token secret')
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ access_token: 'token-1', expires_in: 7200 }))
      })
      return
    }
    if (req.method === 'GET' && req.url === '/gateway') {
      state.gatewayRequests += 1
      state.lastGatewayAuth = req.headers.authorization || ''
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ url: `ws://127.0.0.1:${state.port}/websocket/` }))
      return
    }
    res.writeHead(404)
    res.end()
  })
  server.on('upgrade', (req, socket, head) => {
    if (!isUpgradeRequest(req)) {
      socket.destroy()
      return
    }
    writeUpgradeResponse(socket, req.headers['sec-websocket-key'])
    const peer = new WsPeer(socket, { role: 'server' })
    state.peers.add(peer)
    peer.onclose = () => {
      state.peers.delete(peer)
      state.ready = false
    }
    peer.sendText(JSON.stringify({ op: 10, d: { heartbeat_interval: 1000 } }))
    peer.onmessage = (text) => {
      const frame = JSON.parse(text)
      state.opcodes.push(frame.op)
      if (frame.op === 2) {
        state.identifyCount += 1
        state.lastIdentifiedToken = frame.d && frame.d.token
        if (frame.d.intents !== 1 << 25) throw new Error(`intents ${frame.d.intents}`)
        if (!Array.isArray(frame.d.shard) || frame.d.shard[0] !== 0 || frame.d.shard[1] !== 1) throw new Error('shard')
        peer.sendText(JSON.stringify({ op: 0, s: 1, t: 'READY', d: { session_id: 'session-qq' } }))
        state.ready = true
      } else if (frame.op === 6) {
        state.resumeCount += 1
        peer.sendText(JSON.stringify({ op: 0, s: 2, t: 'RESUMED', d: {} }))
        state.ready = true
      } else if (frame.op === 1) {
        state.heartbeatCount += 1
        peer.sendText(JSON.stringify({ op: 11 }))
      }
    }
    if (head && head.length > 0) peer.feed(head)
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      state.server = server
      state.port = server.address().port
      resolve()
    })
  })
  return state
}

function sendEvent(state, content, id, sender) {
  const peer = [...state.peers].at(-1)
  if (!peer) throw new Error('no peer')
  peer.sendText(JSON.stringify({
    op: 0,
    s: 3,
    t: 'C2C_MESSAGE_CREATE',
    d: { id, content, author: { user_openid: sender }, timestamp: new Date().toISOString() },
  }))
}

function testResult(id, createdAt, overrides = {}) {
  return {
    id,
    dedupeKey: `qq:${id}`,
    source: 'qq',
    kind: 'task-result',
    createdAt,
    instruction: `test ${id}`,
    status: 'ok',
    exitCode: 0,
    stdout: `${id}\n`,
    stderr: '',
    durationMs: 1,
    messageId: `msg-${id}`,
    sender: '***',
    senderHash: '0'.repeat(64),
    ...overrides,
  }
}

async function latestResult() {
  const dir = resultDir()
  const files = (await readdir(dir).catch(() => [])).filter((name) => name.endsWith('.json'))
  if (files.length === 0) return null
  const rows = []
  for (const name of files) {
    const info = await stat(join(dir, name)).catch(() => null)
    rows.push({ name, mtime: info ? info.mtimeMs : 0 })
  }
  rows.sort((left, right) => left.mtime - right.mtime)
  return JSON.parse(await readFile(join(dir, rows.at(-1).name), 'utf8'))
}

function makeChannel(state, dir, overrides = {}) {
  const qq = normalizeQqConfig({
    enabled: true,
    appId: 'app-id',
    appSecret: 'app-secret',
    apiBase: `http://127.0.0.1:${state.port}`,
    tokenUrl: `http://127.0.0.1:${state.port}/token`,
    whitelist: ['user-1'],
    mode: 'exec',
    prefix: '/exec',
    cwd: dir,
    timeoutMs: 5000,
    maxQueue: 4,
    ...overrides,
  })
  const root = normalizeConfig({
    allowCommands: ['*'],
    allowCwd: [dir],
    defaultTimeoutMs: 5000,
    maxTaskMs: 60000,
  })
  const ctx = {
    get(name) {
      if (name === 'shell') return fakeShell()
      if (name === 'agents') return overrides.agents || null
      return null
    },
  }
  return new QqChannel({ ctx, config: qq, rootConfig: () => root, logger: { info: () => {} } })
}

async function main() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qq-selftest-'))
  process.env.DSH_HOME = dir
  const state = await createServerState()
  const channel = makeChannel(state, dir)
  try {
    await check('identify, heartbeat, exec result, no outbound dispatch', async () => {
      channel.start()
      await waitFor(() => state.identifyCount > 0)
      assert(state.lastIdentifiedToken === 'QQBot token-1', `identify token ${state.lastIdentifiedToken}`)
      await waitFor(() => state.ready)
      sendEvent(state, '/exec echo hello', 'msg-1', 'user-1')
      const result = await waitFor(() => latestResult())
      assert(result.status === 'ok', `status ${result.status}`)
      assert(result.command === 'echo hello', `command ${result.command}`)
      assert(result.stdout.trim() === 'hello', `stdout ${JSON.stringify(result.stdout)}`)
      assert(result.exitCode === 0, 'exitCode')
      assert(result.messageId === 'msg-1', 'messageId')
      assert(result.dedupeKey === 'qq:msg-1', 'dedupeKey')
      assert(result.kind === 'task-result', 'kind')
      assert(result.sender !== 'user-1', 'sender not masked')
      assert(typeof result.senderHash === 'string' && result.senderHash.length === 64, 'senderHash')
      assert(typeof result.id === 'string' && result.id.startsWith('qq-'), 'result id')
      await waitFor(() => state.heartbeatCount > 0, 3000)
      assert(state.heartbeatCount > 0, 'heartbeat')
      assert(!state.opcodes.includes(0), 'client sent dispatch')
      assert(state.opcodes.every((op) => [1, 2, 6].includes(op)), `client opcodes ${state.opcodes}`)
    })

    await check('result writes under storages/dsh-remote-worker/results', async () => {
      const result = {
        id: 'qq-sink-1',
        dedupeKey: 'qq:msg-sink',
        source: 'qq',
        kind: 'task-result',
        createdAt: new Date().toISOString(),
        instruction: '/exec echo sink',
        status: 'ok',
        exitCode: 0,
        stdout: 'sink\n',
        stderr: '',
        durationMs: 1,
        messageId: 'msg-sink',
        sender: 'user-1',
      }
      const written = await writeResult(result)
      const expected = join(dir, 'storages', 'dsh-remote-worker', 'results')
      assert(written.dir === expected, `dir ${written.dir}`)
      assert(written.path.startsWith(expected), `path ${written.path}`)
      const saved = JSON.parse(await readFile(written.path, 'utf8'))
      assert(saved.id === 'qq-sink-1', 'saved id')
      assert(saved.kind === 'task-result', 'kind')
      assert(saved.dedupeKey === 'qq:msg-sink', 'dedupeKey')
    })

    await check('whitelist ignores other sender', async () => {
      const before = (await readdir(resultDir())).filter((name) => name.endsWith('.json')).length
      sendEvent(state, '/exec echo ignored', 'msg-2', 'user-2')
      await wait(300)
      const after = (await readdir(resultDir())).filter((name) => name.endsWith('.json')).length
      assert(after === before, 'ignored message wrote result')
      assert(channel.status().ignored >= 1, 'ignored counter')
    })

    await check('empty whitelist allows all senders', async () => {
      const before = (await readdir(resultDir())).filter((name) => name.endsWith('.json')).length
      channel.config.whitelist = []
      assert(channel.status().allowAll === true, 'allowAll flag')
      sendEvent(state, '/exec echo open', 'msg-open', 'user-open')
      const result = await waitFor(async () => {
        const rows = (await readdir(resultDir())).filter((name) => name.endsWith('.json'))
        return rows.length > before ? await latestResult() : null
      }, 5000)
      assert(result.instruction === '/exec echo open', 'open sender rejected')
      channel.config.whitelist = ['user-1']
    })

    await check('resume after disconnect and token cache', async () => {
      const tokenRequests = state.tokenRequests
      const peer = [...state.peers].at(-1)
      peer.close(1000)
      await waitFor(() => state.resumeCount > 0, 6000)
      assert(state.tokenRequests === tokenRequests, 'token refreshed on reconnect')
      assert(channel.status().state === 'ready', `state ${channel.status().state}`)
    })

    await check('token refresh before expiry', async () => {
      const before = state.tokenRequests
      channel.auth.expiresAt = Date.now() - 1
      const gateway = await channel.auth.getGateway()
      assert(gateway.token === 'token-1', 'token')
      assert(state.tokenRequests === before + 1, `token requests ${state.tokenRequests}`)
    })

    await check('natural mode injects prompt and writes reply', async () => {
      const agent = new FakeAgent()
      const naturalDir = await mkdtemp(join(tmpdir(), 'dsh-qq-natural-'))
      const natural = makeChannel(state, naturalDir, { mode: 'natural', cwd: '', agents: fakeAgents(agent) })
      try {
        natural.start()
        await waitFor(() => state.identifyCount >= 2 && state.ready)
        sendEvent(state, '请检查当前工作区', 'msg-3', 'user-1')
        const result = await waitFor(async () => {
          const value = await latestResult()
          return value && value.mode === 'natural' ? value : null
        })
        assert(result.mode === 'natural', 'mode')
        assert(result.status === 'ok', `status ${result.status}`)
        assert(result.stdout === 'reply:请检查当前工作区', `stdout ${JSON.stringify(result.stdout)}`)
        assert(result.sessionId === 'session-1', 'sessionId')
      } finally {
        natural.stop()
        await rm(naturalDir, { recursive: true, force: true })
      }
    })

    await check('natural mode pins workspace cwd with a dedicated session', async () => {
      const originalHome = process.env.DSH_HOME
      const home = await mkdtemp(join(tmpdir(), 'dsh-qq-ws-'))
      const work = await mkdtemp(join(tmpdir(), 'dsh-qq-work-'))
      process.env.DSH_HOME = home
      const agents = fakeWorkspaceAgents()
      const pinned = makeChannel(state, work, { mode: 'natural', cwd: work, agents })
      let restarted = null
      try {
        pinned.start()
        await waitFor(() => pinned.status().gateway.connectedAt > 0)
        await wait(150)
        sendEvent(state, '第一个任务', 'msg-w1', 'user-1')
        const first = await waitFor(async () => {
          const value = await latestResult()
          return value && value.mode === 'natural' && value.instruction === '第一个任务' ? value : null
        })
        assert(first.status === 'ok', `status ${first.status}`)
        assert(agents.created.length === 1, `created ${agents.created.length}`)
        assert(agents.created[0].cwd === work, `cwd ${agents.created[0].cwd}`)
        assert(first.sessionId === agents.created[0].sessionId, 'session id')
        sendEvent(state, '第二个任务', 'msg-w2', 'user-1')
        const second = await waitFor(async () => {
          const value = await latestResult()
          return value && value.mode === 'natural' && value.instruction === '第二个任务' ? value : null
        })
        assert(agents.created.length === 1, 'session not reused')
        assert(second.sessionId === first.sessionId, 'session changed')
        assert(pinned.status().workspaceActive === true, 'workspace inactive')
        pinned.stop()
        assert(agents.live.size === 0, 'dispose did not release')

        const again = fakeWorkspaceAgents()
        restarted = makeChannel(state, work, { mode: 'natural', cwd: work, agents: again })
        const beforeRestart = state.peers.size
        restarted.start()
        await waitFor(() => restarted.status().gateway.connectedAt > 0)
        await wait(150)
        sendEvent(state, '第三个任务', 'msg-w3', 'user-1')
        const third = await waitFor(async () => {
          const value = await latestResult()
          return value && value.mode === 'natural' && value.instruction === '第三个任务' ? value : null
        }).catch((error) => {
          throw new Error(`${error.message} status=${JSON.stringify(restarted.status())} peers=${state.peers.size}`)
        })
        assert(again.resumed.includes(first.sessionId), `resumed ${JSON.stringify(again.resumed)}`)
        assert(third.sessionId === first.sessionId, 'restart session changed')
      } finally {
        if (restarted) restarted.stop()
        pinned.stop()
        process.env.DSH_HOME = originalHome
        await rm(home, { recursive: true, force: true })
        await rm(work, { recursive: true, force: true })
      }
    })

    await check('stop closes websocket and clears state', async () => {
      channel.stop()
      await wait(200)
      assert(channel.status().state === 'stopped', `state ${channel.status().state}`)
      assert(channel.gateway === null, 'gateway retained')
      assert(channel.cleanupTimer === null, 'cleanup timer retained')
      assert(channel.queue.length === 0, 'queue retained')
      assert(state.peers.size === 0, `peers ${state.peers.size}`)
    })

    await check('reader dedupe, followup, restart, timer cleanup', async () => {
      const originalHome = process.env.DSH_HOME
      const home = await mkdtemp(join(tmpdir(), 'dsh-qq-reader-'))
      process.env.DSH_HOME = home
      const followups = []
      const agent = {
        id: 'session-reader',
        status: 'idle',
        followup(message) { followups.push(message) },
      }
      const agents = {
        list: () => [agent],
        roots: () => [agent],
        get: (id) => (id === agent.id ? agent : null),
      }
      const ctx = { get: (name) => (name === 'agents' ? agents : null) }
      const config = {
        targetSessionId: 'session-reader',
        autoFollowup: true,
        pollMs: 10000,
        retentionKeep: 100,
        retentionMinAgeMs: 300000,
        stdoutLimit: 65536,
        maxStdoutLimit: 262144,
      }
      const reader = new SyncResultReader({ ctx, config })
      try {
        await writeResult({
          id: 'qq-read-1', dedupeKey: 'qq:msg-1', source: 'qq', kind: 'task-result',
          createdAt: '2026-11-11T00:00:00.000Z', instruction: 'one', status: 'ok',
          exitCode: 0, stdout: 'one\n', stderr: '', durationMs: 1,
        })
        await writeResult({
          id: 'qq-read-2', dedupeKey: 'qq:msg-2', source: 'qq', kind: 'task-result',
          createdAt: '2026-11-11T00:00:01.000Z', instruction: 'two', status: 'ok',
          exitCode: 0, stdout: 'two\n', stderr: '', durationMs: 1,
        })
        await reader.start()
        assert(followups.length === 1, `followups ${followups.length}`)
        assert(followups[0].content[0].text.includes('qq-read-1'), 'oldest pointer')
        assert(reader.status().targetSessionId === 'session-reader', 'target')
        const first = await reader.read({})
        assert(first.found === true && first.result.id === 'qq-read-1', 'read first')
        assert(first.persisted === true, 'persist first')
        const second = await reader.read({})
        assert(second.found === true && second.result.id === 'qq-read-2', 'read second')
        const none = await reader.read({})
        assert(none.found === false, 'no unread')
        await writeResult({
          id: 'qq-read-dup', dedupeKey: 'qq:msg-1', source: 'qq', kind: 'task-result',
          createdAt: '2026-11-11T00:00:02.000Z', instruction: 'dup', status: 'ok',
          exitCode: 0, stdout: 'dup\n', stderr: '', durationMs: 1,
        })
        await reader.tick()
        assert(followups.length === 1, 'duplicate followup')
        const duplicate = await reader.read({})
        assert(duplicate.found === false, 'duplicate read')
        reader.stop()
        assert(reader.timer === null, 'timer retained')
        const beforeRestart = followups.length
        const restarted = new SyncResultReader({ ctx, config })
        await restarted.start()
        await restarted.tick()
        assert(followups.length === beforeRestart, 'restart re-injected')
        restarted.stop()
      } finally {
        reader.stop()
        process.env.DSH_HOME = originalHome
        await rm(home, { recursive: true, force: true })
      }
    })

    await check('closed followup target is not marked injected', async () => {
      const originalHome = process.env.DSH_HOME
      const home = await mkdtemp(join(tmpdir(), 'dsh-qq-closed-'))
      process.env.DSH_HOME = home
      const agent = {
        id: 'session-closed',
        status: 'idle',
        followup() { throw new Error('session closed') },
      }
      const agents = { list: () => [agent], roots: () => [agent], get: () => agent }
      const reader = new SyncResultReader({
        ctx: { get: (name) => (name === 'agents' ? agents : null) },
        config: {
          targetSessionId: 'session-closed', autoFollowup: true, pollMs: 100000,
          retentionKeep: 100, retentionMinAgeMs: 0, stdoutLimit: 65536, maxStdoutLimit: 262144,
        },
      })
      try {
        await writeResult(testResult('qq-closed', '2026-11-11T00:00:00.000Z'))
        await reader.start()
        assert(reader.state.injectedIds.length === 0, 'closed target marked injected')
        assert(reader.status().lastError !== '', 'error swallowed')
        reader.stop()
      } finally {
        reader.stop()
        process.env.DSH_HOME = originalHome
        await rm(home, { recursive: true, force: true })
      }
    })

    await check('pc cleanup keeps N, deletes oldest consumed, keeps unread and other files', async () => {
      const originalHome = process.env.DSH_HOME
      const home = await mkdtemp(join(tmpdir(), 'dsh-qq-clean-'))
      process.env.DSH_HOME = home
      try {
        for (let index = 0; index < 5; index += 1) {
          await writeResult(testResult(`qq-clean-${index}`, `2026-11-11T00:00:0${index}.000Z`))
        }
        await writeConsumed({
          version: 1,
          ids: ['qq-clean-1', 'qq-clean-2'],
          keys: ['qq:qq-clean-1', 'qq:qq-clean-2'],
          updatedAt: '2026-11-11T00:00:00.000Z',
        })
        await mkdir(resultDir(), { recursive: true })
        await writeFile(join(resultDir(), 'other.json'), JSON.stringify({
          id: 'other-1', source: 'other-plugin', kind: 'other',
        }), 'utf8')
        const first = await cleanupResults({ keep: 3, minAgeMs: 0 })
        assert(first.deleted === 2, `pc deleted ${first.deleted}`)
        assert(first.kept === 3, `pc kept ${first.kept}`)
        const left = (await readdir(resultDir())).filter((name) => name.endsWith('.json'))
        assert(!left.includes('qq-clean-1.json'), 'consumed oldest 1 not deleted')
        assert(!left.includes('qq-clean-2.json'), 'consumed oldest 2 not deleted')
        assert(left.includes('qq-clean-0.json'), 'unread deleted')
        assert(left.includes('other.json'), 'other plugin file deleted')
        const second = await cleanupResults({ keep: 3, minAgeMs: 0 })
        assert(second.deleted === 0, `pc idempotent ${second.deleted}`)
      } finally {
        process.env.DSH_HOME = originalHome
        await rm(home, { recursive: true, force: true })
      }
    })

    await check('reader paginates large stdout, keeps partial, cleans read files', async () => {
      const originalHome = process.env.DSH_HOME
      const home = await mkdtemp(join(tmpdir(), 'dsh-qq-page-'))
      process.env.DSH_HOME = home
      const config = {
        targetSessionId: 'session-page',
        autoFollowup: false,
        pollMs: 100000,
        retentionKeep: 2,
        retentionMinAgeMs: 0,
        stdoutLimit: 1024,
        maxStdoutLimit: 4096,
      }
      const reader = new SyncResultReader({ ctx: { get: () => null }, config })
      try {
        await writeResult(testResult('qq-page-u', '2026-11-11T00:00:00.000Z'))
        await writeResult(testResult('qq-page-big', '2026-11-11T00:00:01.000Z', {
          stdout: 'x'.repeat(3000),
        }))
        await writeResult(testResult('qq-page-default', '2026-11-11T00:00:02.000Z', {
          stdout: 'y'.repeat(70000),
        }))
        await mkdir(resultDir(), { recursive: true })
        await writeFile(join(resultDir(), 'other.json'), JSON.stringify({
          id: 'other-1', source: 'other-plugin', kind: 'other',
        }), 'utf8')
        await reader.start()
        const first = await reader.read({ id: 'qq-page-big', limit: 1024 })
        assert(first.result.truncated === true, 'first not truncated')
        assert(first.result.fullSize === 3000, `fullSize ${first.result.fullSize}`)
        assert(first.result.stdout.length === 1024, `chunk ${first.result.stdout.length}`)
        assert(first.result.nextOffset === 1024, `next ${first.result.nextOffset}`)
        assert(first.fullyConsumed === false, 'partial consumed')
        assert(await stat(join(resultDir(), 'qq-page-big.json')).then(() => true, () => false), 'partial file deleted')
        assert(!(await readConsumed()).ids.includes('qq-page-big'), 'partial marked consumed')
        const second = await reader.read({ id: 'qq-page-big', offset: 1024, limit: 1024 })
        assert(second.result.truncated === true, 'second not truncated')
        const third = await reader.read({ id: 'qq-page-big', offset: 2048, limit: 1024 })
        assert(third.result.truncated === false, 'final truncated')
        assert(third.result.fullSize === 3000, 'final fullSize')
        assert(third.fullyConsumed === true, 'final not consumed')
        assert((await readConsumed()).ids.includes('qq-page-big'), 'final consumed missing')
        reader.config.stdoutLimit = 65536
        reader.config.maxStdoutLimit = 262144
        const defaultPage = await reader.read({ id: 'qq-page-default' })
        assert(defaultPage.result.limit === 65536, `default limit ${defaultPage.result.limit}`)
        assert(defaultPage.result.truncated === true, 'default not truncated')
        assert(defaultPage.result.fullSize === 70000, `default fullSize ${defaultPage.result.fullSize}`)
        assert(defaultPage.result.nextOffset === 65536, `default next ${defaultPage.result.nextOffset}`)
        for (const suffix of ['a', 'b', 'c']) {
          await writeResult(testResult(`qq-page-${suffix}`, `2026-11-11T00:00:1${suffix}.000Z`))
          await reader.read({ id: `qq-page-${suffix}` })
        }
        const remaining = (await readdir(resultDir())).filter((name) => name.endsWith('.json'))
        assert(remaining.includes('qq-page-u.json'), 'unread deleted')
        assert(remaining.includes('other.json'), 'other plugin file deleted')
        assert(remaining.length <= 3, `retention ${remaining.join(',')}`)
        const missing = await reader.read({ id: 'qq-page-big' })
        assert(missing.found === false, 'deleted consumed result returned')
      } finally {
        reader.stop()
        process.env.DSH_HOME = originalHome
        await rm(home, { recursive: true, force: true })
      }
    })

    await check('reader recovers backup state and serializes two readers', async () => {
      const originalHome = process.env.DSH_HOME
      const home = await mkdtemp(join(tmpdir(), 'dsh-qq-state-'))
      process.env.DSH_HOME = home
      const config = {
        targetSessionId: 'session-state',
        autoFollowup: false,
        pollMs: 100000,
        retentionKeep: 100,
        retentionMinAgeMs: 0,
        stdoutLimit: 65536,
        maxStdoutLimit: 262144,
      }
      try {
        await writeResult(testResult('qq-state-a', '2026-11-11T00:00:00.000Z'))
        await writeResult(testResult('qq-state-b', '2026-11-11T00:00:01.000Z'))
        await writeResult(testResult('qq-state-c', '2026-11-11T00:00:02.000Z'))
        await mkdir(join(home, 'dsh-remote-worker'), { recursive: true })
        const valid = {
          version: 1,
          targetSessionId: 'session-state',
          readIds: ['qq-state-a'],
          readKeys: ['qq:qq-state-a'],
          injectedIds: ['qq-state-a'],
          injectedKeys: ['qq:qq-state-a'],
          partialIds: [],
          updatedAt: '2026-11-11T00:00:00.000Z',
        }
        await writeFile(readerStatePath(), JSON.stringify(valid), 'utf8')
        await copyFile(readerStatePath(), readerStateBackupPath())
        await writeFile(readerStatePath(), '{broken', 'utf8')
        const first = new SyncResultReader({ ctx: { get: () => null }, config })
        const second = new SyncResultReader({ ctx: { get: () => null }, config })
        await first.start()
        await second.start()
        const pair = await Promise.all([first.read({}), second.read({})])
        assert(pair.every((item) => item.found === true), 'parallel read failed')
        assert(new Set(pair.map((item) => item.result.id)).size === 2, 'parallel duplicate')
        assert(pair.every((item) => item.result.id !== 'qq-state-a'), 'backup state ignored')
        first.stop()
        second.stop()
        assert(!(await stat(readerLockPath()).then(() => true, () => false)), 'lock retained')
      } finally {
        process.env.DSH_HOME = originalHome
        await rm(home, { recursive: true, force: true })
      }
    })

    await check('queue backpressure writes rejected result; file dedupe survives restart', async () => {
      const queued = makeChannel(state, dir, { maxQueue: 1, mode: 'exec' })
      try {
        queued.stopped = false
        queued.queue = [{ id: 'placeholder' }]
        queued.handleDispatch('C2C_MESSAGE_CREATE', {
          id: 'msg-queue-full',
          content: '/exec echo queued',
          author: { user_openid: 'user-1' },
          timestamp: new Date().toISOString(),
        })
        const rejected = await waitFor(async () => {
          const files = await readdir(resultDir())
          for (const name of files) {
            if (!name.endsWith('.json')) continue
            try {
              const value = JSON.parse(await readFile(join(resultDir(), name), 'utf8'))
              if (value.messageId === 'msg-queue-full') return value
            } catch { /* 忽略 */ }
          }
          return null
        })
        assert(rejected.status === 'rejected', `queue status ${rejected.status}`)
        assert(rejected.error.code === 'QQ_QUEUE_FULL', 'queue error')
        assert(!(await queued.isAlreadyProcessed('qq:msg-queue-full')), 'rejected result blocks retry')
        await writeResult(testResult('qq-dedupe-done', '2026-11-11T00:00:09.000Z', {
          dedupeKey: 'qq:msg-done',
          messageId: 'msg-done',
        }))
        queued.seenKeys = null
        assert(await queued.isAlreadyProcessed('qq:msg-done'), 'file dedupe missed')
      } finally {
        queued.stop()
      }
    })

    await check('graceful stop waits for current task', async () => {
      const slow = makeChannel(state, dir, { mode: 'exec' })
      slow.stopped = false
      slow.running = true
      let resolve
      const done = new Promise((finish) => { resolve = finish })
      slow.currentDone = { promise: done, resolve }
      setTimeout(() => {
        slow.running = false
        resolve()
      }, 180)
      const started = Date.now()
      await slow.stopGracefully(1000)
      assert(Date.now() - started >= 150, 'stop did not wait')
      assert(slow.state === 'stopped', `state ${slow.state}`)
    })

    await check('result file stays under 45MB', async () => {
      const originalHome = process.env.DSH_HOME
      const home = await mkdtemp(join(tmpdir(), 'dsh-qq-large-'))
      process.env.DSH_HOME = home
      try {
        const size = 46 * 1024 * 1024
        const written = await writeResult(testResult('qq-large', '2026-11-11T00:00:00.000Z', {
          stdout: 'x'.repeat(size),
        }))
        const info = await stat(written.path)
        assert(info.size <= 45 * 1024 * 1024, `file size ${info.size}`)
        const saved = JSON.parse(await readFile(written.path, 'utf8'))
        assert(saved.stdoutTruncated === true, 'stdoutTruncated')
        assert(saved.stdoutBytes === size, `stdoutBytes ${saved.stdoutBytes}`)
        assert(Buffer.byteLength(saved.stdout, 'utf8') < size, 'stdout not truncated')
      } finally {
        process.env.DSH_HOME = originalHome
        await rm(home, { recursive: true, force: true })
      }
    })
    await check('workspace list filters archived and marks live', async () => {
      const originalHome = process.env.DSH_HOME
      const home = await mkdtemp(join(tmpdir(), 'dsh-qq-ws-'))
      process.env.DSH_HOME = home
      try {
        await mkdir(join(home, 'storages'), { recursive: true })
        const sessionRoot = join(home, 'sessions', sessionDirName('D:\\PC\\dsh'))
        await mkdir(join(sessionRoot, 's-live'), { recursive: true })
        await writeFile(join(sessionRoot, 's-live', 'session.v4.jsonl.zstd'),
          zstdCompressSync(Buffer.from(`${JSON.stringify({ cwd: 'D:\\PC\\dsh', origin: 'user', createdAt: 1 })}\n`, 'utf8')))
        await mkdir(join(sessionRoot, 's-sub'), { recursive: true })
        await writeFile(join(sessionRoot, 's-sub', 'session.v4.jsonl.zstd'),
          zstdCompressSync(Buffer.from(`${JSON.stringify({ cwd: 'D:\\PC\\dsh', origin: 'subagent', createdAt: 2 })}\n`, 'utf8')))
        await writeFile(join(home, 'storages', 'workspace.json'), JSON.stringify({
          unit: { name: 'workspace', version: 2 },
          global: { defaultWorkspaceId: 'w1', archivedSessionIds: ['s-old'] },
          tables: {
            workspaces: {
              w1: {
                path: 'D:\\PC\\dsh',
                title: '主工作区',
                sessionIds: ['s-live', 's-old', 's-sub'],
                updatedAt: '2026-11-15T10:00:00.000Z',
              },
              w2: {
                path: 'D:\\PC\\other',
                title: '',
                sessionIds: ['s-dead'],
                updatedAt: '2026-11-14T10:00:00.000Z',
              },
            },
          },
        }), 'utf8')
        const rows = await listWorkspaces({ liveIds: ['s-live'] })
        assert(rows.length === 2, `workspaces ${rows.length}`)
        const main = rows.find((row) => row.id === 'w1')
        assert(main.title === '主工作区', 'title')
        assert(main.isDefault === true, 'default flag')
        assert(main.sessions.length === 1 && main.sessions[0].id === 's-live', `sessions ${main.sessions.length}`)
        assert(main.sessions.every((item) => item.id !== 's-old'), 'archived filtered')
        assert(main.sessions.find((item) => item.id === 's-live').live === true, 'live flag')
        assert(main.sessions.every((item) => item.id !== 's-sub'), 'subagent filtered')
        assert(sessionDirName('D:\\PC\\dsh\\dsh-iq-guard') === '--D-PC-dsh-dsh-iq-guard--', 'dir encode')
        process.env.DSH_HOME = join(home, 'missing')
        const empty = await listWorkspaces({})
        assert(empty.length === 0, 'missing store')
      } finally {
        process.env.DSH_HOME = originalHome
        await rm(home, { recursive: true, force: true })
      }
    })

    await check('pinned session live, resume, and fallback', async () => {
      const agents = fakeWorkspaceAgents()
      await agents.create({ sessionId: 's-live', meta: { cwd: 'D:\\PC\\dsh' } })
      const liveChannel = makeChannel(state, dir, {
        mode: 'natural', cwd: '', sessionId: 's-live', agents,
      })
      const live = await liveChannel.resolveAgent(agents)
      assert(live && live.id === 's-live', 'pinned live')

      const offChannel = makeChannel(state, dir, {
        mode: 'natural', cwd: '', sessionId: 's-off', agents,
      })
      const resumed = await offChannel.resolveAgent(agents)
      assert(resumed && resumed.id === 's-off', 'resumed id')
      assert(agents.resumed.includes('s-off'), 'resume called')
      assert(offChannel.pinnedHandle !== null, 'pinned handle kept')
      offChannel.stopRuntime()
      assert(offChannel.pinnedHandle === null, 'pinned handle released')

      const brokenAgents = {
        ...agents,
        resume: async () => { throw new Error('resume failed') },
        list: () => [],
        get: () => null,
      }
      const fallbackChannel = makeChannel(state, dir, {
        mode: 'natural', cwd: 'D:\\PC\\dsh', sessionId: 's-gone', agents: brokenAgents,
      })
      const fallback = await fallbackChannel.resolveAgent(brokenAgents)
      assert(fallback !== null, 'fallback agent')
      assert(fallbackChannel.lastError.includes('resume failed'), `lastError ${fallbackChannel.lastError}`)
      fallbackChannel.stopRuntime()
    })

  } finally {
    try { channel.stop() } catch { /* 忽略 */ }
    state.server.close()
    for (const peer of state.peers) {
      try { peer.destroy() } catch { /* 忽略 */ }
    }
    await rm(dir, { recursive: true, force: true })
  }
  process.stdout.write(`\n${passed} passed, ${failed} failed\n`)
  if (failed > 0) process.exitCode = 1
}

main().catch((error) => {
  process.stderr.write(String(error && error.stack ? error.stack : error) + '\n')
  process.exit(1)
})
