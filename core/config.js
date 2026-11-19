import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir, hostname } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { isMobileRuntime } from './platform.js'

export function homeDir() {
  return homedir()
}

export function dshHome() {
  const value = process.env.DSH_HOME
  if (value && isAbsolute(value)) return value
  if (isMobileRuntime()) return homedir()
  return join(homedir(), '.dsh')
}

export function configPath() {
  return join(dshHome(), 'remote-worker.json')
}

export function defaultConfig() {
  return {
    // IPv6 直连已舍弃：role/port/token/peerHost/peerPort/onOffline/connectTimeoutMs
    // 仅为兼容旧配置保留，新部署不要再设置。派发走 qq 通道。
    role: 'auto',
    port: 3099,
    token: '',
    peerHost: '',
    peerPort: 3099,
    workerName: hostname(),
    allowCommands: [],
    allowCwd: [homedir()],
    connectTimeoutMs: 3000,
    defaultTimeoutMs: 120000,
    maxTaskMs: 3600000,
    maxConcurrent: 1,
    onOffline: '',
    qq: defaultQqConfig(),
    reader: defaultReaderConfig(),
  }
}

export function defaultReaderConfig() {
  return {
    targetSessionId: '',
    autoFollowup: true,
    pollMs: 5000,
    retentionKeep: 100,
    retentionMinAgeMs: 300000,
    stdoutLimit: 65536,
    maxStdoutLimit: 262144,
  }
}

export function normalizeReaderConfig(input) {
  const base = defaultReaderConfig()
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const maxStdoutLimit = clampInt(source.maxStdoutLimit, 1024, 1048576, base.maxStdoutLimit)
  return {
    targetSessionId: text(source.targetSessionId, 128),
    autoFollowup: source.autoFollowup !== false,
    pollMs: clampInt(source.pollMs, 1000, 60000, base.pollMs),
    retentionKeep: clampInt(source.retentionKeep, 1, 10000, base.retentionKeep),
    retentionMinAgeMs: clampInt(source.retentionMinAgeMs, 0, 2592000000, base.retentionMinAgeMs),
    stdoutLimit: clampInt(source.stdoutLimit, 1024, maxStdoutLimit, Math.min(base.stdoutLimit, maxStdoutLimit)),
    maxStdoutLimit,
  }
}

export function defaultQqConfig() {
  return {
    enabled: false,
    appId: '',
    appSecret: '',
    apiBase: 'https://api.bot.qq.com',
    tokenUrl: 'https://bots.qq.com/app/getAppAccessToken',
    intents: 1 << 25,
    shard: [0, 1],
    whitelist: [],
    mode: 'natural',
    prefix: '/exec',
    sessionId: '',
    cwd: '',
    timeoutMs: 120000,
    maxQueue: 8,
    resume: true,
    retentionKeep: 200,
    retentionMinAgeMs: 3600000,
    cleanupIntervalMs: 3600000,
  }
}

export function normalizeQqConfig(input) {
  const base = defaultQqConfig()
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const enabled = source.enabled === true
  const appId = text(source.appId, 128)
  const appSecret = text(source.appSecret, 256)
  const apiBase = text(source.apiBase, 512).replace(/\/+$/, '') || base.apiBase
  const tokenUrl = text(source.tokenUrl, 512) || base.tokenUrl
  const intents = Number.isSafeInteger(source.intents) && source.intents >= 0 ? source.intents : base.intents
  const shard = Array.isArray(source.shard)
    && source.shard.length === 2
    && source.shard.every((item) => Number.isInteger(item) && item >= 0 && item <= 65535)
    ? source.shard
    : base.shard
  const whitelist = Array.isArray(source.whitelist)
    ? [...new Set(source.whitelist.filter((item) => typeof item === 'string' && item.trim() !== '').map((item) => item.trim().slice(0, 128)))]
    : []
  const mode = source.mode === 'exec' ? 'exec' : 'natural'
  const prefix = text(source.prefix, 16) || base.prefix
  const sessionId = text(source.sessionId, 128)
  const cwd = text(source.cwd, 4096) ? expandHome(text(source.cwd, 4096)) : ''
  const timeoutMs = clampInt(source.timeoutMs, 1000, 3600000, base.timeoutMs)
  const maxQueue = clampInt(source.maxQueue, 1, 100, base.maxQueue)
  const resume = source.resume !== false
  const retentionKeep = clampInt(source.retentionKeep, 1, 10000, base.retentionKeep)
  const retentionMinAgeMs = clampInt(source.retentionMinAgeMs, 0, 2592000000, base.retentionMinAgeMs)
  const cleanupIntervalMs = clampInt(source.cleanupIntervalMs, 60000, 86400000, base.cleanupIntervalMs)
  return {
    enabled,
    appId,
    appSecret,
    apiBase,
    tokenUrl,
    intents,
    shard: [...shard],
    whitelist,
    mode,
    prefix,
    sessionId,
    cwd,
    timeoutMs,
    maxQueue,
    resume,
    retentionKeep,
    retentionMinAgeMs,
    cleanupIntervalMs,
  }
}

