import {
  configPath,
  configSummary,
  generateToken,
  loadConfig,
  normalizeConfig,
  saveConfig,
} from './core/config.js'
import { detectCapabilities, resolveRole } from './core/capabilities.js'
import { dispatchTask } from './core/client.js'
import { ERROR_CODES, RemoteWorkerError, remoteError, serializeError } from './core/errors.js'
import { listIPv6Addresses } from './core/ipv6.js'
import { normalizeTask } from './core/protocol.js'
import { QqChannel } from './core/qq/channel.js'
import { shortError } from './core/qq/errors.js'
import { WorkerServer } from './core/server.js'
import { dispatchControl } from './core/client.js'
import { SyncResultReader } from './core/sync-reader.js'
import { cleanupResults } from './core/qq/result-sink.js'
import { listWorkspaces } from './core/workspaces.js'

export { dispatchTask } from './core/client.js'
export { ERROR_CODES, RemoteWorkerError } from './core/errors.js'

export const name = 'dsh-remote-worker'
export const inject = []

export const PROMPT = [
  '重任务（编译/构建/装依赖/长脚本）必须调 remote_execute。',
  '禁止本地静默替代。失败即上报，不得降级。',
  'ERR_WORKER_OFFLINE → 告知“电脑端离线”，不重试。',
  'ERR_TIMEOUT → 最多重试 1 次，加大 timeoutMs 并说明。',
  'stderr 原样转述关键行，不扩写。',
].join('\n')

const TOOL_DESCRIPTION = [
  '在电脑端执行命令，stdout/stderr 流式回传。',
  '编译、构建、装依赖、长脚本必须用本工具。',
  '离线时 error.fallback=offline_queue。',
].join('\n')

const API_BASE = '/dsh-remote-worker/api2'

const TOOL_PARAMETERS = {
  type: 'object',
  properties: {
    command: { type: 'string', description: '命令' },
    cwd: { type: 'string', description: '工作目录' },
    timeoutMs: { type: 'number', description: '超时毫秒' },
    taskId: { type: 'string', description: '任务标识' },
  },
  required: ['command'],
  additionalProperties: false,
}

let activeRuntime = null
const knownRuntimes = new Set()

function liveRuntime() {
  if (activeRuntime && activeRuntime.qq) return activeRuntime
  for (const candidate of knownRuntimes) {
    if (candidate.qq && !candidate.superseded) return candidate
  }
  if (activeRuntime) return activeRuntime
  for (const candidate of knownRuntimes) return candidate
  return null
}

function supersedePrevious() {
  for (const previous of knownRuntimes) {
    if (previous === activeRuntime) continue
    previous.superseded = true
    try {
      if (previous.qq) {
        const qq = previous.qq
        previous.qq = null
        qq.stopGracefully(3000).catch(() => {})
      }
    } catch { /* 忽略 */ }
    try {
      if (previous.reader) previous.reader.stop()
    } catch { /* 忽略 */ }
  }
}

const TOOL_OUTPUT_SCHEMA = {
  type: 'object',
}

const SYNC_TOOL_DESCRIPTION = [
  '读取同步结果。',
  '无 id 取最早未读；大输出用 offset/limit 分页。',
].join('\n')

const SYNC_TOOL_PARAMETERS = {
  type: 'object',
  properties: {
    id: { type: 'string', description: '结果标识' },
    offset: { type: 'number', description: 'stdout 字节偏移，默认 0' },
    limit: { type: 'number', description: 'stdout 字节数，默认 64KB' },
  },
  required: [],
  additionalProperties: false,
}

