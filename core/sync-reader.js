import { copyFile, lstat, mkdir, open, readFile, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { dshHome } from './config.js'
import { addConsumed, readConsumed } from './qq/consumed.js'

const STATE_VERSION = 1
const MAX_STATE_ENTRIES = 2000
const MAX_PARTIAL_ENTRIES = 1000
const STDERR_TAIL = 2048
const LOCK_STALE_MS = 30000
const CACHE_MAX_ENTRIES = 200
const CACHE_MAX_FILE_BYTES = 256 * 1024

export function resultDir() {
  return join(dshHome(), 'storages', 'dsh-remote-worker', 'results')
}

export function readerStatePath() {
  return join(dshHome(), 'dsh-remote-worker', 'reader-state.json')
}

export function readerStateBackupPath() {
  return `${readerStatePath()}.bak`
}

export function readerLockPath() {
  return join(dshHome(), 'dsh-remote-worker', 'reader.lock')
}

export class SyncResultReader {
  constructor({ ctx, config, logger = null }) {
    this.ctx = ctx
    this.config = config
    this.logger = logger
    this.state = null
    this.timer = null
    this.stopped = true
    this.scanning = false
    this.lastScanAt = 0
    this.lastInjectAt = 0
    this.lastCleanupAt = 0
    this.lastDeleted = 0
    this.lastError = ''
    this.lastUnread = 0
    this.targetSessionId = ''
    this.cache = new Map()
  }

  async start() {
    if (!this.stopped) return
    this.stopped = false
    await this.tick()
    if (this.stopped) return
    this.restartTimer()
  }

  stop() {
    this.stopped = true
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.scanning = false
  }

  setConfig(next) {
    const previousPoll = this.config.pollMs
    this.config = next
    if (next.targetSessionId !== '') this.targetSessionId = next.targetSessionId
    if (this.stopped) return
    if (previousPoll !== next.pollMs) this.restartTimer()
  }

  restartTimer() {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = setInterval(() => {
      this.tick().catch(() => {})
    }, Math.max(1000, this.config.pollMs))
    if (typeof this.timer.unref === 'function') this.timer.unref()
  }

  status() {
    return {
      enabled: true,
      dir: resultDir(),
      targetSessionId: this.targetSessionId || (this.state && this.state.targetSessionId) || '',
      autoFollowup: this.config.autoFollowup === true,
      pollMs: this.config.pollMs,
      retentionKeep: this.config.retentionKeep,
      stdoutLimit: this.config.stdoutLimit,
      maxStdoutLimit: this.config.maxStdoutLimit,
      unread: this.lastUnread,
      partial: this.state ? this.state.partialIds.length : 0,
      lastScanAt: this.lastScanAt,
      lastInjectAt: this.lastInjectAt,
      lastCleanupAt: this.lastCleanupAt,
      lastDeleted: this.lastDeleted,
      lastError: this.lastError,
    }
  }

  async read(args = {}) {
    return this.withLock(3000, async () => {
      this.state = null
      await this.ensureState()
      const results = await listResults(this.cache)
      const requested = typeof args.id === 'string' && args.id.trim() !== '' ? args.id.trim() : ''
      let item = null
      if (requested !== '') {
        item = results.find((entry) => entry.result.id === requested) || null
        if (!item) {
          return { ok: true, found: false, id: requested, unread: this.unreadCount(results) }
        }
      } else {
        item = results.find((entry) => !this.isRead(entry)) || null
        if (!item) {
          this.lastUnread = 0
          return { ok: true, found: false, unread: 0 }
        }
      }
      const normalized = normalizeResult(item.result)
      const page = paginate(normalized, args, this.config)
      const alreadyRead = this.isRead(item)
      this.markRead(normalized)
      let consumedSaved = false
      if (page.complete) {
        this.clearPartial(normalized.id)
        consumedSaved = await this.markConsumed(normalized)
      } else {
        this.markPartial(normalized.id)
      }
      const saved = await this.saveState()
      const result = { ...normalized, ...page.fields }
      this.lastUnread = this.unreadCount(results)
      if (page.complete && consumedSaved) await this.cleanupLocal(results)
      return {
        ok: true,
        found: true,
        result,
        unread: this.lastUnread,
        consumed: true,
        fullyConsumed: page.complete,
        persisted: saved,
        consumedPersisted: consumedSaved,
        alreadyRead,
      }
    })
  }

  async tick() {
    if (this.stopped || this.scanning) return
    const release = await acquireLock(readerLockPath(), 80)
    if (!release) return
    if (this.stopped) {
      await release()
      return
    }
    this.scanning = true
    try {
      this.state = null
      await this.ensureState()
      const results = await listResults(this.cache)
      this.lastScanAt = Date.now()
      this.lastUnread = this.unreadCount(results)
      await this.cleanupLocal(results)
      if (!this.config.autoFollowup) return
      const unread = results.filter((entry) => !this.isRead(entry))
      const fresh = unread.filter((entry) => !this.isInjected(entry))
      if (fresh.length === 0) return
      const target = this.pickTarget()
      if (!target) return
      const item = fresh[0]
      const pointer = `有新的同步结果，调用 sync_read_result 读取（id: ${item.result.id}）`
      target.followup({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: pointer }],
        source: { kind: 'user' },
      })
      this.markInjected(item.result)
      await this.saveState()
      this.lastInjectAt = Date.now()
      this.lastError = ''
      this.log('同步结果已唤醒')
    } catch (error) {
      this.lastError = short(error)
      this.log('同步扫描失败')
    } finally {
      this.scanning = false
      await release()
    }
  }

  pickTarget() {
    const agents = serviceOf(this.ctx, 'agents')
    if (!agents) return null
    const list = typeof agents.list === 'function' ? agents.list() : []
    const wanted = this.config.targetSessionId || this.targetSessionId || (this.state && this.state.targetSessionId) || ''
    if (wanted !== '') {
      let exact = null
      try {
        exact = typeof agents.get === 'function' ? agents.get(wanted) : null
      } catch {
        exact = null
      }
      if (!exact) exact = list.find((agent) => agent.id === wanted) || null
      if (exact) {
        this.targetSessionId = exact.id
        if (this.state && this.state.targetSessionId !== exact.id) {
          this.state.targetSessionId = exact.id
        }
        return exact
      }
    }
    const roots = typeof agents.roots === 'function' ? agents.roots() : []
    const candidates = Array.isArray(roots) && roots.length > 0 ? roots : list
    if (!Array.isArray(candidates) || candidates.length === 0) return null
    const target = candidates.find((agent) => agent.status === 'idle') || candidates[0]
    this.targetSessionId = target.id
    if (this.state && this.state.targetSessionId !== target.id) {
      this.state.targetSessionId = target.id
    }
    return target
  }

  unreadCount(results) {
    return results.filter((entry) => !this.isRead(entry)).length
  }

  isRead(item) {
    const state = this.state
    if (!state) return false
    const key = dedupeKey(item.result)
    return state.readIds.includes(item.result.id) || (key !== '' && state.readKeys.includes(key))
  }

  isInjected(item) {
    const state = this.state
    if (!state) return false
    const key = dedupeKey(item.result)
    return state.injectedIds.includes(item.result.id) || (key !== '' && state.injectedKeys.includes(key))
  }

  isPartial(id) {
    return Boolean(this.state && this.state.partialIds.includes(id))
  }

  markRead(result) {
    const state = this.state
    if (!state) return
    const key = dedupeKey(result)
    if (!state.readIds.includes(result.id)) state.readIds.push(result.id)
    if (key !== '' && !state.readKeys.includes(key)) state.readKeys.push(key)
    state.readIds = state.readIds.slice(-MAX_STATE_ENTRIES)
    state.readKeys = state.readKeys.slice(-MAX_STATE_ENTRIES)
    state.updatedAt = new Date().toISOString()
  }

  markInjected(result) {
    const state = this.state
    if (!state) return
    const key = dedupeKey(result)
    if (!state.injectedIds.includes(result.id)) state.injectedIds.push(result.id)
    if (key !== '' && !state.injectedKeys.includes(key)) state.injectedKeys.push(key)
    state.injectedIds = state.injectedIds.slice(-MAX_STATE_ENTRIES)
    state.injectedKeys = state.injectedKeys.slice(-MAX_STATE_ENTRIES)
    state.updatedAt = new Date().toISOString()
  }

  markPartial(id) {
    const state = this.state
    if (!state) return
    if (!state.partialIds.includes(id)) state.partialIds.push(id)
    state.partialIds = state.partialIds.slice(-MAX_PARTIAL_ENTRIES)
  }

  clearPartial(id) {
    const state = this.state
    if (!state) return
    state.partialIds = state.partialIds.filter((item) => item !== id)
  }

  async markConsumed(result) {
    try {
      await addConsumed([result.id], dedupeKey(result) ? [dedupeKey(result)] : [])
      return true
    } catch (error) {
      this.lastError = short(error)
      this.log('消费状态写入失败')
      return false
    }
  }

  async cleanupLocal(results) {
    if (!this.state) return
    const keep = Math.max(1, Number(this.config.retentionKeep) || 1)
    if (results.length <= keep) return
    const age = Math.max(0, Number(this.config.retentionMinAgeMs) || 0)
    let count = results.length
    let deleted = 0
    for (const entry of results) {
      if (count <= keep) break
      if (!this.isRead(entry) || this.isPartial(entry.result.id)) continue
      if (Date.now() - entry.mtimeMs < age) continue
      try {
        await unlink(entry.file)
        count -= 1
        deleted += 1
      } catch {
        continue
      }
    }
    this.lastCleanupAt = Date.now()
    this.lastDeleted = deleted
  }

  async ensureState() {
    if (this.state) return
    this.state = await loadState()
    this.targetSessionId = this.state.targetSessionId
  }

  async saveState() {
    if (!this.state) return false
    const file = readerStatePath()
    await mkdir(join(dshHome(), 'dsh-remote-worker'), { recursive: true })
    const text = `${JSON.stringify(this.state, null, 2)}\n`
    const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.partial`
    try {
      const current = await readFile(file, 'utf8')
      JSON.parse(current)
      await copyFile(file, readerStateBackupPath()).catch(() => {})
    } catch {
      /* 主状态损坏时不覆盖好备份 */
    }
    try {
      await writeFile(temp, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      await rename(temp, file)
      return true
    } catch (error) {
      await rm(temp, { force: true }).catch(() => {})
      this.lastError = short(error)
      return false
    }
  }

  async withLock(timeoutMs, fn) {
    const release = await acquireLock(readerLockPath(), timeoutMs)
    if (!release) throw new Error('同步结果读取忙')
    try {
      return await fn()
    } finally {
      await release()
    }
  }

  log(message) {
    if (!this.logger) return
    try { this.logger.info(`[dsh-remote-worker] ${message}`) } catch { /* 忽略 */ }
  }
}

async function acquireLock(file, timeoutMs) {
  const dir = join(dshHome(), 'dsh-remote-worker')
  await mkdir(dir, { recursive: true })
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0)
  for (;;) {
    try {
      const handle = await open(file, 'wx')
      try {
        await handle.writeFile(`${JSON.stringify({ pid: process.pid, at: Date.now() })}\n`)
      } catch (error) {
        await handle.close().catch(() => {})
        await unlink(file).catch(() => {})
        throw error
      }
      let released = false
      return async () => {
        if (released) return
        released = true
        await handle.close().catch(() => {})
        await unlink(file).catch(() => {})
      }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      const info = await lstat(file).catch(() => null)
      if (!info || Date.now() - info.mtimeMs > LOCK_STALE_MS) {
        await unlink(file).catch(() => {})
        continue
      }
      if (Date.now() >= deadline) return null
      await delay(50)
    }
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function listResults(cache = null) {
  const dir = resultDir()
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const rows = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json') || entry.name.startsWith('.')) continue
    const file = join(dir, entry.name)
    try {
      const info = await lstat(file)
      if (info.isSymbolicLink()) continue
      const key = `${file}|${info.mtimeMs}|${info.size}`
      let result = cache ? cache.get(key) : null
      if (!result) {
        result = JSON.parse(await readFile(file, 'utf8'))
        if (cache && info.size <= CACHE_MAX_FILE_BYTES && isOwnResult(result)) {
          cache.set(key, result)
          if (cache.size > CACHE_MAX_ENTRIES) pruneCache(cache)
        }
      }
      if (!isOwnResult(result)) continue
      rows.push({ file, result, createdAt: timeOf(result, info), mtimeMs: info.mtimeMs })
    } catch {
      continue
    }
  }
  rows.sort((left, right) => left.createdAt - right.createdAt || left.result.id.localeCompare(right.result.id))
  return rows
}

function pruneCache(cache) {
  while (cache.size > CACHE_MAX_ENTRIES) {
    const first = cache.keys().next().value
    if (first === undefined) break
    cache.delete(first)
  }
}

function paginate(result, args, config) {
  const stdout = typeof result.stdout === 'string' ? result.stdout : ''
  const buffer = Buffer.from(stdout, 'utf8')
  const fullSize = buffer.length
  const maxLimit = Math.max(1024, Number(config.maxStdoutLimit) || 262144)
  const defaultLimit = Math.min(maxLimit, Math.max(1024, Number(config.stdoutLimit) || 65536))
  const limit = clampInt(args.limit, 1, maxLimit, defaultLimit)
  const offset = clampInt(args.offset, 0, fullSize, 0)
  const end = Math.min(offset + limit, fullSize)
  const chunk = buffer.subarray(offset, end).toString('utf8')
  const truncated = end < fullSize
  return {
    complete: !truncated,
    fields: {
      stdout: chunk,
      truncated,
      fullSize,
      offset,
      limit,
      nextOffset: truncated ? end : null,
    },
  }
}

function clampInt(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  const rounded = Math.trunc(number)
  if (rounded < min) return min
  if (rounded > max) return max
  return rounded
}

function timeOf(result, info) {
  const value = typeof result.createdAt === 'string' ? Date.parse(result.createdAt) : NaN
  if (Number.isFinite(value)) return value
  return info.mtimeMs || 0
}

function isOwnResult(result) {
  return Boolean(
    result
    && typeof result === 'object'
    && typeof result.id === 'string'
    && result.id.startsWith('qq-')
    && result.source === 'qq'
    && result.kind === 'task-result',
  )
}

function dedupeKey(result) {
  return typeof result.dedupeKey === 'string' && result.dedupeKey !== '' ? result.dedupeKey : ''
}

function normalizeResult(result) {
  const copy = { ...result }
  if (typeof copy.stderr !== 'string') copy.stderr = ''
  if (Buffer.byteLength(copy.stderr) > STDERR_TAIL) {
    copy.stderr = Buffer.from(copy.stderr, 'utf8').subarray(-STDERR_TAIL).toString('utf8')
  }
  if (typeof copy.stdout !== 'string') copy.stdout = ''
  return copy
}

async function loadState() {
  const main = await readStateFile(readerStatePath())
  const backup = main ? null : await readStateFile(readerStateBackupPath())
  const state = main || backup || fallbackState()
  const consumed = await readConsumed()
  if (consumed.ids.length > 0 || consumed.keys.length > 0) {
    for (const id of consumed.ids) {
      if (!state.readIds.includes(id)) state.readIds.push(id)
      if (!state.injectedIds.includes(id)) state.injectedIds.push(id)
    }
    for (const key of consumed.keys) {
      if (!state.readKeys.includes(key)) state.readKeys.push(key)
      if (!state.injectedKeys.includes(key)) state.injectedKeys.push(key)
    }
    state.partialIds = state.partialIds.filter((id) => !consumed.ids.includes(id))
    state.readIds = state.readIds.slice(-MAX_STATE_ENTRIES)
    state.readKeys = state.readKeys.slice(-MAX_STATE_ENTRIES)
    state.injectedIds = state.injectedIds.slice(-MAX_STATE_ENTRIES)
    state.injectedKeys = state.injectedKeys.slice(-MAX_STATE_ENTRIES)
  }
  return state
}

async function readStateFile(file) {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    if (!parsed || typeof parsed !== 'object') return null
    return {
      version: STATE_VERSION,
      targetSessionId: typeof parsed.targetSessionId === 'string' ? parsed.targetSessionId : '',
      readIds: stringArray(parsed.readIds),
      readKeys: stringArray(parsed.readKeys),
      injectedIds: stringArray(parsed.injectedIds),
      injectedKeys: stringArray(parsed.injectedKeys),
      partialIds: stringArray(parsed.partialIds).slice(-MAX_PARTIAL_ENTRIES),
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : '',
    }
  } catch {
    return null
  }
}

function fallbackState() {
  return {
    version: STATE_VERSION,
    targetSessionId: '',
    readIds: [],
    readKeys: [],
    injectedIds: [],
    injectedKeys: [],
    partialIds: [],
    updatedAt: '',
  }
}

function stringArray(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string').slice(-MAX_STATE_ENTRIES) : []
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

function short(error) {
  if (!error) return '同步读取失败'
  const message = typeof error.message === 'string' ? error.message : String(error)
  return message.slice(0, 80)
}
