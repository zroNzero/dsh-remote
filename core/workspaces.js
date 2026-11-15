import { open, readdir, readFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { dshHome } from './config.js'

const HEAD_BYTES = 384 * 1024
const MAX_FRAMES = 96
const MAX_TITLE = 80
const MAX_SESSIONS = 80
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd]

export function workspaceStorePath() {
  return join(dshHome(), 'storages', 'workspace.json')
}

export function sessionsRoot() {
  return join(dshHome(), 'sessions')
}

export function sessionDirName(cwd) {
  const text = String(cwd || '').trim()
  if (text === '') return ''
  return `--${text.replace(/[\\/:]/g, '-').replace(/^-+|-+$/g, '').replace(/-+/g, '-')}--`
}

function samePath(left, right) {
  const a = String(left || '').replace(/[\\/]+$/, '').toLowerCase()
  const b = String(right || '').replace(/[\\/]+$/, '').toLowerCase()
  return a !== '' && a === b
}

async function readStore() {
  let raw
  try {
    raw = JSON.parse(await readFile(workspaceStorePath(), 'utf8'))
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object') return null
  const table = raw.tables && raw.tables.workspaces && typeof raw.tables.workspaces === 'object'
    ? raw.tables.workspaces
    : {}
  const global = raw.global && typeof raw.global === 'object' ? raw.global : {}
  const order = Array.isArray(global.workspaceIds) ? global.workspaceIds : Object.keys(table)
  const workspaces = []
  for (const id of order) {
    const item = table[id]
    if (!item || typeof item.path !== 'string' || item.path === '') continue
    workspaces.push({
      id,
      path: item.path,
      title: typeof item.title === 'string' && item.title !== '' ? item.title : basename(item.path),
      sessionIds: Array.isArray(item.sessionIds) ? item.sessionIds.filter((value) => typeof value === 'string' && value !== '') : [],
      updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : '',
    })
  }
  return {
    defaultId: typeof global.defaultWorkspaceId === 'string' ? global.defaultWorkspaceId : '',
    archived: new Set(Array.isArray(global.archivedSessionIds) ? global.archivedSessionIds : []),
    workspaces,
  }
}

function frameOffsets(buffer) {
  const marks = []
  for (let index = 0; index + 3 < buffer.length; index += 1) {
    if (buffer[index] !== ZSTD_MAGIC[0]) continue
    if (buffer[index + 1] !== ZSTD_MAGIC[1]) continue
    if (buffer[index + 2] !== ZSTD_MAGIC[2]) continue
    if (buffer[index + 3] !== ZSTD_MAGIC[3]) continue
    marks.push(index)
    if (marks.length > MAX_FRAMES) break
  }
  return marks
}

function toTitle(value) {
  if (typeof value !== 'string') return ''
  const text = value.replace(/\s+/g, ' ').trim()
  if (text === '') return ''
  return text.length > MAX_TITLE ? `${text.slice(0, MAX_TITLE)}…` : text
}

export async function readSessionHead(file) {
  const meta = { title: '', origin: '', cwd: '', createdAt: 0 }
  let buffer
  try {
    const handle = await open(file, 'r')
    try {
      const info = await handle.stat()
      const size = Math.min(HEAD_BYTES, info.size)
      if (size <= 0) return meta
      buffer = Buffer.alloc(size)
      await handle.read(buffer, 0, size, 0)
    } finally {
      await handle.close()
    }
  } catch {
    return meta
  }
  const marks = frameOffsets(buffer)
  for (let index = 0; index < Math.min(marks.length, MAX_FRAMES); index += 1) {
    const end = index + 1 < marks.length ? marks[index + 1] : buffer.length
    let text = ''
    try {
      text = zstdDecompressSync(buffer.subarray(marks[index], end)).toString('utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      if (line === '') continue
      let event
      try {
        event = JSON.parse(line)
      } catch {
        continue
      }
      if (!event || typeof event !== 'object') continue
      if (event.type === 'session/title' && event.data && typeof event.data.title === 'string') {
        const title = toTitle(event.data.title)
        if (title !== '') meta.title = title
      }
      if (meta.cwd === '' && typeof event.cwd === 'string') meta.cwd = event.cwd
      if (meta.origin === '' && typeof event.origin === 'string') meta.origin = event.origin
      if (meta.createdAt === 0 && typeof event.createdAt === 'number') meta.createdAt = event.createdAt
    }
    if (meta.title !== '' && meta.origin !== '') break
  }
  return meta
}

export async function listSessions(cwd, options = {}) {
  const dirName = sessionDirName(cwd)
  if (dirName === '') return []
  const archived = options.archived instanceof Set ? options.archived : new Set()
  const liveIds = options.liveIds instanceof Set ? options.liveIds : new Set()
  const root = join(sessionsRoot(), dirName)
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const rows = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('session-')) continue
    if (archived.has(entry.name)) continue
    const file = join(root, entry.name, 'session.v4.jsonl.zstd')
    const meta = await readSessionHead(file)
    if (meta.origin === 'subagent') continue
    const info = await stat(file).catch(() => null)
    rows.push({
      id: entry.name,
      title: meta.title,
      live: liveIds.has(entry.name),
      createdAt: meta.createdAt > 0 ? new Date(meta.createdAt).toISOString() : '',
      updatedAt: info ? new Date(info.mtimeMs).toISOString() : '',
      mtimeMs: info ? info.mtimeMs : 0,
    })
  }
  rows.sort((left, right) => right.mtimeMs - left.mtimeMs || left.id.localeCompare(right.id))
  return rows.slice(0, MAX_SESSIONS).map(({ mtimeMs, ...rest }) => rest)
}

export async function listWorkspaces(options = {}) {
  const store = await readStore()
  if (!store) return []
  const liveIds = new Set(Array.isArray(options.liveIds) ? options.liveIds : [])
  const rows = []
  for (const item of store.workspaces) {
    const sessions = await listSessions(item.path, { archived: store.archived, liveIds })
    const known = new Set(sessions.map((session) => session.id))
    for (const id of item.sessionIds) {
      if (known.has(id) || store.archived.has(id)) continue
      if (!liveIds.has(id)) continue
      sessions.push({ id, title: '', live: true, createdAt: '', updatedAt: '' })
    }
    rows.push({
      id: item.id,
      title: item.title,
      path: item.path,
      isDefault: item.id === store.defaultId,
      updatedAt: item.updatedAt,
      sessions,
    })
  }
  const extra = typeof options.extraCwd === 'string' ? options.extraCwd.trim() : ''
  if (extra !== '' && !rows.some((row) => samePath(row.path, extra))) {
    rows.unshift({
      id: '__custom__',
      title: `${basename(extra)}（当前）`,
      path: extra,
      isDefault: false,
      updatedAt: '',
      sessions: await listSessions(extra, { archived: store.archived, liveIds }),
    })
  }
  return rows
}