export async function apply(ctx, rawConfig = {}) {
  const loaded = await loadConfig(rawConfig)
  const config = loaded.config
  const capabilities = await detectCapabilities(ctx)
  const role = resolveRole(config, capabilities)

  if (role === 'host' && !capabilities.canServe) {
    throw new RemoteWorkerError(ERROR_CODES.ROLE, '角色不支持', { details: { canServe: false, canSpawn: capabilities.canSpawn } })
  }
  if (role === 'client' && !capabilities.canDispatch) {
    throw new RemoteWorkerError(ERROR_CODES.ROLE, '角色不支持', { details: { canDispatch: false } })
  }
  capabilities.serveEnabled = role === 'host' && capabilities.canServe

  const runtime = {
    ctx,
    config,
    capabilities,
    role,
    server: null,
    serverError: loaded.fileError ? { code: ERROR_CODES.REJECTED, message: '配置读取失败' } : null,
    startedAt: Date.now(),
    qqSkip: '',
    routesStale: false,
    routesMounted: 0,
    webServerMissing: false,
    disposed: false,
    version: '1.0.0',
  }

  knownRuntimes.add(runtime)
  activeRuntime = runtime
  supersedePrevious()

  runtime.ensureQq = () => {
    if (activeRuntime !== runtime) {
      runtime.qqSkip = 'superseded'
      return
    }
    if (!runtime.capabilities.serveEnabled) {
      runtime.qqSkip = 'not-host'
      return
    }
    if (runtime.config.qq.enabled) {
      runtime.qqSkip = ''
      if (!runtime.qq) {
        runtime.qq = new QqChannel({
          ctx,
          config: runtime.config.qq,
          rootConfig: () => runtime.config,
          logger: safeLogger(ctx),
        })
        runtime.qq.start()
      } else {
        runtime.qq.setConfig(runtime.config.qq)
      }
      return
    }
    runtime.qqSkip = 'disabled'
    if (runtime.qq) {
      runtime.qq.stop()
      runtime.qq = null
    }
  }

  runtime.ensureReader = () => {
    if (!runtime.capabilities.mobile) return
    if (!runtime.reader) {
      runtime.reader = new SyncResultReader({
        ctx,
        config: runtime.config.reader,
        logger: safeLogger(ctx),
      })
      runtime.reader.start().catch((error) => {
        runtime.serverError = serializeError(remoteError(ERROR_CODES.REJECTED, '结果读取失败', { details: { cause: error.code || error.message } }))
      })
      return
    }
    runtime.reader.setConfig(runtime.config.reader)
  }

  ctx.effect(() => () => {
    runtime.disposed = true
    const jobs = []
    if (runtime.reader) {
      try { runtime.reader.stop() } catch { /* 忽略 */ }
      runtime.reader = null
    }
    if (runtime.qq) {
      const qq = runtime.qq
      runtime.qq = null
      jobs.push(Promise.resolve().then(() => qq.stopGracefully(5000)).catch(() => {}))
    }
    if (runtime.server) jobs.push(runtime.server.dispose())
    return Promise.allSettled(jobs).then(() => undefined)
  }, 'dsh-remote-worker: lifecycle')

  if (capabilities.serveEnabled && !config.token) {
    config.token = generateToken()
    try {
      await saveConfig(config)
      log(ctx, 'token 已生成')
    } catch (error) {
      runtime.serverError = serializeError(remoteError(ERROR_CODES.REJECTED, '配置写入失败', { details: { cause: error.code || error.message } }))
    }
  }

  if (runtime.disposed) return

  if (capabilities.serveEnabled) {
    runtime.server = new WorkerServer({
      config,
      shell: capabilities.shell,
      logger: safeLogger(ctx),
      version: runtime.version,
      control: {
        get: () => qqTargetSnapshot(ctx, runtime),
        set: (patch) => applyQqTarget(ctx, runtime, patch),
      },
    })
    try {
      await runtime.server.start()
      if (runtime.disposed) {
        await runtime.server.dispose()
        runtime.server = null
        return
      }
      log(ctx, `已监听 ${runtime.server.actualPort}`)
    } catch (error) {
      runtime.serverError = serializeError(error)
      log(ctx, error && error.code === ERROR_CODES.PORT ? '端口被占用' : '监听失败')
      try { await runtime.server.dispose() } catch { /* 已失败 */ }
      runtime.server = null
    }
  } else {
    log(ctx, '仅客户端')
  }

  if (runtime.capabilities.serveEnabled) {
    cleanupResults({
      keep: runtime.config.qq.retentionKeep,
      minAgeMs: runtime.config.qq.retentionMinAgeMs,
    }).catch(() => {})
  }
  runtime.ensureQq()

  runtime.status = () => statusOf(runtime)
  runtime.dispatch = (args, signal) => {
    const normalized = normalizeTask(args, runtime.config)
    if (!normalized.task) throw remoteError(ERROR_CODES.REJECTED, normalized.error || '任务非法')
    return dispatchTask({ config: runtime.config, task: normalized.task, signal })
  }

  mountApi(ctx, runtime)
  registerTool(ctx, runtime)
  if (runtime.capabilities.mobile) registerSyncTool(ctx, runtime)
  registerPrompt(ctx, runtime)
  runtime.ensureReader()
}

