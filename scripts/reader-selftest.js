import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SyncResultReader, readerStatePath, resultDir } from '../core/sync-reader.js'

let passed = 0
let failed = 0

async function check(name, fn) {
  try {
    await fn()
    passed += 1
    process.stdout.write(`PASS ${name}\n`)
  } catch (error) {
    failed += 1
    process.stderr.write(`FAIL ${name}: ${error && error.stack ? error.stack : error}\n`)
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'assert failed')
}

function makeResult(id, overrides = {}) {
  const full = id.startsWith('qq-') ? id : `qq-${id}`
  return {
    id: full,
    dedupeKey: `qq:${id}`,
    source: 'qq',
    kind: 'task-result',
    createdAt: new Date().toISOString(),
    instruction: 'selftest',
    messageId: id,
    sender: 'TEST***USER',
    senderHash: 'a'.repeat(64),
    mode: 'natural',
    prompt: 'selftest',
    status: 'ok',
    exitCode: 0,
    stdout: 'hello',
    stderr: '',
    sessionId: 'session-test',
    durationMs: 12,
    ...overrides,
  }
}

async function writeResult(home, result) {
  const dir = resultDir()
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, `${result.id}.json`), JSON.stringify(result), 'utf8')
}

const home = await mkdtemp(join(tmpdir(), 'dsh-reader-'))
process.env.DSH_HOME = home

function newReader(config = {}) {
  return new SyncResultReader({
    ctx: null,
    config: {
      targetSessionId: '',
      autoFollowup: false,
      pollMs: 5000,
      retentionKeep: 100,
      retentionMinAgeMs: 0,
      stdoutLimit: 64,
      maxStdoutLimit: 4096,
      ...config,
    },
  })
}

try {
  await check('reads newest unread result', async () => {
    await writeResult(home, makeResult('r-1'))
    const reader = newReader()
    const out = await reader.read({})
    assert(out.ok === true, 'ok')
    assert(out.found === true, 'found')
    assert(out.result.id === 'qq-r-1', `id ${out.result.id}`)
    assert(out.fullyConsumed === true, 'fullyConsumed')
  })

  await check('second read returns nothing new', async () => {
    const reader = newReader()
    const out = await reader.read({})
    assert(out.found === false, 'should not find again')
    assert(out.unread === 0, `unread ${out.unread}`)
  })

  await check('explicit id still readable after consume', async () => {
    const reader = newReader()
    const out = await reader.read({ id: 'qq-r-1' })
    assert(out.found === true, 'found by id')
    assert(out.alreadyRead === true, 'alreadyRead flag')
  })

  await check('pagination splits large stdout', async () => {
    const body = 'x'.repeat(4000)
    await writeResult(home, makeResult('r-page', { stdout: body }))
    const reader = newReader({ stdoutLimit: 64 })
    const first = await reader.read({ limit: 100 })
    assert(first.result.truncated === true, 'first page truncated')
    assert(typeof first.result.nextOffset === 'number', 'nextOffset present')
    assert(first.fullyConsumed === false, 'page 1 not fully consumed')
    const stateAfterFirst = JSON.parse(await readFile(readerStatePath(), 'utf8'))
    const consumedIds = new Set(stateAfterFirst.consumed || stateAfterFirst.consumedIds || [])
    const partialIds = new Set(stateAfterFirst.partialIds || [])
    assert(consumedIds.has('qq-r-page') === false, 'partial page not marked consumed')
    assert(partialIds.has('qq-r-page') === true, 'partial page tracked')

    let offset = first.result.nextOffset
    let text = String(first.result.stdout || '')
    let rounds = 0
    while (true) {
      const page = await reader.read({ id: 'qq-r-page', offset, limit: 2000 })
      assert(page.found === true, `page found at ${offset}`)
      text += String(page.result.stdout || '')
      rounds += 1
      if (page.result.truncated !== true) {
        assert(page.fullyConsumed === true, 'consumed after last page')
        break
      }
      offset = page.result.nextOffset
      if (rounds > 20) throw new Error(`pagination loop at offset ${offset}`)
    }
    assert(text.length === body.length, `reassembled ${text.length} of ${body.length}`)
  })

  await check('unread result survives a restart', async () => {
    await writeResult(home, makeResult('r-2'))
    const fresh = newReader()
    const out = await fresh.read({})
    assert(out.found === true, 'found after restart')
    assert(out.result.id === 'qq-r-2', `got ${out.result.id}`)
  })

  await check('retention cleanup drops old results', async () => {
    const { readdir } = await import('node:fs/promises')
    const before = (await readdir(resultDir())).length
    for (let i = 0; i < 6; i += 1) {
      await writeResult(home, makeResult(`r-keep-${i}`, { createdAt: new Date(Date.now() + i * 1000).toISOString() }))
    }
    const reader = newReader({ retentionKeep: 2, retentionMinAgeMs: 0 })
    const out = await reader.read({})
    assert(out.found === true, 'read one')
    const after = (await readdir(resultDir())).length
    assert(after < before + 6, `cleanup ran: ${before} + 6 -> ${after}`)
  })

  await check('status reports unread count', async () => {
    const reader = newReader()
    const status = reader.status()
    assert(status.enabled === true, 'enabled')
    assert(typeof status.unread === 'number', 'unread number')
  })
} finally {
  await rm(home, { recursive: true, force: true })
}

process.stdout.write(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exitCode = 1
