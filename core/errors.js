export const ERROR_CODES = Object.freeze({
  OFFLINE: 'ERR_WORKER_OFFLINE',
  AUTH: 'ERR_AUTH_FAILED',
  TIMEOUT: 'ERR_TIMEOUT',
  REJECTED: 'ERR_REJECTED',
  EXEC: 'ERR_EXEC',
  ROLE: 'ERR_ROLE_UNSUPPORTED',
  PORT: 'ERR_PORT_IN_USE',
  INTERRUPTED: 'ERR_CLIENT_INTERRUPTED',
})

const MESSAGES = {
  ERR_WORKER_OFFLINE: '电脑端离线',
  ERR_AUTH_FAILED: 'token 错误',
  ERR_TIMEOUT: '执行超时',
  ERR_REJECTED: '任务被拒绝',
  ERR_EXEC: '命令执行失败',
  ERR_ROLE_UNSUPPORTED: '角色不支持',
  ERR_PORT_IN_USE: '端口被占用',
  ERR_CLIENT_INTERRUPTED: '连接中断',
}

export class RemoteWorkerError extends Error {
  constructor(code, message, options = {}) {
    super(message || MESSAGES[code] || '远程执行失败')
    this.name = 'RemoteWorkerError'
    this.code = code
    if (options.fallback !== undefined) this.fallback = options.fallback
    if (options.task !== undefined) this.task = options.task
    if (options.onOffline !== undefined) this.onOffline = options.onOffline
    if (options.details !== undefined) this.details = options.details
  }
}

export function remoteError(code, message, options) {
  return new RemoteWorkerError(code, message || MESSAGES[code], options)
}

export function shortMessage(code) {
  return MESSAGES[code] || '远程执行失败'
}

export function serializeError(error) {
  const code = error && typeof error.code === 'string' ? error.code : ERROR_CODES.EXEC
  const body = {
    code,
    message: error && typeof error.message === 'string' ? error.message : shortMessage(code),
  }
  if (error && error.fallback !== undefined) body.fallback = error.fallback
  if (error && error.task !== undefined) body.task = error.task
  if (error && error.onOffline !== undefined) body.onOffline = error.onOffline
  if (error && error.details !== undefined) body.details = error.details
  return body
}

export function wireError(code, message) {
  return { type: 'error', code, message: message || shortMessage(code) }
}