function registerTool(ctx, runtime) {
  const install = (sub) => {
    const tools = serviceOf(sub, 'tools')
    if (!tools || typeof tools.register !== 'function') return
    sub.effect(() => tools.register({
      name: 'remote_execute',
      description: TOOL_DESCRIPTION,
      parameters: TOOL_PARAMETERS,
      output: {
        schema: TOOL_OUTPUT_SCHEMA,
        render: (_args, value) => [{ type: 'text', text: renderToolResult(value) }],
      },
      async execute(args, exec) {
        try {
          const result = await runtime.dispatch(args, exec && exec.signal)
          return {
            ok: true,
            taskId: result.taskId,
            exitCode: result.exitCode,
            signal: result.signal,
            timedOut: result.timedOut,
            durationMs: result.durationMs,
            stdout: result.stdout,
            stderr: result.stderr,
            worker: result.worker,
          }
        } catch (error) {
          return { ok: false, error: serializeError(error) }
        }
      },
    }), 'dsh-remote-worker: remote_execute')
  }
  const tools = serviceOf(ctx, 'tools')
  if (tools) install(ctx)
  else injectService(ctx, ['tools'], install)
}

function registerSyncTool(ctx, runtime) {
  const install = (sub) => {
    const tools = serviceOf(sub, 'tools')
    if (!tools || typeof tools.register !== 'function') return
    sub.effect(() => tools.register({
      name: 'sync_read_result',
      description: SYNC_TOOL_DESCRIPTION,
      parameters: SYNC_TOOL_PARAMETERS,
      output: {
        schema: TOOL_OUTPUT_SCHEMA,
        render: (_args, value) => [{ type: 'text', text: renderSyncResult(value) }],
      },
      async execute(args) {
        if (!runtime.reader) {
          return { ok: false, error: { code: 'SYNC_READ_UNAVAILABLE', message: '结果读取未启用' } }
        }
        try {
          return await runtime.reader.read(args && typeof args === 'object' ? args : {})
        } catch (error) {
          return {
            ok: false,
            error: {
              code: 'SYNC_READ_FAILED',
              message: error && error.message ? String(error.message).slice(0, 60) : '结果读取失败',
            },
          }
        }
      },
    }), 'dsh-remote-worker: sync_read_result')
  }
  const tools = serviceOf(ctx, 'tools')
  if (tools) install(ctx)
  else injectService(ctx, ['tools'], install)
}