function text(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

export function normalizeConfig(input) {
  const base = defaultConfig()
  const source = input && typeof input === 'object' ? input : {}
  const merged = { ...base, ...source }
  const role = ['auto', 'host', 'client'].includes(merged.role) ? merged.role : 'auto'
  const port = clampInt(merged.port, 0, 65535, base.port)
  const peerPort = clampInt(merged.peerPort, 1, 65535, base.peerPort)
  const connectTimeoutMs = clampInt(merged.connectTimeoutMs, 100, 60000, base.connectTimeoutMs)
  const defaultTimeoutMs = clampInt(merged.defaultTimeoutMs, 100, 3600000, base.defaultTimeoutMs)
  const maxTaskMs = clampInt(merged.maxTaskMs, 1000, 86400000, base.maxTaskMs)
  const maxConcurrent = clampInt(merged.maxConcurrent, 1, 16, base.maxConcurrent)
  const allowCommands = Array.isArray(merged.allowCommands)
    ? merged.allowCommands.filter((item) => typeof item === 'string' && item.trim() !== '').map((item) => item.trim())
    : []
  const allowCwdSource = Array.isArray(merged.allowCwd) ? merged.allowCwd : [merged.allowCwd]
  const allowCwd = allowCwdSource
    .filter((item) => typeof item === 'string' && item.trim() !== '')
    .map((item) => expandHome(item.trim()))
  return {
    role,
    port,
    token: typeof merged.token === 'string' ? merged.token.trim() : '',
    peerHost: typeof merged.peerHost === 'string' ? stripBrackets(merged.peerHost.trim()) : '',
    peerPort,
    workerName: typeof merged.workerName === 'string' && merged.workerName.trim() !== ''
      ? merged.workerName.trim().slice(0, 64)
      : base.workerName,
    allowCommands,
    allowCwd: allowCwd.length > 0 ? allowCwd : [homedir()],
    connectTimeoutMs,
    defaultTimeoutMs,
    maxTaskMs,
    maxConcurrent,
    onOffline: typeof merged.onOffline === 'string' ? merged.onOffline.trim().slice(0, 128) : '',
    qq: normalizeQqConfig(merged.qq),
    reader: normalizeReaderConfig(merged.reader),
  }
}

export async function loadConfig(raw) {
  let fileConfig = {}
  let fileError = null
  try {
    const text = await readFile(configPath(), 'utf8')
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) fileConfig = parsed
  } catch (error) {
    if (error && error.code !== 'ENOENT') fileError = error.code || error.message
  }
  const config = normalizeConfig({ ...(raw && typeof raw === 'object' ? raw : {}), ...fileConfig })
  return { config, fileError }
}

export async function saveConfig(config) {
  const clean = normalizeConfig(config)
  const target = configPath()
  await mkdir(dirname(target), { recursive: true })
  const temp = `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(temp, JSON.stringify(clean, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  try {
    await chmod(temp, 0o600)
  } catch { /* Windows 无 POSIX 权限位 */ }
  try {
    await rename(temp, target)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {})
    throw error
  }
  return clean
}

export function generateToken() {
  return randomBytes(24).toString('base64url')
}

export function expandHome(value) {
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(homedir(), value.slice(2))
  return resolve(value)
}

export function stripBrackets(host) {
  if (typeof host !== 'string') return ''
  let value = host.trim()
  if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1)
  return value
}

export function configSummary(config) {
  return {
    role: config.role,
    port: config.port,
    peerHost: config.peerHost,
    peerPort: config.peerPort,
    workerName: config.workerName,
    allowCommands: config.allowCommands,
    allowCwd: config.allowCwd,
    connectTimeoutMs: config.connectTimeoutMs,
    defaultTimeoutMs: config.defaultTimeoutMs,
    maxTaskMs: config.maxTaskMs,
    maxConcurrent: config.maxConcurrent,
    onOffline: config.onOffline,
    tokenSet: config.token.length > 0,
    qq: {
      enabled: config.qq.enabled,
      appId: config.qq.appId,
      appSecretSet: config.qq.appSecret.length > 0,
      mode: config.qq.mode,
      prefix: config.qq.prefix,
      whitelistCount: config.qq.whitelist.length,
      sessionId: config.qq.sessionId,
      cwd: config.qq.cwd,
      timeoutMs: config.qq.timeoutMs,
      maxQueue: config.qq.maxQueue,
      resume: config.qq.resume,
      retentionKeep: config.qq.retentionKeep,
    },
    reader: {
      targetSessionId: config.reader.targetSessionId,
      autoFollowup: config.reader.autoFollowup,
      pollMs: config.reader.pollMs,
      retentionKeep: config.reader.retentionKeep,
      stdoutLimit: config.reader.stdoutLimit,
      maxStdoutLimit: config.reader.maxStdoutLimit,
    },
  }
}

function clampInt(value, min, max, fallback) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return fallback
  const rounded = Math.trunc(number)
  if (rounded < min) return min
  if (rounded > max) return max
  return rounded
}
