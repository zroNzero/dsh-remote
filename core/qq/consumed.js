import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { dshHome } from '../config.js'

const MAX_ENTRIES = 5000

export function consumedPath() {
  return join(dshHome(), 'storages', 'dsh-remote-worker', 'consumed.json')
}

export async function readConsumed() {
  const empty = { version: 1, ids: [], keys: [], updatedAt: '' }
  try {
    const parsed = JSON.parse(await readFile(consumedPath(), 'utf8'))
    if (!parsed || typeof parsed !== 'object') return empty
    return {
      version: 1,
      ids: stringArray(parsed.ids),
      keys: stringArray(parsed.keys),
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : '',
    }
  } catch {
    return empty
  }
}

export async function addConsumed(ids, keys) {
  const current = await readConsumed()
  const next = {
    version: 1,
    ids: merge(current.ids, ids),
    keys: merge(current.keys, keys),
    updatedAt: new Date().toISOString(),
  }
  await writeConsumed(next)
  return next
}

export function consumedHas(consumed, id, dedupeKey) {
  if (!consumed) return false
  if (consumed.ids.includes(id)) return true
  return typeof dedupeKey === 'string' && dedupeKey !== '' && consumed.keys.includes(dedupeKey)
}

export async function writeConsumed(state) {
  const dir = join(dshHome(), 'storages', 'dsh-remote-worker')
  await mkdir(dir, { recursive: true })
  const file = consumedPath()
  const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.partial`
  const text = `${JSON.stringify({
    version: 1,
    ids: stringArray(state.ids).slice(-MAX_ENTRIES),
    keys: stringArray(state.keys).slice(-MAX_ENTRIES),
    updatedAt: state.updatedAt || new Date().toISOString(),
  }, null, 2)}\n`
  try {
    await writeFile(temp, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    await rename(temp, file)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {})
    throw error
  }
}

function merge(left, right) {
  const result = Array.isArray(left) ? [...left] : []
  for (const value of Array.isArray(right) ? right : []) {
    if (typeof value === 'string' && value !== '' && !result.includes(value)) result.push(value)
  }
  return result.slice(-MAX_ENTRIES)
}

function stringArray(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item !== '').slice(-MAX_ENTRIES) : []
}