function renderSyncResult(value) {
  if (value && value.ok === false) {
    return value.error && value.error.message ? String(value.error.message).slice(0, 15) : '结果读取失败'
  }
  if (!value || value.ok !== true || value.found !== true || !value.result) return '暂无同步结果'
  const result = value.result
  const lines = [
    `id ${result.id}`,
    `dedupeKey ${result.dedupeKey || ''}`,
    `createdAt ${result.createdAt || ''}`,
    `status ${result.status || ''}`,
    `exit ${result.exitCode === null || result.exitCode === undefined ? '?' : result.exitCode}`,
    `messageId ${result.messageId || ''}`,
    `sender ${result.sender || ''}`,
    `durationMs ${result.durationMs === undefined ? '' : result.durationMs}`,
  ]
  if (result.instruction) lines.push(`instruction ${result.instruction}`)
  if (result.error && result.error.code) lines.push(`${result.error.code} ${result.error.message || ''}`)
  if (result.stdout) {
    lines.push('[stdout]')
    lines.push(result.stdout)
  }
  if (result.stderr) {
    lines.push('[stderr]')
    lines.push(result.stderr)
  }
  if (result.fullSize !== undefined) {
    lines.push(`stdout ${Buffer.byteLength(result.stdout || '', 'utf8')}/${result.fullSize} bytes`)
    if (result.truncated === true) lines.push(`truncated true next offset ${result.nextOffset}`)
  }
  lines.push(`unread ${value.unread === undefined ? 0 : value.unread}`)
  return lines.join('\n')
}

function registerPrompt(ctx, runtime) {
  if (!runtime.capabilities.canDispatch) return
  const install = (sub) => {
    const systemPrompt = serviceOf(sub, 'systemPrompt')
    if (!systemPrompt || typeof systemPrompt.section !== 'function') return
    const base = typeof systemPrompt.getSectionOrder === 'function'
      ? systemPrompt.getSectionOrder('TOOL_GOAL')
      : null
    const order = Number.isFinite(base) ? base + 1 : 500
    const text = runtime.capabilities.mobile
      ? `${PROMPT}\n同步结果用 sync_read_result 读取。`
      : PROMPT
    sub.effect(() => systemPrompt.section({
      name: 'dsh-remote-worker',
      order,
      text,
    }), 'dsh-remote-worker: prompt')
  }
  const systemPrompt = serviceOf(ctx, 'systemPrompt')
  if (systemPrompt) install(ctx)
  else injectService(ctx, ['systemPrompt'], install)
}

