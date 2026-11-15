import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { ERROR_CODES, remoteError, shortMessage, wireError } from './errors.js'
import { createExecutor } from './executor.js'
import { StreamFramer } from './framer.js'
import { primaryIPv6 } from './ipv6.js'
import { HEALTH_PATH, PROTOCOL_VERSION, WS_PATH, normalizeTask, parseMessage } from './protocol.js'
import { resolveCwd, commandAllowed } from './whitelist.js'
import { isUpgradeRequest, rejectUpgrade, writeUpgradeResponse, WsPeer } from './ws.js'

const IDLE_MS = 30000
const HELLO_MS = 5000
const SUBMIT_MS = 10000

export class WorkerServer {
  constructor({ config, shell, logger, version = '1.0.0', control = null }) {
    this.config = config
    this.logger = logger || null
    this.version = version
    this.control = control
    this.executor = createExecutor(shell)
    this.server = null
    this.connections = new Set()
    this.activeTasks = 0
    this.startedAt = 0
    this.actualPort = config.port
    this.closed = false
  }

  async start() {
    if (!this.executor.available) {
      throw remoteError(ERROR_CODES.ROLE, '无执行器')
    }
    const server = createServer((req, res) => this.handleHttp(req, res))
    server.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket, head))
    this.server = server
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        server.off('listening', onListening)
        const code = error && error.code
        if (code === 'EADDRINUSE') reject(remoteError(ERROR_CODES.PORT, '端口被占用', { details: { port: this.config.port } }))
        else if (code === 'EAFNOSUPPORT' || code === 'EADDRNOTAVAIL' || code === 'EPROTONOSUPPORT') {
          reject(remoteError(ERROR_CODES.ROLE, 'IPv6 不可用', { details: { cause: code } }))
        } else reject(remoteError(ERROR_CODES.PORT, '监听失败', { details: { cause: code || error.message } }))
      }
      const onListening = () => {
        server.off('error', onError)
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      try {
        server.listen({ host: '::', port: this.config.port, ipv6Only: false })
      } catch (error) {
        server.off('error', onError)
        reject(remoteError(ERROR_CODES.PORT, '监听失败', { details: { cause: error.code || error.message } }))
      }
    })
    const address = server.address()
    this.actualPort = address && typeof address === 'object' ? address.port : this.config.port
    this.startedAt = Date.now()
    this.log(`监听 ::${this.actualPort}`)
    return this
  }

  handleHttp(req, res) {
    let url
    try {
      url = new URL(req.url || '/', 'http://localhost')
    } catch {
      this.sendJson(res, 400, { ok: false, error: '请求非法' })
      return
    }
    if (req.method === 'GET' && url.pathname === HEALTH_PATH) {
      this.sendJson(res, 200, {
        ok: true,
        service: 'dsh-remote-worker',
        v: PROTOCOL_VERSION,
        busy: this.activeTasks,
        port: this.actualPort,
        uptimeMs: this.startedAt ? Date.now() - this.startedAt : 0,
      })
      return
    }
    if (url.pathname === WS_PATH) {
      this.sendJson(res, 426, { ok: false, error: 'upgrade required' })
      return
    }
    this.sendJson(res, 404, { ok: false, error: 'not found' })
  }

  sendJson(res, status, body) {
    const text = JSON.stringify(body)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(text),
    })
    res.end(text)
  }

  handleUpgrade(req, socket, head) {
    if (this.closed) {
      rejectUpgrade(socket, 503, 'Service Unavailable')
      return
    }
    let url
    try {
      url = new URL(req.url || '/', 'http://localhost')
    } catch {
      rejectUpgrade(socket, 400, 'Bad Request')
      return
    }
    if (url.pathname !== WS_PATH) {
      rejectUpgrade(socket, 404, 'Not Found')
      return
    }
    if (!isUpgradeRequest(req)) {
      rejectUpgrade(socket, 400, 'Bad Request')
      return
    }
    try {
      writeUpgradeResponse(socket, req.headers['sec-websocket-key'])
    } catch {
      socket.destroy()
      return
    }
    const peer = new WsPeer(socket, { role: 'server' })
    peer.phase = 'hello'
    peer.taskId = null
    peer.abort = null
    peer.helloTimer = setTimeout(() => {
      this.rejectPeer(peer, ERROR_CODES.TIMEOUT, '握手超时')
    }, HELLO_MS)
    if (typeof peer.helloTimer.unref === 'function') peer.helloTimer.unref()
    peer.submitTimer = null
    peer.onmessage = (text) => this.handleMessage(peer, text)
    peer.onclose = () => this.handlePeerClose(peer)
    peer.onerror = () => {}
    socket.setTimeout(IDLE_MS, () => {
      this.rejectPeer(peer, ERROR_CODES.TIMEOUT, '连接空闲')
    })
    this.connections.add(peer)
    if (head && head.length > 0) peer.feed(head)
  }

  handleMessage(peer, text) {
    const message = parseMessage(text)
    if (!message) {
      this.rejectPeer(peer, ERROR_CODES.REJECTED, '帧非法')
      return
    }
    if (peer.phase === 'hello') {
      this.handleHello(peer, message)
      return
    }
    if (peer.phase === 'task') {
      if (message.type === 'cfg.get' || message.type === 'cfg.set') {
        this.handleControl(peer, message).catch((error) => {
          this.rejectPeer(peer, error && error.code ? error.code : ERROR_CODES.EXEC, error && error.message ? error.message : '配置失败')
        })
        return
      }
      this.handleSubmit(peer, message).catch((error) => {
        this.rejectPeer(peer, error && error.code ? error.code : ERROR_CODES.EXEC, error && error.message ? error.message : '提交失败')
      })
      return
    }
    if (peer.phase === 'submitting') return
    if (peer.phase === 'running') {
      if (message.type === 'task.cancel' && (!message.taskId || message.taskId === peer.taskId)) {
        if (peer.abort) peer.abort()
      }
      return
    }
  }

  async handleControl(peer, message) {
    peer.phase = 'control'
    const control = this.control
    if (!control) {
      throw remoteError(ERROR_CODES.ROLE, '未启用配置通道')
    }
    let payload
    if (message.type === 'cfg.get') {
      payload = await control.get()
    } else {
      payload = await control.set(message.patch && typeof message.patch === 'object' ? message.patch : {})
    }
    peer.sendText(JSON.stringify({ type: 'cfg.result', ok: true, data: payload }))
    peer.phase = 'done'
    this.finishPeer(peer)
  }

  handleHello(peer, message) {
    if (message.type !== 'hello' || message.v !== PROTOCOL_VERSION) {
      this.rejectPeer(peer, ERROR_CODES.REJECTED, '协议不匹配')
      return
    }
    if (!safeEqual(message.token, this.config.token)) {
      this.rejectPeer(peer, ERROR_CODES.AUTH, 'token 错误')
      return
    }
    if (this.activeTasks >= this.config.maxConcurrent) {
      this.rejectPeer(peer, ERROR_CODES.REJECTED, '并发已满')
      return
    }
    clearTimeout(peer.helloTimer)
    peer.helloTimer = null
    peer.phase = 'task'
    peer.sessionId = `ws-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`
    const primary = primaryIPv6()
    peer.sendText(JSON.stringify({
      type: 'welcome',
      v: PROTOCOL_VERSION,
      sessionId: peer.sessionId,
      worker: {
        name: this.config.workerName,
        platform: process.platform,
        node: process.version,
        version: this.version,
        ipv6: primary ? primary.address : null,
      },
    }))
    peer.submitTimer = setTimeout(() => {
      this.rejectPeer(peer, ERROR_CODES.TIMEOUT, '提交超时')
    }, SUBMIT_MS)
    if (typeof peer.submitTimer.unref === 'function') peer.submitTimer.unref()
  }

  async handleSubmit(peer, message) {
    if (message.type !== 'task.submit') {
      this.rejectPeer(peer, ERROR_CODES.REJECTED, '缺任务')
      return
    }
    peer.phase = 'submitting'
    const normalized = normalizeTask(message, this.config)
    if (!normalized.task) {
      this.rejectPeer(peer, ERROR_CODES.REJECTED, normalized.error || '任务非法')
      return
    }
    const task = normalized.task
    if (!commandAllowed(this.config.allowCommands, task.command)) {
      this.rejectPeer(peer, ERROR_CODES.REJECTED, '命令未授权')
      return
    }
    let cwd
    try {
      cwd = await resolveCwd(task.cwd, this.config.allowCwd)
    } catch (error) {
      this.rejectPeer(peer, ERROR_CODES.REJECTED, error.message || '目录未授权')
      return
    }
    if (this.activeTasks >= this.config.maxConcurrent) {
      this.rejectPeer(peer, ERROR_CODES.REJECTED, '并发已满')
      return
    }
    if (this.closed || peer.finished) return
    clearTimeout(peer.submitTimer)
    peer.submitTimer = null
    peer.phase = 'running'
    peer.taskId = task.taskId
    peer.sendText(JSON.stringify({ type: 'task.ack', taskId: task.taskId }))
    this.activeTasks += 1
    this.runTask(peer, task, cwd).catch((error) => {
      this.log(`执行异常 ${error.code || 'ERR_EXEC'}`)
    }).finally(() => {
      this.activeTasks = Math.max(0, this.activeTasks - 1)
    })
  }

  async runTask(peer, task, cwd) {
    const controller = new AbortController()
    peer.abort = () => controller.abort()
    const stdout = new StreamFramer({
      stream: 'stdout',
      taskId: task.taskId,
      send: (message) => peer.sendText(JSON.stringify(message)),
    })
    const stderr = new StreamFramer({
      stream: 'stderr',
      taskId: task.taskId,
      send: (message) => peer.sendText(JSON.stringify(message)),
    })
    try {
      const result = await this.executor.run({
        command: task.command,
        cwd,
        timeoutMs: task.timeoutMs,
        signal: controller.signal,
        onStdout: (text) => stdout.push(text),
        onStderr: (text) => stderr.push(text),
      })
      stdout.end()
      stderr.end()
      if (peer.finished) return
      peer.sendText(JSON.stringify({
        type: 'task.exit',
        taskId: task.taskId,
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut,
        aborted: result.aborted,
        durationMs: result.durationMs,
        stdoutBytes: result.stdoutBytes,
        stderrBytes: result.stderrBytes,
      }))
      this.finishPeer(peer)
    } catch (error) {
      stdout.end()
      stderr.end()
      if (peer.finished) return
      const code = error && error.code ? error.code : ERROR_CODES.EXEC
      peer.sendText(JSON.stringify(wireError(code, error && error.message ? error.message : shortMessage(code))))
      this.finishPeer(peer)
    } finally {
      peer.abort = null
    }
  }

  rejectPeer(peer, code, message) {
    if (peer.finished) return
    try {
      peer.sendText(JSON.stringify(wireError(code, message)))
    } catch { /* 已断开 */ }
    this.finishPeer(peer, 1008)
  }

  finishPeer(peer, closeCode = 1000) {
    if (peer.phase === 'running' && peer.abort) peer.abort()
    peer.close(closeCode)
    const timer = setTimeout(() => peer.destroy(), 1500)
    if (typeof timer.unref === 'function') timer.unref()
  }

  handlePeerClose(peer) {
    if (peer.helloTimer) clearTimeout(peer.helloTimer)
    if (peer.submitTimer) clearTimeout(peer.submitTimer)
    if (peer.phase === 'running' && peer.abort) peer.abort()
    this.connections.delete(peer)
  }

  health() {
    return {
      ok: Boolean(this.server && this.server.listening),
      port: this.actualPort,
      busy: this.activeTasks,
      connections: this.connections.size,
      uptimeMs: this.startedAt ? Date.now() - this.startedAt : 0,
    }
  }

  async dispose() {
    if (this.closed) return
    this.closed = true
    for (const peer of this.connections) {
      try { peer.destroy() } catch { /* 已断开 */ }
    }
    this.connections.clear()
    const server = this.server
    this.server = null
    if (!server) return
    try { server.closeAllConnections?.() } catch { /* 旧版本 */ }
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 2000)
      if (typeof timer.unref === 'function') timer.unref()
      try {
        server.close(() => {
          clearTimeout(timer)
          resolve()
        })
      } catch {
        clearTimeout(timer)
        resolve()
      }
    })
    this.log('已停止')
  }

  log(message) {
    if (this.logger && typeof this.logger.info === 'function') this.logger.info(`[dsh-remote-worker] ${message}`)
  }
}

function safeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || left === '' || right === '') return false
  const a = createHash('sha256').update(left).digest()
  const b = createHash('sha256').update(right).digest()
  return timingSafeEqual(a, b)
}
