import { createHash } from 'node:crypto'
import { DEFAULT_PROVIDER_PRICE_TABLE, OPENROUTER_MODELS_URL, normalizePrice, parseOpenRouterModels } from './pricing.js'
import { applyConfigPatch, repairLedgerPricing } from './store.js'
import { fetchWithRetry, readJsonBounded } from './net.js'

const MIGRATION = 'pricing-openrouter-v1'
const fingerprint = raw => {
  const entry = normalizePrice(raw)
  if (!entry) return null
  const { sourceUrl, checkedAt, notes, ...rates } = entry
  return createHash('sha256').update(JSON.stringify(rates)).digest('hex')
}
const baseline = (ledger, id) => ledger.openrouterPriceHashes?.[id]
  ?? fingerprint(DEFAULT_PROVIDER_PRICE_TABLE.openrouter.models[id])
const managed = (ledger, id, entry) => baseline(ledger, id) === fingerprint(entry)

/** 只估算 OpenRouter 零费用桶；已记金额、其他厂商和显式映射保持原样。 */
export function repairOpenRouterLedger(ledger) {
  if (ledger.migrations.includes(MIGRATION)) return { recostedBuckets: 0 }
  return repairLedgerPricing(ledger, (key, bucket) => {
    const sep = key.indexOf(':')
    if (!['openrouter', 'llm-openrouter'].includes(key.slice(0, sep)) || Number(bucket.cost) !== 0) return false
    const id = key.slice(sep + 1), entry = ledger.config.prices?.providers?.openrouter?.models?.[id]
    if (Object.hasOwn(ledger.config.priceOverrides ?? {}, 'openrouter:' + id)) return false
    return !!entry && managed(ledger, id, entry)
  })
}

/** 每个账本共享一次在途请求；总超时覆盖响应体，卸载取消并阻止迟到写入。 */
export function createOpenRouterPriceRefresh(ledger, { fetchImpl, timeoutMs = 20000 } = {}) {
  let active = true, pending = null, controller = null
  const refresh = () => {
    if (!active || ledger.closed) return Promise.reject(new Error('OpenRouter price refresh disposed'))
    if (pending) return pending
    controller = new AbortController()
    const signal = controller.signal
    const timer = setTimeout(() => controller?.abort(new Error('OpenRouter price refresh timed out')), timeoutMs)
    timer.unref?.()
    pending = (async () => {
      const response = await fetchWithRetry(OPENROUTER_MODELS_URL, {
        headers: { 'user-agent': 'dsh-cost-meter (DeepSeek Harness plugin)' }, redirect: 'error', signal,
      }, { attempts: 2, fetchImpl })
      if (!response.ok) {
        try { await response.body?.cancel?.() } catch {}
        throw new Error(`HTTP ${response.status}`)
      }
      const { models } = parseOpenRouterModels(await readJsonBounded(response, 4 * 1024 * 1024))
      signal.throwIfAborted()
      if (!active || ledger.closed) throw new Error('OpenRouter price refresh disposed')
      // 网络等待后读取当前配置，保留期间的其他设置改动；手改价格不被覆盖。
      const previous = ledger.config.prices?.providers?.openrouter?.models ?? {}
      const merged = { ...previous }, hashes = { ...ledger.openrouterPriceHashes }
      let count = 0
      for (const [id, raw] of Object.entries(models)) {
        const entry = normalizePrice(raw)
        if (!entry) continue
        if (Object.hasOwn(previous, id) ? !managed(ledger, id, previous[id]) : hashes[id] !== undefined) continue
        merged[id] = { ...entry, ...(previous[id]?.notes ? { notes: previous[id].notes } : {}) }
        hashes[id] = fingerprint(entry)
        count++
      }
      const { config, errors } = applyConfigPatch(ledger.config, { prices: {
        ...ledger.config.prices,
        providers: { ...ledger.config.prices?.providers, openrouter: { models: merged } },
      } })
      if (errors.length) throw new Error(errors.join(';'))
      ledger.config = config
      ledger.openrouterPriceHashes = hashes
      // 离线启动只做快照范围的修复；首次目录成功后再完成迁移，避免永久漏掉其余模型。
      const repaired = repairOpenRouterLedger(ledger)
      if (!ledger.migrations.includes(MIGRATION)) ledger.migrations.push(MIGRATION)
      ledger.scheduleWrite()
      return { count, ...repaired }
    })().finally(() => { clearTimeout(timer); pending = null; controller = null })
    return pending
  }
  return { refresh, dispose() { active = false; controller?.abort(new Error('OpenRouter price refresh disposed')) } }
}
