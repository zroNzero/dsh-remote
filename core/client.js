import { ERROR_CODES, remoteError, shortMessage } from './errors.js'
import { hasIPv6Literal, stripBrackets } from './ipv6.js'
import { PROTOCOL_VERSION, WS_PATH } from './protocol.js'
import { connectWebSocket, WsConnectError } from './ws.js'

const STDERR_TAIL = 2048

export async function dispatchTask({ config, task, signal, onStdout, onStderr }) {
  const host = stripBrackets(config.peerHost)
  const params = {
    command: task.command,
    cwd: task.cwd || '',
    timeoutMs: task.timeoutMs || config.defaultTimeoutMs,
  }
  if (!hasIPv6Literal(host)) throw offlineError(config, params, '未配置 IPv6')
  let peer
  try {
    peer = await connectWebSocket({
      host,
      port: config.peerPort,
      path: WS_PATH,
      timeoutMs: config.connectTimeoutMs,
    })
  } catch (error) {
    const cause = error instanceof WsConnectError ? error.code : (error && error.code) || 'ECONNECT'
    throw offlineError(config, params, cause)
  }

  let finished = false
  let phase = 'welcome'
  let stdout = ''
  let stderr = ''
  const outStream = { next: 1, pending: new Map() }
  const errStream = { next: 1, pending: new Map() }
  const streams = { stdout: outStream, stderr: errStream }
  let worker = null
  let taskId = task.taskId || ''
  let abortListener = null

  const welcome = deferred()
  const ack = deferred()
  const exit = deferred()
  const all = [welcome, ack, exit]

  const closePeer = (code = 1000) => {
    if (!peer || peer.finished) return
    try { peer.sendClose(code) } catch { /* 已断开 */ }
    try { peer.socket.end() } catch { /* 已断开 */ }
    const timer = setTimeout(() => {
      try { peer.destroy() } catch { /* 已断开 */ }
    }, 300)
    if (typeof timer.unref === 'function') timer.unref()
  }

  const fail = (error) => {
    if (finished) return
    finished = true
    if (abortListener) {
      try { signal.removeEventListener('abort', abortListener) } catch { /* 忽略 */ }
      abortListener = null
    }
    for (const item of all) item.reject(error)
    closePeer(error.code === ERROR_CODES.AUTH ? 1008 : 1000)
  }

  const deliver = (stream, text) => {
    if (!text) return
    if (stream === 'stdout') {
      stdout += text
      if (onStdout) {
        try { onStdout(text) } catch { /* 回调不影响链路 */ }
      }
    } else {
      stderr += text
      if (onStderr) {
        try { onStderr(text) } catch { /* 回调不影响链路 */ }
      }
    }
  }

  const append = (streamName, sequence, data) => {
    if (!Number.isInteger(sequence) || sequence < 1 || typeof data !== 'string') return
    const state = streams[streamName]
    if (sequence < state.next) return
    if (sequence === state.next) {
      deliver(streamName, data)
      state.next += 1
      while (state.pending.has(state.next)) {
        deliver(streamName, state.pending.get(state.next))
        state.pending.delete(state.next)
        state.next += 1
      }
    } else {
      state.pending.set(sequence, data)
    }
  }

  const drain = (streamName) => {
    const state = streams[streamName]
    while (state.pending.has(state.next)) {
      deliver(streamName, state.pending.get(state.next))
      state.pending.delete(state.next)
      state.next += 1
    }
    return state.pending.size
  }

  peer.onmessage = (text) => {
    let message
    try {
      message = JSON.parse(text)
    } catch {
      fail(remoteError(ERROR_CODES.INTERRUPTED, '协议帧非法'))
      return
    }
    if (!message || typeof message !== 'object') return
    switch (message.type) {
      case 'welcome':
        if (message.v !== PROTOCOL_VERSION) {
          fail(remoteError(ERROR_CODES.REJECTED, '协议不匹配'))
          return
        }
        worker = message.worker || null
        phase = 'task'
        welcome.resolve(message)
        break
      case 'task.ack':
        if (message.taskId) taskId = message.taskId
        phase = 'running'
        ack.resolve(message)
        break
      case 'task.stdout':
        if (message.taskId === taskId || taskId === '') append('stdout', message.seq, message.data)
        break
      case 'task.stderr':
        if (message.taskId === taskId || taskId === '') append('stderr', message.seq, message.data)
        break
      case 'task.exit':
        if (message.taskId) taskId = message.taskId
        exit.resolve(message)
        break
      case 'error':
        fail(remoteError(message.code || ERROR_CODES.EXEC, message.message || shortMessage(message.code)))
        break
      default:
        break
    }
  }

  peer.onclose = () => {
    if (finished) return
    if (phase === 'welcome') fail(remoteError(ERROR_CODES.INTERRUPTED, '握手中断'))
    else if (phase === 'task') fail(remoteError(ERROR_CODES.INTERRUPTED, '提交中断'))
    else if (phase === 'running') fail(remoteError(ERROR_CODES.INTERRUPTED, '执行中断'))
  }

  if (signal) {
    abortListener = () => {
      try { peer.sendText(JSON.stringify({ type: 'task.cancel', taskId })) } catch { /* 已断开 */ }
      fail(remoteError(ERROR_CODES.INTERRUPTED, '已取消'))
    }
    if (signal.aborted) abortListener()
    else signal.addEventListener('abort', abortListener, { once: true })
  }

  try {
    peer.sendText(JSON.stringify({
      type: 'hello',
      v: PROTOCOL_VERSION,
      device: config.workerName,
      token: config.token,
    }))
    try {
      await waitFor(welcome, config.connectTimeoutMs)
    } catch (error) {
      if (error && error.code && error.code !== ERROR_CODES.TIMEOUT) throw error
      throw offlineError(config, params, error && error.code ? error.code : 'EHANDSHAKE')
    }
    phase = 'task'
    peer.sendText(JSON.stringify({ type: 'task.submit', ...task, taskId: taskId || undefined }))
    await waitFor(ack, 5000)
    phase = 'running'
    const rawExit = await waitFor(exit, params.timeoutMs + 2000)
    if (abortListener) {
      try { signal.removeEventListener('abort', abortListener) } catch { /* 忽略 */ }
      abortListener = null
    }
    finished = true
    const outGap = drain('stdout')
    const errGap = drain('stderr')
    closePeer(1000)
    if (outGap > 0 || errGap > 0) {
      throw remoteError(ERROR_CODES.INTERRUPTED, '流序号缺失')
    }
    const stderrTail = tail(stderr, STDERR_TAIL)
    const result = {
      taskId,
      exitCode: typeof rawExit.exitCode === 'number' ? rawExit.exitCode : null,
      signal: rawExit.signal || null,
      timedOut: Boolean(rawExit.timedOut),
      aborted: Boolean(rawExit.aborted),
      durationMs: Number(rawExit.durationMs) || 0,
      stdout,
      stderr: stderrTail,
      worker,
    }
    if (result.timedOut) throw remoteError(ERROR_CODES.TIMEOUT, '执行超时', { details: result })
    if (result.aborted) throw remoteError(ERROR_CODES.INTERRUPTED, '执行中断', { details: result })
    if (result.exitCode !== 0) {
      throw remoteError(ERROR_CODES.EXEC, result.signal ? `信号退出 ${result.signal}` : '命令非零退出', { details: result })
    }
    return result
  } catch (error) {
    if (!finished) {
      if (error && error.code === ERROR_CODES.TIMEOUT && phase === 'running') {
        try { peer.sendText(JSON.stringify({ type: 'task.cancel', taskId })) } catch { /* 已断开 */ }
      }
      fail(error instanceof Error ? error : remoteError(ERROR_CODES.INTERRUPTED, '执行中断'))
    }
    throw error
  }
}

