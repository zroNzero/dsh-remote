import { qqError } from './errors.js'
import { requestJson } from './http.js'

export class QqAuth {
  constructor({ apiBase, tokenUrl, appId, appSecret, timeoutMs = 10000, logger = null }) {
    this.apiBase = apiBase
    this.tokenUrl = tokenUrl
    this.appId = appId
    this.appSecret = appSecret
    this.timeoutMs = timeoutMs
    this.logger = logger
    this.token = ''
    this.expiresAt = 0
    this.inflight = null
  }

  configured() {
    return this.appId !== '' && this.appSecret !== ''
  }

  status() {
    return {
      tokenSet: this.token !== '',
      expiresInSec: this.expiresAt > Date.now() ? Math.max(0, Math.round((this.expiresAt - Date.now()) / 1000)) : 0,
    }
  }

  clear() {
    this.token = ''
    this.expiresAt = 0
  }

  async getToken(force = false) {
    if (!this.configured()) throw qqError('QQ_UNCONFIGURED', 'QQ 未配置')
    if (!force && this.token !== '' && Date.now() < this.expiresAt) return this.token
    if (this.inflight) return this.inflight
    this.inflight = this.fetchToken().finally(() => { this.inflight = null })
    return this.inflight
  }

  async fetchToken() {
    const response = await requestJson({
      method: 'POST',
      url: this.tokenUrl,
      body: { appId: this.appId, clientSecret: this.appSecret },
      timeoutMs: this.timeoutMs,
      headers: { Accept: 'application/json' },
    })
    const body = response.data || {}
    const token = typeof body.access_token === 'string' ? body.access_token : ''
    const expires = Number(body.expires_in)
    if (token === '') throw qqError('QQ_TOKEN', 'QQ token 缺失')
    const lifetime = Number.isFinite(expires) && expires > 0 ? expires : 7200
    this.token = token
    this.expiresAt = Date.now() + Math.max(30, lifetime - 60) * 1000
    this.log('QQ token 已刷新')
    return token
  }

  async getGateway() {
    let token = await this.getToken()
    let response
    try {
      response = await this.gatewayRequest(token)
    } catch (error) {
      if (error && error.status === 401) {
        this.clear()
        token = await this.getToken(true)
        response = await this.gatewayRequest(token)
      } else {
        throw error
      }
    }
    const url = typeof response.data?.url === 'string' ? response.data.url : ''
    if (url === '') throw qqError('QQ_GATEWAY', 'QQ 网关缺失')
    return { url, token }
  }

  gatewayRequest(token) {
    return requestJson({
      method: 'GET',
      url: `${this.apiBase}/gateway`,
      headers: {
        Authorization: `QQBot ${token}`,
        Accept: 'application/json',
      },
      timeoutMs: this.timeoutMs,
    })
  }

  log(message) {
    try {
      if (this.logger && typeof this.logger.info === 'function') this.logger.info(`[dsh-remote-worker] ${message}`)
    } catch { /* 忽略 */ }
  }
}