function mountApi(ctx, runtime) {
  const install = (sub) => {
    const webServer = readWebServer(sub)
    if (!webServer || typeof webServer.register !== 'function') {
      runtime.webServerMissing = true
      log(ctx, '无 webServer，设置页停用')
      return
    }
    runtime.webServerMissing = false
    runtime.routesMounted = 0
    sub.effect(() => {
      const disposers = []
      const mount = (options) => {
        try {
          disposers.push(webServer.register(options))
          runtime.routesMounted += 1
        } catch (error) {
          if (!/duplicate/i.test(String(error && error.message))) throw error
          runtime.routesStale = true
          log(ctx, `路由冲突，跳过：${options.path}`)
        }
      }
      mount({
        kind: 'exact',
        path: API_BASE + '/status',
        handler: (req, res) => route(req, res, { GET: () => sendJson(res, 200, (liveRuntime() || runtime).status()) }),
      })
      mount({
        kind: 'exact',
        path: API_BASE + '/config',
        handler: (req, res) => route(req, res, {
          GET: () => sendJson(res, 200, { ok: true, config: publicConfig(liveRuntime() || runtime), status: (liveRuntime() || runtime).status() }),
          POST: async (request, response) => {
            const body = await readJsonBody(request)
            const result = await saveFromBody(liveRuntime() || runtime, body)
            sendJson(response, result.ok ? 200 : 400, result)
          },
        }),
      })
      mount({
        kind: 'exact',
        path: API_BASE + '/qq-remote',
        handler: (req, res) => route(req, res, {
          GET: async () => {
            if ((liveRuntime() || runtime).capabilities.serveEnabled) {
              sendJson(res, 200, { ok: true, ...(await qqTargetSnapshot(ctx, liveRuntime() || runtime)) })
              return
            }
            const remote = await readRemoteQqTarget((liveRuntime() || runtime).config)
            sendJson(res, 200, { ok: true, ...remote })
          },
          POST: async () => {
            const body = await readJsonBody(req)
            if ((liveRuntime() || runtime).capabilities.serveEnabled) {
              const snapshot = await applyQqTarget(ctx, liveRuntime() || runtime, body)
              sendJson(res, 200, { ok: true, ...snapshot })
              return
            }
            const remote = await writeRemoteQqTarget((liveRuntime() || runtime).config, body)
            sendJson(res, 200, { ok: true, ...remote })
          },
        }),
      })
      mount({
        kind: 'exact',
        path: API_BASE + '/workspaces',
        handler: (req, res) => route(req, res, {
          GET: async () => {
            const liveIds = agentIds(sub)
            const workspaces = await listWorkspaces({
              liveIds,
              extraCwd: (liveRuntime() || runtime).config.qq.cwd,
            })
            sendJson(res, 200, {
              ok: true,
              workspaces,
              selected: { cwd: (liveRuntime() || runtime).config.qq.cwd, sessionId: (liveRuntime() || runtime).config.qq.sessionId },
            })
          },
        }),
      })
      mount({
        kind: 'exact',
        path: API_BASE + '/token',
        handler: (req, res) => route(req, res, {
          POST: async () => {
            const token = generateToken()
            const next = normalizeConfig({ ...(liveRuntime() || runtime).config, token })
            await saveConfig(next);
            (liveRuntime() || runtime).config.token = token
            sendJson(res, 200, { ok: true, token })
          },
        }),
      })
      return () => {
        for (const dispose of disposers.reverse()) {
          try { if (typeof dispose === 'function') dispose() } catch { /* 已卸载 */ }
        }
      }
    }, 'dsh-remote-worker: api')
  }
  const webServer = serviceOf(ctx, 'webServer')
  if (webServer) install(ctx)
  else injectService(ctx, ['webServer'], install)
}

function route(req, res, methods) {
  if (!trusted(req)) {
    sendJson(res, 403, { ok: false, error: '跨源请求拒绝' })
    return undefined
  }
  const method = String(req.method || 'GET').toUpperCase()
  const handler = methods[method] || (method === 'HEAD' ? methods.GET : undefined)
  if (typeof handler !== 'function') {
    sendJson(res, 405, { ok: false, error: '方法不允许' })
    return undefined
  }
  return Promise.resolve()
    .then(() => handler(req, res))
    .catch((error) => {
      try { sendJson(res, 400, { ok: false, error: String(error.message || error).slice(0, 80) }) } catch { /* 已响应 */ }
    })
}

async function saveFromBody(runtime, body) {
  const source = body && typeof body === 'object' ? body : {}
  const allowed = [
    'role', 'port', 'token', 'peerHost', 'peerPort', 'workerName',
    'allowCommands', 'allowCwd', 'connectTimeoutMs', 'defaultTimeoutMs',
    'maxTaskMs', 'maxConcurrent', 'onOffline', 'qq', 'reader',
  ]
  const patch = {}
  for (const key of allowed) if (Object.hasOwn(source, key)) patch[key] = source[key]
  if (patch.qq && typeof patch.qq === 'object') {
    patch.qq = { ...runtime.config.qq, ...patch.qq }
  }
  if (patch.reader && typeof patch.reader === 'object') {
    patch.reader = { ...runtime.config.reader, ...patch.reader }
  }
  const next = normalizeConfig({ ...runtime.config, ...patch })
  if (next.role === 'host' && !runtime.capabilities.canServe) {
    return { ok: false, error: '角色不支持' }
  }
  if (next.role === 'client' && !runtime.capabilities.canDispatch) {
    return { ok: false, error: '角色不支持' }
  }
  const restartRequired = next.role !== runtime.config.role || next.port !== runtime.config.port
  try {
    await saveConfig(next)
  } catch (error) {
    return { ok: false, error: '配置写入失败', details: { cause: error.code || error.message } }
  }
  for (const key of allowed) {
    if (key === 'role' || key === 'port') continue
    runtime.config[key] = next[key]
  }
  try {
    runtime.ensureQq()
    runtime.ensureReader()
  } catch (error) {
    return { ok: true, restartRequired, config: configSummary(runtime.config), qqError: shortError(error) }
  }
  return { ok: true, restartRequired, config: configSummary(runtime.config) }
}

