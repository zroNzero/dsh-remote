import { createHash, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { dshHome } from '../config.js'
import { createLocalRunner } from '../local-runner.js'
import { QqAuth } from './auth.js'
import { QqGateway } from './gateway.js'
import { qqError, shortError } from './errors.js'
import { C2C_MESSAGE_CREATE, parseC2CMessage, stripPrefix } from './protocol.js'
import { cleanupResults, resultDir, writeResult } from './result-sink.js'
import { consumedHas, readConsumed } from './consumed.js'

const DEDUP_MAX = 500
const DEDUP_TTL_MS = 10 * 60 * 1000
const STDERR_TAIL = 2048

export function workspaceSessionPath() {
  return join(dshHome(), 'dsh-remote-worker', 'qq-session.json')
}

export class QqChannel {
  constructor({ ctx, config, rootConfig, logger = null }) {
    this.ctx = ctx
    this.config = config
    this.rootConfig = typeof rootConfig === 'function' ? rootConfig : () => config
    this.logger = logger
    this.auth = null
    this.gateway = null
    this.state = 'stopped'
    this.stopped = true
    this.queue = []
    this.running = false
    this.currentAbort = null
    this.currentAgent = null
    this.currentDone = null
    this.workspaceAgent = null
    this.workspaceHandle = null
    this.pinnedHandle = null
    this.workspaceId = ''
    this.cleanupTimer = null
    this.cleaning = false
    this.seenKeys = null
    this.lastCleanupAt = 0
    this.lastDeleted = 0
    this.dedup = new Map()
    this.ignored = 0
    this.processed = 0
    this.lastError = ''
    this.lastEventAt = 0
    this.lastResultAt = 0
    this.lastResultPath = ''
    this.lastResultSink = ''
    this.lastMessage = ''
  }

  start() {
    this.stopped = false
    this.startCleanup()
    if (!this.config.enabled) {
      this.state = 'disabled'
      return
    }
    if (this.config.appId === '' || this.config.appSecret === '') {
      this.state = 'unconfigured'
      return
    }
    this.createGateway()
  }

  createGateway() {
    this.auth = new QqAuth({
      apiBase: this.config.apiBase,
      tokenUrl: this.config.tokenUrl,
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      logger: this.logger,
    })
    this.gateway = new QqGateway({
      config: this.config,
      auth: this.auth,
      logger: this.logger,
      onDispatch: (type, data, seq) => this.handleDispatch(type, data, seq),
    })
    this.gateway.start()
    this.state = this.gateway.state
  }

  setConfig(next) {
    const previous = this.config
    const intervalChanged = previous.cleanupIntervalMs !== next.cleanupIntervalMs
    const targetChanged = previous.cwd !== next.cwd || previous.sessionId !== next.sessionId
    this.config = next
    if (targetChanged) {
      this.releaseWorkspaceAgent()
      this.workspaceId = ''
    }
    if (!next.enabled) {
      this.stop()
      this.state = 'disabled'
      return
    }
    if (next.appId === '' || next.appSecret === '') {
      this.stop()
      this.state = 'unconfigured'
      return
    }
    const credentialsChanged = previous.appId !== next.appId
      || previous.appSecret !== next.appSecret
      || previous.apiBase !== next.apiBase
      || previous.tokenUrl !== next.tokenUrl
    if (!this.gateway || credentialsChanged) {
      this.stopRuntime()
      this.stopped = false
      this.createGateway()
      if (intervalChanged) this.startCleanup()
      return
    }
    this.gateway.setConfig(next)
    this.state = this.gateway.state
    if (intervalChanged) this.startCleanup()
  }

  stop() {
    this.stopped = true
    const pending = this.queue
    this.queue = []
    this.stopRuntime()
    this.clearCleanup()
    this.state = 'stopped'
    this.rejectQueued(pending).catch(() => {})
  }

  async stopGracefully(graceMs = 5000) {
    if (!this.running) {
      this.stop()
      return
    }
    this.stopped = true
    const pending = this.queue
    this.queue = []
    this.stopGateway()
    await this.rejectQueued(pending)
    const done = this.currentDone
    if (done) await race(done.promise, graceMs)
    if (this.running) {
      this.abortCurrent()
      if (done) await race(done.promise, 2000)
    }
    this.stopRuntime()
    this.clearCleanup()
    this.state = 'stopped'
  }

  async rejectQueued(pending) {
    for (const message of pending) {
      await this.recordRejected(message, qqError('QQ_STOPPED', '已停用'))
    }
  }

  stopRuntime() {
    this.abortCurrent()
    this.stopGateway()
    this.releaseWorkspaceAgent()
  }

  releaseWorkspaceAgent() {
    const handles = [this.pinnedHandle, this.workspaceHandle]
    this.pinnedHandle = null
    this.workspaceHandle = null
    this.workspaceAgent = null
    for (const handle of handles) {
      if (handle && typeof handle.dispose === 'function') {
        try { handle.dispose() } catch { /* 忽略 */ }
      }
    }
  }

  stopGateway() {
    if (this.gateway) {
      try { this.gateway.stop() } catch { /* 忽略 */ }
      this.gateway = null
    }
    this.auth = null
  }

  abortCurrent() {
    if (this.currentAbort) {
      try { this.currentAbort.abort() } catch { /* 忽略 */ }
      this.currentAbort = null
    }
    if (this.currentAgent) {
      try { this.currentAgent.cancel({ kind: 'hook', reason: 'qq stopped' }) } catch { /* 忽略 */ }
      this.currentAgent = null
    }
  }

  startCleanup() {
    this.clearCleanup()
    this.cleanup().catch(() => {})
    this.cleanupTimer = setInterval(() => {
      this.cleanup().catch(() => {})
    }, Math.max(60000, Number(this.config.cleanupIntervalMs) || 3600000))
    if (typeof this.cleanupTimer.unref === 'function') this.cleanupTimer.unref()
  }

  clearCleanup() {
    if (this.cleanupTimer !== null) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = null
    }
  }

  async cleanup() {
    if (this.cleaning) return
    this.cleaning = true
    try {
      const result = await cleanupResults({
        keep: this.config.retentionKeep,
        minAgeMs: this.config.retentionMinAgeMs,
      })
      this.lastCleanupAt = Date.now()
      this.lastDeleted = result.deleted
      if (result.deleted > 0) this.log('QQ 结果已清理')
    } catch (error) {
      this.lastError = shortError(error)
      this.log('QQ 清理失败')
    } finally {
      this.cleaning = false
    }
  }

  handleDispatch(type, data) {
    if (type !== C2C_MESSAGE_CREATE) return
    const message = parseC2CMessage(data)
    if (!message) return
    this.lastEventAt = Date.now()
    this.pruneDedup()
    if (this.dedup.has(message.id)) return
    this.dedup.set(message.id, Date.now())
    const allowAll = this.config.whitelist.length === 0
    if (!allowAll && !this.config.whitelist.includes(message.sender)) {
      this.ignored += 1
      this.log('QQ 忽略消息')
      return
    }
    if (this.queue.length >= this.config.maxQueue) {
      this.lastError = 'QQ 队列已满'
      this.log('QQ 队列已满')
      this.recordRejected(message, qqError('QQ_QUEUE_FULL', '队列已满')).catch(() => {})
      return
    }
    this.lastMessage = message.content.slice(0, 60)
    this.queue.push(message)
    this.pump()
  }

  pump() {
    if (this.running || this.stopped) return
    const message = this.queue.shift()
    if (!message) return
    this.running = true
    const done = deferred()
    this.currentDone = done
    this.runMessage(message)
      .catch((error) => {
        this.lastError = shortError(error)
        this.log('QQ 执行失败')
      })
      .finally(() => {
        this.running = false
        if (this.currentDone === done) this.currentDone = null
        done.resolve()
        this.pump()
      })
  }

  baseResult(message, id = `qq-${randomUUID()}`) {
    return {
      id,
      dedupeKey: message.id ? `qq:${message.id}` : `qq:${id}`,
      source: 'qq',
      kind: 'task-result',
      createdAt: new Date().toISOString(),
      instruction: message.content,
      messageId: message.id,
      sender: maskSender(message.sender),
      senderHash: hashSender(message.sender),
      mode: this.config.mode,
    }
  }

  async recordRejected(message, error) {
    const base = this.baseResult(message)
    const result = {
      ...base,
      status: 'rejected',
      exitCode: null,
      stdout: '',
      stderr: '',
      durationMs: 0,
      error: { code: error.code || 'QQ_REJECTED', message: error.message || '任务拒绝' },
    }
    try {
      await this.writeResultWithRetry(result)
      this.lastError = result.error.message
      this.log('QQ 队列已满')
    } catch (writeError) {
      this.lastError = shortError(writeError)
      this.log('QQ 结果写入失败')
    }
  }

  async writeResultWithRetry(result) {
    let last = null
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const written = await writeResult(result)
        this.lastResultAt = Date.now()
        this.lastResultPath = written.path
        this.lastResultSink = 'storages'
        this.processed += 1
        if (this.seenKeys && result.dedupeKey && result.status !== 'rejected') this.seenKeys.add(result.dedupeKey)
        this.cleanup().catch(() => {})
        return written
      } catch (error) {
        last = error
        if (attempt === 0) await delay(200)
      }
    }
    throw last
  }

  async isAlreadyProcessed(dedupeKey) {
    if (dedupeKey === '') return false
    try {
      const consumed = await readConsumed()
      if (consumedHas(consumed, '', dedupeKey)) return true
      if (this.seenKeys === null) await this.loadSeenKeys()
      return this.seenKeys.has(dedupeKey)
    } catch {
      return false
    }
  }

  async loadSeenKeys() {
    const keys = new Set()
    try {
      const entries = await readdir(resultDir(), { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.json') || entry.name.startsWith('.')) continue
        try {
          const result = JSON.parse(await readFile(join(resultDir(), entry.name), 'utf8'))
          if (result && result.dedupeKey && result.status !== 'rejected') keys.add(result.dedupeKey)
        } catch {
          continue
        }
      }
    } catch {
      /* 结果目录不存在 */
    }
    this.seenKeys = keys
  }

  async runMessage(message) {
    const started = Date.now()
    const base = this.baseResult(message)
    if (await this.isAlreadyProcessed(base.dedupeKey)) {
      this.ignored += 1
      this.log('QQ 重复消息')
      return
    }
    if (message.content.trim() === '') {
      await this.recordRejected(message, qqError('QQ_EMPTY', '空指令'))
      this.ignored += 1
      return
    }
    let payload
    try {
      if (this.config.mode === 'exec') {
        const command = stripPrefix(message.content, this.config.prefix)
        if (command === '') {
          await this.recordRejected(message, qqError('QQ_EMPTY', '空指令'))
          this.ignored += 1
          return
        }
        base.command = command
        payload = await this.runExec(command)
      } else {
        base.prompt = message.content
        payload = await this.runNatural(message.content)
      }
    } catch (error) {
      payload = errorPayload(error)
    }
    const result = {
      ...base,
      ...payload,
      stderr: tail(payload.stderr || '', STDERR_TAIL),
      durationMs: Number.isFinite(payload.durationMs) ? payload.durationMs : Date.now() - started,
    }
    try {
      await this.writeResultWithRetry(result)
      this.lastError = ''
      this.log('QQ 结果已写入')
    } catch (error) {
      this.lastError = shortError(error)
      this.log('QQ 结果写入失败')
    }
  }

  async runExec(command) {
    const shell = serviceOf(this.ctx, 'shell')
    if (!shell) throw qqError('QQ_NO_SHELL', '无执行器')
    const runner = createLocalRunner({ shell, config: this.rootConfig() })
    const abort = new AbortController()
    this.currentAbort = abort
    try {
      const result = await runner.run({
        command,
        cwd: this.config.cwd || homedir(),
        timeoutMs: this.config.timeoutMs,
        signal: abort.signal,
      })
      const status = result.timedOut
        ? 'timeout'
        : (result.aborted ? 'cancelled' : (result.exitCode === 0 ? 'ok' : 'error'))
      const payload = {
        status,
        exitCode: typeof result.exitCode === 'number' ? result.exitCode : null,
        signal: result.signal || null,
        stdout: result.stdout || '',
        stderr: result.stderr || '',
        cwd: result.cwd || '',
        durationMs: result.durationMs,
      }
      if (status === 'error') payload.error = { code: 'ERR_EXEC', message: '命令非零退出' }
      if (status === 'timeout') payload.error = { code: 'QQ_TIMEOUT', message: '执行超时' }
      if (status === 'cancelled') payload.error = { code: 'QQ_CANCELLED', message: '执行取消' }
      return payload
    } catch (error) {
      const code = error && error.code ? error.code : 'QQ_EXEC'
      const status = code === 'ERR_REJECTED' ? 'rejected' : (code === 'QQ_TIMEOUT' ? 'timeout' : 'error')
      return {
        status,
        exitCode: null,
        stdout: '',
        stderr: '',
        durationMs: 0,
        error: { code, message: error && error.message ? error.message : '执行失败' },
      }
    } finally {
      if (this.currentAbort === abort) this.currentAbort = null
    }
  }

  async runNatural(prompt) {
    const agents = serviceOf(this.ctx, 'agents')
    if (!agents || typeof agents.list !== 'function') throw qqError('QQ_NO_AGENT', '无可用会话')
    const agent = await this.resolveAgent(agents)
    if (!agent) throw qqError('QQ_NO_AGENT', '无可用会话')
    const started = Date.now()
    const before = agent.session.deriveMessages().length
    const message = {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: prompt }],
      source: { kind: 'user' },
    }
    this.currentAgent = agent
    try {
      agent.followup(message)
      await new Promise((resolve) => setImmediate(resolve))
      let timedOut = false
      try {
        await withTimeout(agent.whenIdle(), this.config.timeoutMs)
      } catch (error) {
        if (error && error.code === 'QQ_TIMEOUT') {
          timedOut = true
          try { agent.cancel({ kind: 'hook', reason: 'qq timeout' }) } catch { /* 忽略 */ }
          await agent.whenIdle().catch(() => {})
        } else {
          throw error
        }
      }
      if (timedOut) {
        return {
          status: 'timeout',
          exitCode: null,
          stdout: '',
          stderr: '',
          sessionId: agent.id,
          durationMs: Date.now() - started,
          error: { code: 'QQ_TIMEOUT', message: '执行超时' },
        }
      }
      const messages = agent.session.deriveMessages()
      const replies = messages.slice(before).filter((item) => item.role === 'assistant')
      const reply = [...replies].reverse().find((item) => textOf(item) !== '')
      if (!reply) throw qqError('QQ_NO_REPLY', '会话无回复')
      return {
        status: 'ok',
        exitCode: 0,
        stdout: textOf(reply),
        stderr: '',
        sessionId: agent.id,
        durationMs: Date.now() - started,
      }
    } finally {
      if (this.currentAgent === agent) this.currentAgent = null
    }
  }

  async resolveAgent(agents) {
    if (this.config.sessionId !== '') {
      const pinned = this.findAgent(agents, this.config.sessionId)
      if (pinned) return pinned
      const resumed = await this.resumePinned(agents, this.config.sessionId)
      if (resumed) return resumed
      this.log('指定的会话不可用，回退')
    }
    if (this.config.cwd !== '') return this.acquireWorkspaceAgent(agents)
    return this.pickAgent(agents)
  }

  async resumePinned(agents, sessionId) {
    if (typeof agents.resume !== 'function') return null
    try {
      const handle = await agents.resume({ resumeSessionId: sessionId })
      const agent = handle && handle.agent ? handle.agent : handle
      if (agent && typeof agent.id === 'string') {
        if (this.pinnedHandle && this.pinnedHandle !== handle
          && typeof this.pinnedHandle.dispose === 'function') {
          try { this.pinnedHandle.dispose() } catch { /* 忽略 */ }
        }
        this.pinnedHandle = handle && typeof handle.dispose === 'function' ? handle : null
        return agent
      }
      return null
    } catch (error) {
      this.lastError = shortError(error)
      return null
    }
  }

  findAgent(agents, sessionId) {
    let exact = null
    try {
      exact = typeof agents.get === 'function' ? agents.get(sessionId) : null
    } catch {
      exact = null
    }
    if (exact) return exact
    const list = agents.list()
    if (!Array.isArray(list)) return null
    return list.find((agent) => agent.id === sessionId) || null
  }

  pickAgent(agents) {
    const list = agents.list()
    if (!Array.isArray(list) || list.length === 0) return null
    const idle = list.find((agent) => agent.status === 'idle')
    return idle || list[0]
  }

  async acquireWorkspaceAgent(agents) {
    if (this.workspaceAgent) return this.workspaceAgent
    const stored = this.workspaceId || (await this.loadWorkspaceSession())
    if (stored) {
      const live = this.findAgent(agents, stored)
      if (live) {
        this.workspaceAgent = live
        this.workspaceId = stored
        return live
      }
      if (typeof agents.resume === 'function') {
        try {
          const handle = await agents.resume({ resumeSessionId: stored })
          const agent = handle && handle.agent ? handle.agent : handle
          if (agent && agent.id) {
            this.workspaceAgent = agent
            this.workspaceHandle = handle && typeof handle.dispose === 'function' ? handle : null
            this.workspaceId = agent.id
            return agent
          }
        } catch {
          /* 恢复失败则新建 */
        }
      }
    }
    if (typeof agents.create !== 'function') {
      const fallback = this.pickAgent(agents)
      if (fallback) return fallback
      throw qqError('QQ_NO_AGENT', '无法创建工作区会话')
    }
    const sessionId = `session-${randomUUID()}`
    let handle
    try {
      handle = await agents.create({ sessionId, meta: { cwd: this.config.cwd } })
    } catch (error) {
      const fallback = this.pickAgent(agents)
      if (fallback) {
        this.lastError = shortError(error)
        this.log('工作区会话创建失败，改用空闲会话')
        return fallback
      }
      throw qqError('QQ_NO_AGENT', '无法创建工作区会话')
    }
    const agent = handle && handle.agent ? handle.agent : handle
    if (!agent || !agent.id) throw qqError('QQ_NO_AGENT', '无法创建工作区会话')
    this.workspaceAgent = agent
    this.workspaceHandle = handle && typeof handle.dispose === 'function' ? handle : null
    this.workspaceId = agent.id
    await this.saveWorkspaceSession(agent.id)
    return agent
  }

  async loadWorkspaceSession() {
    try {
      const raw = JSON.parse(await readFile(workspaceSessionPath(), 'utf8'))
      return raw && typeof raw.sessionId === 'string' ? raw.sessionId : ''
    } catch {
      return ''
    }
  }

  async saveWorkspaceSession(sessionId) {
    const file = workspaceSessionPath()
    const dir = join(file, '..')
    try {
      await mkdir(dir, { recursive: true })
      const temp = `${file}.${process.pid}.partial`
      await writeFile(temp, `${JSON.stringify({ sessionId, cwd: this.config.cwd, updatedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8')
      await rename(temp, file)
    } catch {
      /* 落盘失败不影响执行 */
    }
  }

  status() {
    const gateway = this.gateway ? this.gateway.status() : null
    return {
      state: gateway ? gateway.state : this.state,
      enabled: this.config.enabled,
      configured: this.config.appId !== '' && this.config.appSecret !== '',
      mode: this.config.mode,
      whitelistCount: this.config.whitelist.length,
      allowAll: this.config.whitelist.length === 0,
      queue: this.queue.length,
      running: this.running,
      ignored: this.ignored,
      processed: this.processed,
      lastError: this.lastError || (gateway && gateway.lastError) || '',
      lastEventAt: this.lastEventAt,
      lastResultAt: this.lastResultAt,
      lastResultPath: this.lastResultPath,
      lastResultSink: this.lastResultSink,
      lastCleanupAt: this.lastCleanupAt,
      lastDeleted: this.lastDeleted,
      lastMessage: this.lastMessage,
      workspaceCwd: this.config.cwd,
      workspaceSessionId: this.workspaceId,
      workspaceActive: Boolean(this.workspaceAgent),
      gateway,
    }
  }

  pruneDedup() {
    const now = Date.now()
    for (const [id, at] of this.dedup) {
      if (now - at > DEDUP_TTL_MS) this.dedup.delete(id)
    }
    while (this.dedup.size > DEDUP_MAX) {
      const first = this.dedup.keys().next().value
      if (first === undefined) break
      this.dedup.delete(first)
    }
  }

  log(message) {
    if (!this.logger) return
    try { this.logger.info(`[dsh-remote-worker] ${message}`) } catch { /* 忽略 */ }
  }
}

function errorPayload(error) {
  const code = error && typeof error.code === 'string' ? error.code : 'QQ_FAILED'
  const status = code === 'ERR_REJECTED'
    ? 'rejected'
    : (code === 'QQ_TIMEOUT' ? 'timeout' : 'error')
  return {
    status,
    exitCode: null,
    stdout: '',
    stderr: '',
    durationMs: 0,
    error: {
      code,
      message: error && typeof error.message === 'string' ? error.message : '执行失败',
    },
  }
}

function withTimeout(promise, timeoutMs) {
  let timer = null
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(qqError('QQ_TIMEOUT', '执行超时')), Math.max(1000, timeoutMs))
    if (typeof timer.unref === 'function') timer.unref()
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== null) clearTimeout(timer)
  })
}

function textOf(message) {
  if (!message || !Array.isArray(message.content)) return ''
  return message.content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

function tail(text, maxBytes) {
  if (typeof text !== 'string' || text.length === 0) return ''
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.length <= maxBytes) return text
  return buffer.subarray(buffer.length - maxBytes).toString('utf8')
}

function maskSender(value) {
  if (typeof value !== 'string' || value === '') return ''
  if (value.length <= 8) return '***'
  return `${value.slice(0, 4)}***${value.slice(-4)}`
}

function hashSender(value) {
  if (typeof value !== 'string' || value === '') return ''
  return createHash('sha256').update(value).digest('hex')
}

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

function race(promise, timeoutMs) {
  let timer = null
  const wait = new Promise((resolve) => {
    timer = setTimeout(resolve, Math.max(0, timeoutMs))
    if (typeof timer.unref === 'function') timer.unref()
  })
  return Promise.race([promise, wait]).finally(() => {
    if (timer !== null) clearTimeout(timer)
  })
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function serviceOf(ctx, name) {
  if (!ctx) return null
  try {
    if (typeof ctx.get === 'function') return ctx.get(name) || null
    return ctx[name] || null
  } catch {
    return null
  }
}