export async function dispatchControl({ config, request, timeoutMs = 8000 }) {
  const host = stripBrackets(config.peerHost)
  if (!hasIPv6Literal(host)) throw remoteError(ERROR_CODES.OFFLINE, '未配置 IPv6')
  let peer
  try {
    peer = await connectWebSocket({
      host,
      port: config.peerPort,
      path: WS_PATH,
      timeoutMs: config.connectTimeoutMs,
    })
  } catch (error) {
    const cause = error instanceof WsConnectError ? error.code : (error && error.code) || 'ECONNECT'
    throw remoteError(ERROR_CODES.OFFLINE, '电脑端离线', { details: { cause } })
  }

  const welcome = deferred()
  const result = deferred()
  let finished = false
  const closePeer = () => {
    try { peer.sendClose(1000) } catch { /* 已断开 */ }
    try { peer.socket.end() } catch { /* 已断开 */ }
    const timer = setTimeout(() => { try { peer.destroy() } catch { /* 已断开 */ } }, 300)
    if (typeof timer.unref === 'function') timer.unref()
  }
  const fail = (error) => {
    if (finished) return
    finished = true
    welcome.reject(error)
    result.reject(error)
    closePeer()
  }

  peer.onmessage = (text) => {
    let message
    try {
      message = JSON.parse(text)
    } catch {
      fail(remoteError(ERROR_CODES.INTERRUPTED, '协议帧非法'))
      return
    }
    if (!message || typeof message !== 'object') return
    if (message.type === 'welcome') {
      if (message.v !== PROTOCOL_VERSION) {
        fail(remoteError(ERROR_CODES.REJECTED, '协议不匹配'))
        return
      }
      welcome.resolve(message)
      return
    }
    if (message.type === 'cfg.result') {
      finished = true
      result.resolve(message)
      closePeer()
      return
    }
    if (message.type === 'error') {
      fail(remoteError(message.code || ERROR_CODES.REJECTED, message.message || shortMessage(message.code)))
    }
  }
  peer.onclose = () => {
    if (finished) return
    fail(remoteError(ERROR_CODES.INTERRUPTED, '连接中断'))
  }

  try {
    peer.sendText(JSON.stringify({
      type: 'hello',
      v: PROTOCOL_VERSION,
      device: config.workerName,
      token: config.token,
    }))
    await waitFor(welcome, config.connectTimeoutMs)
    peer.sendText(JSON.stringify(request))
    const answer = await waitFor(result, timeoutMs)
    if (answer.ok !== true) {
      throw remoteError(ERROR_CODES.REJECTED, answer.error || '配置失败')
    }
    return answer
  } catch (error) {
    if (!finished) fail(error instanceof Error ? error : remoteError(ERROR_CODES.INTERRUPTED, '配置中断'))
    throw error
  }
}

function waitFor(deferredValue, timeoutMs) {
  let timer = null
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(remoteError(ERROR_CODES.TIMEOUT, '等待超时')), Math.max(1, timeoutMs))
    if (typeof timer.unref === 'function') timer.unref()
  })
  return Promise.race([deferredValue.promise, timeout]).finally(() => {
    if (timer !== null) clearTimeout(timer)
  })
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  promise.catch(() => {})
  return { promise, resolve, reject }
}

function offlineError(config, params, cause) {
  return remoteError(ERROR_CODES.OFFLINE, '电脑端离线', {
    fallback: 'offline_queue',
    task: { ...params },
    onOffline: typeof config.onOffline === 'string' ? config.onOffline : '',
    details: { cause },
  })
}

function tail(text, maxBytes) {
  if (typeof text !== 'string' || text.length === 0) return ''
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.length <= maxBytes) return text
  return buffer.subarray(buffer.length - maxBytes).toString('utf8')
}