function publicConfig(runtime) {
  return {
    ...configSummary(runtime.config),
    token: runtime.config.token,
    qq: {
      ...configSummary(runtime.config).qq,
      appSecret: runtime.config.qq.appSecret,
      whitelist: runtime.config.qq.whitelist,
    },
    configPath: configPath(),
  }
}

function statusOf(runtime) {
  const serverHealth = runtime.server ? runtime.server.health() : null
  const addresses = listIPv6Addresses().map((item) => ({
    address: item.url,
    interface: item.interface,
    loopback: item.loopback,
    linkLocal: item.linkLocal,
    global: item.global,
  }))
  return {
    ok: true,
    role: runtime.role,
    configRole: runtime.config.role,
    version: runtime.version,
    capabilities: {
      canServe: runtime.capabilities.canServe,
      serveEnabled: runtime.capabilities.serveEnabled === true,
      canDispatch: runtime.capabilities.canDispatch,
      canSpawn: runtime.capabilities.canSpawn,
      mobile: runtime.capabilities.mobile,
      kind: runtime.capabilities.kind,
      platform: runtime.capabilities.platform,
      node: runtime.capabilities.node,
      ipv6: {
        available: runtime.capabilities.ipv6.bindAny,
        hasGlobal: runtime.capabilities.ipv6.hasGlobal,
        hasLinkLocal: runtime.capabilities.ipv6.hasLinkLocal,
        loopback: runtime.capabilities.ipv6.loopback,
      },
    },
    server: {
      enabled: runtime.capabilities.serveEnabled === true,
      listening: Boolean(serverHealth && serverHealth.ok),
      port: runtime.server ? runtime.server.actualPort : runtime.config.port,
      busy: serverHealth ? serverHealth.busy : 0,
      addresses,
      error: runtime.serverError,
    },
    config: configSummary(runtime.config),
    qq: runtime.qq
      ? runtime.qq.status()
      : {
          state: runtime.capabilities.serveEnabled ? 'disabled' : 'client-only',
          enabled: runtime.config.qq.enabled,
          configured: runtime.config.qq.appId !== '' && runtime.config.qq.appSecret !== '',
          skip: runtime.qqSkip || '',
        },
    reader: runtime.reader
      ? runtime.reader.status()
      : { enabled: false, dir: '', targetSessionId: '', unread: 0 },
    configPath: configPath(),
    startedAt: runtime.startedAt,
    routesStale: runtime.routesStale === true,
  }
}

function renderToolResult(value) {
  if (!value || typeof value !== 'object') return '远程执行无结果'
  if (value.ok) {
    const lines = [`exit ${value.exitCode === null ? '?' : value.exitCode}`]
    if (value.stdout) lines.push(value.stdout.replace(/\s+$/, ''))
    if (value.stderr) {
      lines.push('[stderr]')
      lines.push(value.stderr.replace(/\s+$/, ''))
    }
    return lines.join('\n')
  }
  const error = value.error && typeof value.error === 'object' ? value.error : { code: 'ERR_EXEC', message: '远程执行失败' }
  const lines = [`${error.code} ${error.message}`]
  if (error.fallback) lines.push(`fallback=${error.fallback}`)
  if (error.onOffline) lines.push(`onOffline=${error.onOffline}`)
  if (error.task) lines.push(`task=${JSON.stringify(error.task)}`)
  const details = error.details
  if (details && typeof details === 'object') {
    if (details.exitCode !== undefined) lines.push(`exit ${details.exitCode === null ? '?' : details.exitCode}`)
    if (details.stdout) {
      lines.push('[stdout]')
      lines.push(String(details.stdout).replace(/\s+$/, ''))
    }
    if (details.stderr) {
      lines.push('[stderr]')
      lines.push(String(details.stderr).replace(/\s+$/, ''))
    }
  }
  return lines.join('\n')
}

