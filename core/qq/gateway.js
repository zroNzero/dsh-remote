import { connectWebSocket } from '../ws.js'
import {
  C2C_MESSAGE_CREATE,
  OP,
  READY,
  RESUMED,
  heartbeatPayload,
  identifyPayload,
  parseGatewayFrame,
  resumePayload,
} from './protocol.js'

const BACKOFF_MS = [1000, 2000, 5000, 10000, 30000]
const HELLO_TIMEOUT_MS = 15000
const FATAL_CLOSE = new Set([4914, 4915])

export class QqGateway {
  constructor({ config, auth, logger = null, onState = null, onDispatch = null, connect = connectWebSocket }) {
    this.config = config
    this.auth = auth
    this.logger = logger
    this.onState = onState
    this.onDispatch = onDispatch
    this.connect = connect
    this.state = 'stopped'
    this.stopped = true
    this.connecting = false
    this.peer = null
    this.sessionId = ''
    this.seq = null
    this.heartbeatMs = 30000
    this.heartbeatTimer = null
    this.handshakeTimer = null
    this.reconnectTimer = null
    this.awaitingAck = false
    this.attempt = 0
    this.lastError = ''
    this.lastEventAt = 0
    this.connectedAt = 0
    this.epoch = 0
    this.resumeFailed = false
  }

  start() {
    if (!this.config.enabled) {
      this.setState('disabled')
      return
    }
    if (this.auth.configured() !== true) {
      this.setState('unconfigured')
      return
    }
    if (!this.stopped) return
    this.stopped = false
    this.attempt = 0
    this.sessionId = ''
    this.seq = null
    this.resumeFailed = false
    this.lastError = ''
    this.connectLoop()
  }

  stop() {
    this.stopped = true
    this.epoch += 1
    this.clearTimers()
    const peer = this.peer
    this.peer = null
    if (peer) {
      try { peer.close(1000) } catch { /* 忽略 */ }
      const timer = setTimeout(() => {
        try { peer.destroy() } catch { /* 忽略 */ }
      }, 100)
      if (typeof timer.unref === 'function') timer.unref()
    }
    this.sessionId = ''
    this.seq = null
    this.connecting = false
    this.setState('stopped')
  }

  setConfig(next) {
    const previous = this.config
    this.config = next
    if (!next.enabled) {
      this.stop()
      return
    }
    if (this.stopped) {
      this.start()
      return
    }
    if (previous.apiBase !== next.apiBase || previous.tokenUrl !== next.tokenUrl) {
      this.stop()
      this.start()
      return
    }
    this.emitState()
  }

  status() {
    return {
      state: this.state,
      configured: this.auth.configured(),
      sessionActive: this.sessionId !== '',
      resumable: this.config.resume === true && this.sessionId !== '' && this.seq !== null,
      seq: Number.isInteger(this.seq) ? this.seq : null,
      heartbeatMs: this.heartbeatMs,
      attempt: this.attempt,
      lastError: this.lastError,
      lastEventAt: this.lastEventAt,
      connectedAt: this.connectedAt,
    }
  }

  async connectLoop() {
    if (this.stopped || this.connecting) return
    this.connecting = true
    this.clearReconnect()
    this.setState('connecting')
    const epoch = ++this.epoch
    try {
      const gateway = await this.auth.getGateway()
      if (this.stopped || epoch !== this.epoch) return
      let parsed
      try {
        parsed = new URL(gateway.url)
      } catch {
        throw new Error('QQ 网关地址非法')
      }
      const secure = parsed.protocol === 'wss:'
      if (!secure && parsed.protocol !== 'ws:') throw new Error('QQ 网关协议非法')
      const peer = await this.connect({
        host: parsed.hostname,
        port: parsed.port ? Number(parsed.port) : (secure ? 443 : 80),
        path: `${parsed.pathname}${parsed.search}`,
        secure,
        servername: secure ? parsed.hostname : undefined,
        timeoutMs: 10000,
      })
      if (this.stopped || epoch !== this.epoch) {
        peer.destroy()
        return
      }
      this.peer = peer
      this.connectedAt = Date.now()
      this.awaitingAck = false
      peer.onmessage = (text) => this.handleFrame(epoch, text)
      peer.onclose = (info) => this.handleClose(epoch, info)
      peer.onerror = (error) => {
        this.lastError = `QQ 连接错误 ${error && error.code ? error.code : ''}`.trim()
      }
      this.setState('hello')
      this.startHandshakeTimer(epoch)
    } catch (error) {
      if (this.stopped) return
      this.lastError = short(error)
      this.log('QQ 连接失败')
      this.scheduleReconnect()
    } finally {
      if (this.epoch === epoch) this.connecting = false
    }
  }

