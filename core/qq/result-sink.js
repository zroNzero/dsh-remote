import { lstat, mkdir, readdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { dshHome } from '../config.js'
import { qqError } from './errors.js'
import { consumedHas, readConsumed } from './consumed.js'

const MAX_RESULT_BYTES = 45 * 1024 * 1024

export function resultDir() {
  return join(dshHome(), 'storages', 'dsh-remote-worker', 'results')
}

export async function writeResult(result) {
  const dir = resultDir()
  await mkdir(dir, { recursive: true })
  const jobId = safe(result.id)
  if (jobId === '') throw qqError('QQ_RESULT_ID', '结果标识非法')
  const file = join(dir, `${jobId}.json`)
  const existing = await lstat(file).catch(() => null)
  if (existing) {
    if (!existing.isFile() || existing.isSymbolicLink()) throw qqError('QQ_RESULT_PATH', '结果路径非法')
    return { path: file, dir, existed: true }
  }
  const text = fit({ ...result, stderr: tail(result.stderr) })
  const temp = join(dir, `.${jobId}.${process.pid}.${randomBytes(4).toString('hex')}.partial`)
  await writeFile(temp, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  try {
    await rename(temp, file)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {})
    throw qqError('QQ_RESULT_WRITE', '结果写入失败', { cause: error.code || error.message })
  }
  return { path: file, dir, existed: false }
}

export async function cleanupResults({ keep = 200, minAgeMs = 3600000 } = {}) {
  const dir = resultDir()
  const consumed = await readConsumed()
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return { deleted: 0, kept: 0 }
  }
  const rows = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json') || entry.name.startsWith('.')) continue
    const file = join(dir, entry.name)
    try {
      const info = await lstat(file)
      if (info.isSymbolicLink()) continue
      const result = JSON.parse(await readFile(file, 'utf8'))
      if (!isOwnResult(result)) continue
      rows.push({
        file,
        id: result.id,
        dedupeKey: typeof result.dedupeKey === 'string' ? result.dedupeKey : '',
        createdAt: timeOf(result, info),
        mtimeMs: info.mtimeMs,
      })
    } catch {
      continue
    }
  }
  rows.sort((left, right) => left.createdAt - right.createdAt)
  let count = rows.length
  let deleted = 0
  const limit = Math.max(1, Number(keep) || 1)
  const age = Math.max(0, Number(minAgeMs) || 0)
  for (const row of rows) {
    if (count <= limit) break
    if (!consumedHas(consumed, row.id, row.dedupeKey)) continue
    if (Date.now() - row.mtimeMs < age) continue
    try {
      await unlink(row.file)
      count -= 1
      deleted += 1
    } catch {
      continue
    }
  }
  return { deleted, kept: count }
}

function isOwnResult(result) {
  return Boolean(
    result
    && typeof result.id === 'string'
    && result.id.startsWith('qq-')
    && result.source === 'qq'
    && result.kind === 'task-result',
  )
}

function timeOf(result, info) {
  const value = typeof result.createdAt === 'string' ? Date.parse(result.createdAt) : NaN
  return Number.isFinite(value) ? value : info.mtimeMs
}

function fit(result) {
  const full = `${JSON.stringify(result, null, 2)}\n`
  if (Buffer.byteLength(full) <= MAX_RESULT_BYTES) return full
  const stdout = typeof result.stdout === 'string' ? result.stdout : ''
  const copy = { ...result, stdoutTruncated: true, stdoutBytes: Buffer.byteLength(stdout) }
  const empty = `${JSON.stringify({ ...copy, stdout: '' }, null, 2)}\n`
  const budget = MAX_RESULT_BYTES - Buffer.byteLength(empty) - 1024
  if (budget <= 0) throw qqError('QQ_RESULT_LARGE', '结果文件过大')
  const buffer = Buffer.from(stdout, 'utf8')
  copy.stdout = buffer.subarray(Math.max(0, buffer.length - budget)).toString('utf8')
  const text = `${JSON.stringify(copy, null, 2)}\n`
  if (Buffer.byteLength(text) > MAX_RESULT_BYTES) throw qqError('QQ_RESULT_LARGE', '结果文件过大')
  return text
}

function safe(value) {
  return String(value || '').replace(/[^a-zA-Z0-9_-]/g, '_').replace(/[. ]+$/g, '').slice(0, 96)
}

function tail(text) {
  if (typeof text !== 'string' || text.length === 0) return ''
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.length <= 2048) return text
  return buffer.subarray(buffer.length - 2048).toString('utf8')
}
