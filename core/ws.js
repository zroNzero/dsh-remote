import { createHash, randomBytes } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { stripBrackets } from './ipv6.js'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const MAX_FRAME = 2 * 1024 * 1024

export function acceptKey(key) {
  return createHash('sha1').update(String(key) + GUID).digest('base64')
}

export function isUpgradeRequest(req) {
  const connection = String(req.headers.connection || '').toLowerCase()
  return req.headers.upgrade === 'websocket'
    && connection.split(',').map((item) => item.trim()).includes('upgrade')
    && typeof req.headers['sec-websocket-key'] === 'string'
    && req.headers['sec-websocket-version'] === '13'
}

export function writeUpgradeResponse(socket, key) {
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptKey(key)}`,
    '',
    '',
  ].join('\r\n'))
}

export function rejectUpgrade(socket, status = 400, text = 'Bad Request') {
  const body = Buffer.from(text)
  socket.write([
    `HTTP/1.1 ${status} ${text}`,
    'Connection: close',
    'Content-Type: text/plain; charset=utf-8',
    `Content-Length: ${body.length}`,
    '',
    '',
  ].join('\r\n'))
  socket.end(body)
}

export class WsPeer {
  constructor(socket, { role }) {
    this.socket = socket
    this.role = role
    this.buffer = Buffer.alloc(0)
    this.finished = false
    this.closeSent = false
    this.closeReceived = false
    this.closeTimer = null
    this.onmessage = null
    this.onclose = null
    this.onerror = null
    socket.setNoDelay(true)
    socket.on('data', (chunk) => this.feed(chunk))
    socket.on('close', () => this.finish(1006, 'socket closed'))
    socket.on('error', (error) => {
      if (this.onerror) this.onerror(error)
    })
  }

  feed(chunk) {
    if (this.finished || !chunk || chunk.length === 0) return
    this.buffer = this.buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buffer, chunk])
    try {
      for (;;) {
        const frame = this.readFrame()
        if (!frame) break
        this.handleFrame(frame)
        if (this.finished) break
      }
    } catch (error) {
      this.fail(error)
    }
  }

  readFrame() {
    const buffer = this.buffer
    if (buffer.length < 2) return null
    const first = buffer[0]
    const second = buffer[1]
    const fin = (first & 0x80) !== 0
    const rsv = first & 0x70
    const opcode = first & 0x0f
    const masked = (second & 0x80) !== 0
    let length = second & 0x7f
    let offset = 2
    if (rsv !== 0) throw new ProtocolError(1002, 'RSV 非零')
    if (length === 126) {
      if (buffer.length < 4) return null
      length = buffer.readUInt16BE(2)
      offset = 4
    } else if (length === 127) {
      if (buffer.length < 10) return null
      const big = buffer.readBigUInt64BE(2)
      if (big > BigInt(MAX_FRAME)) throw new ProtocolError(1009, '帧过大')
      length = Number(big)
      offset = 10
    }
    if (length > MAX_FRAME) throw new ProtocolError(1009, '帧过大')
    let mask = null
    if (masked) {
      if (buffer.length < offset + 4) return null
      mask = buffer.subarray(offset, offset + 4)
      offset += 4
    }
    if (buffer.length < offset + length) return null
    let payload = buffer.subarray(offset, offset + length)
    if (masked) {
      const copy = Buffer.allocUnsafe(length)
      for (let index = 0; index < length; index += 1) copy[index] = payload[index] ^ mask[index & 3]
      payload = copy
    }
    this.buffer = buffer.subarray(offset + length)
    return { fin, opcode, masked, payload }
  }

  handleFrame(frame) {
    if (frame.opcode >= 0x8) {
      if (!frame.fin || frame.payload.length > 125) throw new ProtocolError(1002, '控制帧非法')
    }
    if (this.role === 'server' && !frame.masked) throw new ProtocolError(1002, '客户端帧未掩码')
    if (this.role === 'client' && frame.masked) throw new ProtocolError(1002, '服务端帧已掩码')
    switch (frame.opcode) {
      case 0x1:
        if (!frame.fin) throw new ProtocolError(1002, '不支持分片')
        if (this.onmessage) this.onmessage(frame.payload.toString('utf8'))
        break
      case 0x2:
        throw new ProtocolError(1003, '不支持二进制')
      case 0x0:
        throw new ProtocolError(1002, '未知续帧')
      case 0x8:
        this.handleClose(frame.payload)
        break
      case 0x9:
        this.sendFrame(0xA, frame.payload)
        break
      case 0xA:
        break
      default:
        throw new ProtocolError(1003, '未知操作码')
    }
  }

  handleClose(payload) {
    let code = 1000
    if (payload.length === 1) throw new ProtocolError(1002, 'close 载荷非法')
    if (payload.length >= 2) code = payload.readUInt16BE(0)
    this.closeReceived = true
    if (!this.closeSent) {
      this.sendFrame(0x8, closePayload(code))
      this.closeSent = true
    }
    this.socket.end()
    this.finish(code, 'peer close')
  }

  sendText(text) {
    return this.sendFrame(0x1, Buffer.from(String(text), 'utf8'))
  }

  sendClose(code = 1000, reason = '') {
    if (this.closeSent || this.finished) return false
    this.closeSent = true
    const sent = this.sendFrame(0x8, closePayload(code, reason))
    if (this.closeTimer === null) {
      this.closeTimer = setTimeout(() => this.destroy(), 1000)
      if (typeof this.closeTimer.unref === 'function') this.closeTimer.unref()
    }
    return sent
  }

  sendFrame(opcode, payload) {
    if (this.socket.destroyed || this.finished) return false
    const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8')
    const mask = this.role === 'client'
    const length = data.length
    let header
    if (length < 126) {
      header = Buffer.allocUnsafe(2)
      header[1] = (mask ? 0x80 : 0) | length
    } else if (length < 65536) {
      header = Buffer.allocUnsafe(4)
      header[1] = (mask ? 0x80 : 0) | 126
      header.writeUInt16BE(length, 2)
    } else {
      header = Buffer.allocUnsafe(10)
      header[1] = (mask ? 0x80 : 0) | 127
      header.writeBigUInt64BE(BigInt(length), 2)
    }
    header[0] = 0x80 | (opcode & 0x0f)
    if (!mask) {
      this.socket.write(Buffer.concat([header, data]))
      return true
    }
    const key = randomBytes(4)
    const masked = Buffer.allocUnsafe(length)
    for (let index = 0; index < length; index += 1) masked[index] = data[index] ^ key[index & 3]
    this.socket.write(Buffer.concat([header, key, masked]))
    return true
  }

  close(code = 1000, reason = '') {
    if (this.finished) return
    this.sendClose(code, reason)
    if (!this.closeSent) this.finish(code, reason)
  }

  destroy() {
    if (this.closeTimer !== null) {
      clearTimeout(this.closeTimer)
      this.closeTimer = null
    }
    try { this.socket.destroy() } catch { /* 已销毁 */ }
    this.finish(1006, 'destroyed')
  }

  finish(code, reason) {
    if (this.finished) return
    this.finished = true
    if (this.closeTimer !== null) {
      clearTimeout(this.closeTimer)
      this.closeTimer = null
    }
    if (this.onclose) this.onclose({ code, reason })
  }

  fail(error) {
    const code = error && typeof error.wsCode === 'number' ? error.wsCode : 1002
    try { this.sendClose(code, 'protocol') } catch { /* 忽略 */ }
    this.destroy()
  }
}

export class ProtocolError extends Error {
  constructor(wsCode, message) {
    super(message)
    this.name = 'ProtocolError'
    this.wsCode = wsCode
  }
}

function closePayload(code, reason = '') {
  const text = Buffer.from(String(reason), 'utf8').subarray(0, 123)
  const payload = Buffer.allocUnsafe(2 + text.length)
  payload.writeUInt16BE(code, 0)
  text.copy(payload, 2)
  return payload
}

export function connectWebSocket({
  host,
  port,
  path = '/ws',
  timeoutMs = 3000,
  secure = false,
  servername,
  rejectUnauthorized = true,
}) {
  return new Promise((resolve, reject) => {
    const key = randomBytes(16).toString('base64')
    let settled = false
    const finish = (error, peer) => {
      if (settled) return
      settled = true
      if (error) reject(error)
      else resolve(peer)
    }
    const requestHost = stripBrackets(host)
    const requestFn = secure ? httpsRequest : httpRequest
    const req = requestFn({
      hostname: requestHost,
      port,
      path,
      method: 'GET',
      timeout: timeoutMs,
      servername: secure ? (servername || requestHost) : undefined,
      rejectUnauthorized,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': '13',
      },
    })
    req.on('upgrade', (response, socket, head) => {
      const expected = acceptKey(key)
      if (response.headers['sec-websocket-accept'] !== expected) {
        socket.destroy()
        finish(new WsConnectError('EUPGRADE', '握手校验失败'))
        return
      }
      const peer = new WsPeer(socket, { role: 'client' })
      finish(null, peer)
      if (head && head.length > 0) queueMicrotask(() => peer.feed(head))
    })
    req.on('response', (response) => {
      response.resume()
      finish(new WsConnectError(`EHTTP${response.statusCode}`, `握手失败 ${response.statusCode}`))
    })
    req.on('timeout', () => {
      req.destroy(new WsConnectError('ETIMEDOUT', '连接超时'))
    })
    req.on('error', (error) => {
      finish(error instanceof WsConnectError ? error : new WsConnectError(error.code || 'ECONNECT', error.message))
    })
    req.end()
  })
}

export class WsConnectError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'WsConnectError'
    this.code = code
  }
}