  handleFrame(epoch, text) {
    if (this.stopped || epoch !== this.epoch) return
    const frame = parseGatewayFrame(text)
    if (!frame) return
    if (frame.op === OP.HELLO) {
      this.handleHello(epoch, frame)
      return
    }
    if (frame.op === OP.HEARTBEAT_ACK) {
      this.awaitingAck = false
      return
    }
    if (frame.op === OP.RECONNECT) {
      this.dropPeer()
      this.scheduleReconnect()
      return
    }
    if (frame.op === OP.INVALID_SESSION) {
      this.sessionId = ''
      this.seq = null
      this.resumeFailed = true
      this.lastError = '会话失效'
      this.dropPeer()
      this.scheduleReconnect()
      return
    }
    if (frame.op === OP.DISPATCH) {
      this.handleDispatch(epoch, frame)
    }
  }

  handleHello(epoch, frame) {
    if (this.stopped || epoch !== this.epoch) return
    const interval = Number(frame.d && frame.d.heartbeat_interval)
    if (Number.isFinite(interval) && interval > 0) this.heartbeatMs = Math.max(1000, interval)
    this.clearHandshakeTimer()
    this.sendIdentifyOrResume(epoch)
  }

  sendIdentifyOrResume(epoch) {
    const resumable = this.config.resume === true
      && this.sessionId !== ''
      && this.seq !== null
      && !this.resumeFailed
    if (resumable) this.sendResume(epoch)
    else this.sendIdentify(epoch)
  }

  async sendIdentify(epoch) {
    try {
      const token = await this.auth.getToken()
      if (this.stopped || epoch !== this.epoch) return
      this.setState('identifying')
      this.send(identifyPayload(token, this.config.intents, this.config.shard))
      this.startHandshakeTimer(epoch)
    } catch (error) {
      this.lastError = short(error)
      this.dropPeer()
      this.scheduleReconnect()
    }
  }

  async sendResume(epoch) {
    try {
      const token = await this.auth.getToken()
      if (this.stopped || epoch !== this.epoch) return
      this.setState('resuming')
      this.send(resumePayload(token, this.sessionId, this.seq))
      this.startHandshakeTimer(epoch)
    } catch (error) {
      this.lastError = short(error)
      this.resumeFailed = true
      this.dropPeer()
      this.scheduleReconnect()
    }
  }

  handleDispatch(epoch, frame) {
    if (this.stopped || epoch !== this.epoch) return
    if (Number.isInteger(frame.s)) this.seq = frame.s
    this.lastEventAt = Date.now()
    const type = typeof frame.t === 'string' ? frame.t : ''
    if (type === READY || type === RESUMED) {
      const sessionId = frame.d && typeof frame.d.session_id === 'string' ? frame.d.session_id : ''
      if (sessionId !== '') this.sessionId = sessionId
      this.attempt = 0
      this.resumeFailed = false
      this.lastError = ''
      this.clearHandshakeTimer()
      this.setState('ready')
      this.startHeartbeat()
      this.log(type === READY ? 'QQ 已就绪' : 'QQ 已恢复')
      return
    }
    if (type === C2C_MESSAGE_CREATE && this.onDispatch) {
      try {
        this.onDispatch(type, frame.d, frame.s)
      } catch (error) {
        this.lastError = short(error)
      }
    }
  }

