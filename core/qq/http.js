import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { qqError } from './errors.js'

export function requestJson({
  method = 'GET',
  url,
  headers = {},
  body,
  timeoutMs = 10000,
  signal,
  maxBytes = 1024 * 1024,
}) {
  return new Promise((resolve, reject) => {
    let parsed
    try {
      parsed = new URL(url)
    } catch {
      reject(qqError('QQ_BAD_URL', 'QQ 地址非法'))
      return
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      reject(qqError('QQ_BAD_URL', 'QQ 协议不支持'))
      return
    }
    const secure = parsed.protocol === 'https:'
    const payload = body === undefined
      ? undefined
      : (typeof body === 'string' ? body : JSON.stringify(body))
    const requestHeaders = { ...headers }
    if (payload !== undefined && requestHeaders['Content-Type'] === undefined && requestHeaders['content-type'] === undefined) {
      requestHeaders['Content-Type'] = 'application/json'
    }
    if (requestHeaders['Content-Length'] === undefined && requestHeaders['content-length'] === undefined && payload !== undefined) {
      requestHeaders['Content-Length'] = Buffer.byteLength(payload)
    }
    let settled = false
    let timer = null
    const finish = (error, value) => {
      if (settled) return
      settled = true
      if (timer !== null) clearTimeout(timer)
      if (signal) {
        try { signal.removeEventListener('abort', onAbort) } catch { /* 忽略 */ }
      }
      if (error) reject(error)
      else resolve(value)
    }
    const onAbort = () => {
      try { req.destroy(qqError('QQ_ABORTED', 'QQ 请求取消')) } catch { /* 忽略 */ }
    }
    const requestFn = secure ? httpsRequest : httpRequest
    const req = requestFn({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || (secure ? 443 : 80),
      path: `${parsed.pathname}${parsed.search}`,
      method,
      headers: requestHeaders,
      servername: secure ? parsed.hostname : undefined,
    })
    if (signal) {
      if (signal.aborted) {
        onAbort()
        finish(qqError('QQ_ABORTED', 'QQ 请求取消'))
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }
    timer = setTimeout(() => {
      try { req.destroy(qqError('QQ_TIMEOUT', 'QQ 请求超时')) } catch { /* 忽略 */ }
    }, timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
    req.on('response', (response) => {
      const chunks = []
      let size = 0
      response.on('data', (chunk) => {
        if (settled) return
        size += chunk.length
        if (size > maxBytes) {
          finish(qqError('QQ_BODY_LARGE', 'QQ 响应过大'))
          try { response.destroy() } catch { /* 忽略 */ }
          return
        }
        chunks.push(chunk)
      })
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let data = null
        try { data = text === '' ? null : JSON.parse(text) } catch { data = null }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          finish(qqError('QQ_HTTP', 'QQ 接口拒绝', {
            status: response.statusCode,
            cause: text.slice(0, 200),
          }))
          return
        }
        finish(null, { status: response.statusCode, headers: response.headers, text, data })
      })
      response.on('error', (error) => finish(qqError('QQ_HTTP', 'QQ 响应失败', { cause: error.code || error.message })))
    })
    req.on('error', (error) => {
      if (error instanceof Error && error.code === 'QQ_ABORTED') finish(error)
      else finish(qqError('QQ_HTTP', 'QQ 请求失败', { cause: error.code || error.message }))
    })
    req.end(payload)
  })
}
