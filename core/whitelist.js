import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, relative, resolve } from 'node:path'
import { remoteError, ERROR_CODES } from './errors.js'
import { expandHome } from './config.js'

export function commandAllowed(patterns, command) {
  if (!Array.isArray(patterns) || patterns.length === 0) return false
  for (const pattern of patterns) {
    if (pattern === '*') return true
    if (matchGlob(pattern, command)) return true
  }
  return false
}

export function matchGlob(pattern, value) {
  const source = String(pattern)
  let regex = '^'
  for (const char of source) {
    if (char === '*') regex += '[\\s\\S]*'
    else if (char === '?') regex += '[\\s\\S]'
    else regex += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  regex += '$'
  try {
    return new RegExp(regex).test(value)
  } catch {
    return false
  }
}

export async function resolveCwd(cwd, allowCwd) {
  const requested = typeof cwd === 'string' && cwd.trim() !== '' ? expandHome(cwd.trim()) : homedir()
  const target = resolve(requested)
  let realTarget
  try {
    realTarget = await realpath(target)
  } catch {
    throw remoteError(ERROR_CODES.REJECTED, '目录不可用', { details: { cwd: target } })
  }
  const allowed = []
  for (const item of Array.isArray(allowCwd) ? allowCwd : []) {
    try {
      allowed.push(await realpath(resolve(expandHome(item))))
    } catch { /* 不存在的白名单目录跳过 */ }
  }
  const targetKey = process.platform === 'win32' ? realTarget.toLowerCase() : realTarget
  for (const base of allowed) {
    const baseKey = process.platform === 'win32' ? base.toLowerCase() : base
    if (targetKey === baseKey) return realTarget
    const rel = relative(baseKey, targetKey)
    if (rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)) return realTarget
  }
  throw remoteError(ERROR_CODES.REJECTED, '目录未授权', { details: { cwd: target } })
}