  startHeartbeat() {
    this.stopHeartbeat()
    this.awaitingAck = false
    const interval = Math.max(1000, this.heartbeatMs)
    this.heartbeatTimer = setInterval(() => {
      if (this.stopped) return
      if (this.awaitingAck) {
        this.lastError = '心跳超时'
        this.dropPeer()
        this.scheduleReconnect()
        return
      }
      this.awaitingAck = true
      this.send(heartbeatPayload(this.seq))
    }, interval)
    if (typeof this.heartbeatTimer.unref === 'function') this.heartbeatTimer.unref()
  }

  stopHeartbeat() {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    this.awaitingAck = false
  }

  startHandshakeTimer(epoch) {
    this.clearHandshakeTimer()
    this.handshakeTimer = setTimeout(() => {
      this.handshakeTimer = null
      if (this.stopped || epoch !== this.epoch) return
      if (this.state === 'ready') return
      if (this.state === 'resuming') this.resumeFailed = true
      this.lastError = 'QQ 握手超时'
      this.dropPeer()
      this.scheduleReconnect()
    }, HELLO_TIMEOUT_MS)
    if (typeof this.handshakeTimer.unref === 'function') this.handshakeTimer.unref()
  }

  clearHandshakeTimer() {
    if (this.handshakeTimer !== null) {
      clearTimeout(this.handshakeTimer)
      this.handshakeTimer = null
    }
  }

  handleClose(epoch, info) {
    if (this.stopped || epoch !== this.epoch) return
    this.stopHeartbeat()
    this.clearHandshakeTimer()
    this.peer = null
    const code = info && Number.isInteger(info.code) ? info.code : 0
    if (FATAL_CLOSE.has(code)) {
      this.state = 'error'
      this.lastError = code === 4914 ? 'QQ 机器人离线' : 'QQ 机器人受限'
      this.emitState()
      this.log(this.lastError)
      return
    }
    if (code === 4004) {
      this.auth.clear()
      this.sessionId = ''
      this.seq = null
      this.resumeFailed = true
      this.lastError = 'QQ 鉴权失败'
    } else if (code === 4006 || code === 4007 || code === 4009) {
      this.sessionId = ''
      this.seq = null
      this.resumeFailed = true
      this.lastError = 'QQ 会话失效'
    } else if (this.state === 'resuming') {
      this.resumeFailed = true
      this.lastError = 'QQ 恢复失败'
    }
    this.scheduleReconnect()
  }

  dropPeer() {
    this.stopHeartbeat()
    this.clearHandshakeTimer()
    const peer = this.peer
    this.peer = null
    if (peer) {
      try { peer.close(1000) } catch { /* 忽略 */ }
      const timer = setTimeout(() => {
        try { peer.destroy() } catch { /* 忽略 */ }
      }, 100)
      if (typeof timer.unref === 'function') timer.unref()
    }
  }

  scheduleReconnect() {
    if (this.stopped || this.reconnectTimer !== null) return
    this.attempt += 1
    const delay = BACKOFF_MS[Math.min(this.attempt - 1, BACKOFF_MS.length - 1)]
    this.state = 'reconnecting'
    this.emitState()
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connectLoop()
    }, delay)
    if (typeof this.reconnectTimer.unref === 'function') this.reconnectTimer.unref()
  }

  clearReconnect() {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  clearTimers() {
    this.stopHeartbeat()
    this.clearHandshakeTimer()
    this.clearReconnect()
  }

  send(payload) {
    if (!this.peer || this.peer.finished) return false
    try {
      this.peer.sendText(JSON.stringify(payload))
      return true
    } catch (error) {
      this.lastError = short(error)
      return false
    }
  }

  setState(state) {
    this.state = state
    this.emitState()
  }

  emitState() {
    if (!this.onState) return
    try { this.onState(this.status()) } catch { /* 忽略 */ }
  }

  log(message) {
    if (!this.logger) return
    try { this.logger.info(`[dsh-remote-worker] ${message}`) } catch { /* 忽略 */ }
  }
}

function short(error) {
  if (!error) return 'QQ 通道失败'
  const message = typeof error.message === 'string' ? error.message : String(error)
  return message.slice(0, 80)
}