async function qqTargetSnapshot(ctx, runtime) {
  const liveIds = agentIds(ctx)
  let workspaces = []
  try {
    workspaces = await listWorkspaces({ liveIds, extraCwd: runtime.config.qq.cwd })
  } catch {
    workspaces = []
  }
  return {
    qq: {
      enabled: runtime.config.qq.enabled,
      mode: runtime.config.qq.mode,
      cwd: runtime.config.qq.cwd,
      sessionId: runtime.config.qq.sessionId,
      state: runtime.qq ? runtime.qq.status().state : 'stopped',
    },
    workspaces,
  }
}

async function applyQqTarget(ctx, runtime, patch) {
  const source = patch && typeof patch === 'object' ? patch : {}
  const cwd = typeof source.cwd === 'string' ? source.cwd.trim() : runtime.config.qq.cwd
  const sessionId = typeof source.sessionId === 'string' ? source.sessionId.trim() : runtime.config.qq.sessionId
  const next = {
    ...runtime.config,
    qq: { ...runtime.config.qq, cwd, sessionId },
  }
  const saved = await saveConfig(normalizeConfig(next))
  runtime.config = saved
  if (runtime.qq) runtime.qq.setConfig(saved.qq)
  log(ctx, 'QQ 目标已更新')
  return qqTargetSnapshot(ctx, runtime)
}

async function readRemoteQqTarget(config) {
  const response = await dispatchControl({ config, request: { type: 'cfg.get' } })
  return response
}

async function writeRemoteQqTarget(config, body) {
  const response = await dispatchControl({ config, request: { type: 'cfg.set', patch: body } })
  return response
}

function agentIds(ctx) {
  const agents = serviceOf(ctx, 'agents')
  if (!agents || typeof agents.list !== 'function') return []
  try {
    const list = agents.list() || []
    const ids = []
    for (const agent of list) {
      if (agent && typeof agent.id === 'string' && agent.id !== '') ids.push(agent.id)
    }
    return ids
  } catch {
    return []
  }
}

function readWebServer(ctx) {
  if (!ctx) return null
  let server = null
  try { server = ctx.webServer } catch { server = null }
  if (!server) server = serviceOf(ctx, 'webServer')
  if (!server || typeof server.register !== 'function') return null
  return server
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

function injectService(ctx, names, callback) {
  if (typeof ctx.inject === 'function') {
    try { ctx.inject(names, callback) } catch { /* 服务不可用 */ }
  }
}

function safeLogger(ctx) {
  const logger = ctx && ctx.logger
  if (!logger) return null
  return {
    info: (message) => { try { logger.info(message) } catch { /* 忽略 */ } },
  }
}

function log(ctx, message) {
  try {
    if (ctx && ctx.logger && typeof ctx.logger.info === 'function') {
      ctx.logger.info(`[dsh-remote-worker] ${message}`)
    }
  } catch { /* 忽略 */ }
}

function trusted(req) {
  const headers = req && req.headers ? req.headers : {}
  const origin = headers.origin
  if (typeof origin !== 'string' || origin === '' || origin === 'null') return true
  try {
    const parsed = new URL(origin)
    return String(headers.host || '').toLowerCase() === parsed.host.toLowerCase()
  } catch {
    return false
  }
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body == null ? null : body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

async function readJsonBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > 65536) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return {}
  const parsed = JSON.parse(text)
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
}
