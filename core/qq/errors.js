export class QqError extends Error {
  constructor(code, message, options = {}) {
    super(message)
    this.name = 'QqError'
    this.code = code
    if (options.cause !== undefined) this.cause = options.cause
    if (options.status !== undefined) this.status = options.status
  }
}

export function qqError(code, message, options) {
  return new QqError(code, message, options)
}

export function shortError(error) {
  if (!error) return 'QQ 通道失败'
  if (typeof error.code === 'string' && typeof error.message === 'string') return `${error.code} ${error.message}`
  return String(error.message || error).slice(0, 80)
}
