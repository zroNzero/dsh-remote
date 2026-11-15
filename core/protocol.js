import { randomBytes } from 'node:crypto'

export const PROTOCOL_VERSION = 1
export const WS_PATH = '/ws'
export const HEALTH_PATH = '/health'

export function newTaskId() {
  return `rw-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`
}

export function parseMessage(text) {
  if (typeof text !== 'string' || text.length === 0 || text.length > 4 * 1024 * 1024) return null
  try {
    const value = JSON.parse(text)
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null
  } catch {
    return null
  }
}

export function normalizeTask(input, config) {
  const source = input && typeof input === 'object' ? input : {}
  const command = typeof source.command === 'string' ? source.command.trim() : ''
  if (command === '' || command.length > 32768) return { error: '命令为空' }
  const cwd = typeof source.cwd === 'string' ? source.cwd.trim().slice(0, 4096) : ''
  const requested = typeof source.timeoutMs === 'number' ? source.timeoutMs : config.defaultTimeoutMs
  const timeoutMs = Math.max(100, Math.min(Math.trunc(requested), config.maxTaskMs))
  const taskId = typeof source.taskId === 'string' && source.taskId.trim() !== ''
    ? source.taskId.trim().slice(0, 128)
    : newTaskId()
  return {
    task: { taskId, command, cwd, timeoutMs },
  }
}
