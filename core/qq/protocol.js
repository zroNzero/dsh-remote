export const OP = Object.freeze({
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
})

export const INTENTS = Object.freeze({
  GROUP_AND_C2C_EVENT: 1 << 25,
})

export const C2C_MESSAGE_CREATE = 'C2C_MESSAGE_CREATE'
export const READY = 'READY'
export const RESUMED = 'RESUMED'

export function identifyPayload(token, intents, shard) {
  return {
    op: OP.IDENTIFY,
    d: {
      token: `QQBot ${token}`,
      intents,
      shard: Array.isArray(shard) && shard.length === 2 ? [shard[0], shard[1]] : [0, 1],
      properties: {
        os: process.platform,
        browser: 'dsh-remote-worker',
        device: 'dsh-remote-worker',
      },
    },
  }
}

export function resumePayload(token, sessionId, seq) {
  return {
    op: OP.RESUME,
    d: {
      token: `QQBot ${token}`,
      session_id: sessionId,
      seq: Number.isInteger(seq) ? seq : null,
    },
  }
}

export function heartbeatPayload(seq) {
  return { op: OP.HEARTBEAT, d: Number.isInteger(seq) ? seq : null }
}

export function parseGatewayFrame(text) {
  if (typeof text !== 'string' || text === '') return null
  let value
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (!value || typeof value !== 'object' || !Number.isInteger(value.op)) return null
  return value
}

export function parseC2CMessage(data) {
  if (!data || typeof data !== 'object') return null
  const content = typeof data.content === 'string' ? data.content.trim() : ''
  if (content === '') return null
  const author = data.author && typeof data.author === 'object' ? data.author : {}
  const sender = firstString(author.user_openid, author.member_openid, author.id, data.user_openid)
  if (sender === '') return null
  const id = firstString(data.id, data.message_id)
  return {
    id: id || `no-id-${Date.now()}`,
    content,
    sender,
    timestamp: typeof data.timestamp === 'string' ? data.timestamp : '',
    raw: data,
  }
}

export function stripPrefix(content, prefix) {
  if (typeof content !== 'string') return ''
  if (typeof prefix !== 'string' || prefix === '') return ''
  if (!content.startsWith(prefix)) return ''
  return content.slice(prefix.length).trim()
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return ''
}
