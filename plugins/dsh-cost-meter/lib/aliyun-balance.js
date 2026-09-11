/** 千问 / 阿里云资金账户可用金（issue #98）。凭据仅用于服务端 ACS3 签名。 */
import { createHash, createHmac, randomUUID } from 'node:crypto'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { fetchWithRetry } from './net.js'

// API shape/endpoint: aliyun/alibabacloud-typescript-sdk, bssopenapi-20230930.
// Signature: https://help.aliyun.com/zh/sdk/product-overview/v3-request-structure-and-signature
export const ALIYUN_BALANCE_URL = 'https://business.aliyuncs.com/'
export const ALIYUN_BALANCE_CREDENTIAL_VARS = [
  'ALIBABA_CLOUD_ACCESS_KEY_ID',
  'ALIBABA_CLOUD_ACCESS_KEY_SECRET',
  'ALIBABA_CLOUD_SECURITY_TOKEN',
]
const MAX_BYTES = 262144
const hash = value => createHash('sha256').update(value).digest('hex')

export function signAliyunBalanceRequest(accessKeyId, accessKeySecret, securityToken = '', { now = new Date(), nonce = randomUUID() } = {}) {
  const headers = {
    'content-type': 'application/x-www-form-urlencoded',
    host: 'business.aliyuncs.com',
    'x-acs-action': 'GetFundAccountAvailableAmount',
    'x-acs-content-sha256': hash(''),
    'x-acs-date': now.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    'x-acs-signature-nonce': nonce,
    'x-acs-version': '2023-09-30',
  }
  if (securityToken) headers['x-acs-security-token'] = securityToken
  const keys = Object.keys(headers).sort()
  const signedHeaders = keys.join(';')
  const canonicalHeaders = keys.map(key => `${key}:${headers[key].trim()}\n`).join('')
  const canonical = ['POST', '/', '', canonicalHeaders, signedHeaders, hash('')].join('\n')
  const signature = createHmac('sha256', accessKeySecret).update(`ACS3-HMAC-SHA256\n${hash(canonical)}`).digest('hex')
  headers.Authorization = `ACS3-HMAC-SHA256 Credential=${accessKeyId},SignedHeaders=${signedHeaders},Signature=${signature}`
  headers.Accept = 'application/json'
  return { method: 'POST', headers, body: '', redirect: 'manual' }
}

const messages = {
  zh: {
    missing: '请配置阿里云 RAM AccessKey ID 和 AccessKey Secret（不是千问模型 API Key）',
    network: '阿里云余额网络请求失败，请稍后重试',
    redirect: '阿里云余额接口发生重定向，已拒绝转发凭据',
    permission: '阿里云余额鉴权失败，请检查 AccessKey、STS 有效期及 RAM 权限 bss:DescribeBillingAccount',
    http: '阿里云余额接口返回 HTTP {status}',
    payload: '阿里云余额响应无效或过大，请稍后重试',
    amount: '阿里云余额响应缺少有效的 AvailableAmount，未将其视为零余额',
    currency: '阿里云余额响应缺少受支持的币种（CNY / USD / EUR）',
  },
  en: {
    missing: 'Configure Alibaba Cloud RAM AccessKey ID and AccessKey Secret (not a Qianwen model API key)',
    network: 'Alibaba Cloud balance network request failed; please retry later',
    redirect: 'Alibaba Cloud balance redirect refused to protect credentials',
    permission: 'Alibaba Cloud balance authentication failed; check AccessKey, STS expiry and RAM permission bss:DescribeBillingAccount',
    http: 'Alibaba Cloud balance returned HTTP {status}',
    payload: 'Alibaba Cloud balance response is invalid or too large; please retry later',
    amount: 'Alibaba Cloud balance response has no valid AvailableAmount; it was not treated as zero',
    currency: 'Alibaba Cloud balance response has no supported currency (CNY / USD / EUR)',
  },
}
const failure = (locale, key, status = '') => new Error(messages[locale === 'en' ? 'en' : 'zh'][key].replace('{status}', String(status)))

export function parseAliyunBalance(data, locale = 'zh') {
  const raw = data?.AvailableAmount
  const text = typeof raw === 'string' ? raw.trim() : ''
  const amount = typeof raw === 'number' ? raw : /^[+-]?\d+(\.\d+)?$/.test(text) ? Number(text) : NaN
  if (!Number.isFinite(amount)) throw failure(locale, 'amount')
  if (!['CNY', 'USD', 'EUR'].includes(data?.Currency)) throw failure(locale, 'currency')
  // AvailableAmount 是可用金，包含信控/未结清款等因素；不能把它当成现金余额或消费额。
  return { remaining: amount, unit: data.Currency, maxBudget: null, spend: null }
}

async function resolveCredential(ctx, name) {
  try {
    const hit = await ctx?.get?.('credentials')?.resolve(credentialRef(name))
    if (typeof hit?.value === 'string' && hit.value.trim()) return hit.value.trim()
  } catch { /* 与现有余额 adapter 一致，回落环境变量。 */ }
  return String(process.env[name] ?? '').trim()
}

async function readPayload(response, locale) {
  if (Number(response.headers.get('content-length')) > MAX_BYTES) {
    await response.body?.cancel().catch(() => {})
    throw failure(locale, 'payload')
  }
  try {
    const parts = []
    let bytes = 0
    for await (const part of response.body) {
      bytes += part.length
      if (bytes > MAX_BYTES) throw failure(locale, 'payload')
      parts.push(part)
    }
    return JSON.parse(Buffer.concat(parts).toString('utf8'))
  } catch { throw failure(locale, 'payload') }
}

export async function queryAliyunBalance(ctx, config, { fetchImpl = fetch } = {}) {
  const locale = config?.locale
  const [ak, sk, token] = await Promise.all(ALIYUN_BALANCE_CREDENTIAL_VARS.map(name => resolveCredential(ctx, name)))
  if (!ak || !sk) throw Object.assign(failure(locale, 'missing'), { soft: true })
  let response
  try {
    // 每次网络重试重新生成时间戳与 nonce；URL、Action、body 均固定为只读账户查询。
    response = await fetchWithRetry(ALIYUN_BALANCE_URL, {}, {
      attempts: 2, timeoutMs: 15000,
      fetchImpl: (url, init) => fetchImpl(url, { ...signAliyunBalanceRequest(ak, sk, token), signal: init.signal }),
    })
  } catch { throw failure(locale, 'network') }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    if (response.status >= 300 && response.status < 400) throw failure(locale, 'redirect')
    if (response.status === 401 || response.status === 403) throw failure(locale, 'permission')
    throw failure(locale, 'http', response.status)
  }
  const data = await readPayload(response, locale)
  // 不把上游 Message/RequestId/账户身份下发浏览器；即使错误响应夹带余额也不能记作成功。
  if ((data?.Code && data.Code !== 'Success') || data?.Success === false) throw failure(locale, 'permission')
  return { label: config?.customBalance?.label || '千问 / 阿里云', ...parseAliyunBalance(data, locale) }
}
