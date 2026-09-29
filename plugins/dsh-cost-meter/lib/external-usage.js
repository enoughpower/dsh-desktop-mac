import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { localDayKey, zeroDay } from './store.js'
import { costOf, providerPriceEntryFor, usdFromCost } from './pricing.js'

export const EXTERNAL_USAGE_MAX_BYTES = 512 * 1024
const MAX_AGE = 30 * 86400000
const FRESH_AGE = 86400000
const fields = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning', 'calls', 'cost', 'apiCost']
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v)
const count = v => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= 1e12
const money = v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1e9
const dateKey = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v + 'T00:00:00Z')) && new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) === v
const timestamp = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(v) && dateKey(v.slice(0, 10)) ? Date.parse(v) : NaN

function add(into, day) {
  for (const key of fields) into[key] += day[key]
}

function summary(days, dayKey) {
  const today = zeroDay(dayKey)
  const month = zeroDay(dayKey.slice(0, 7))
  const total = zeroDay('total')
  const history = Object.values(days).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 90)
  for (const day of Object.values(days)) {
    add(total, day)
    if (day.date.startsWith(dayKey.slice(0, 7))) add(month, day)
    if (day.date === dayKey) add(today, day)
  }
  return { today, month, total, history }
}

/** A snapshot replaces its predecessor; it never mutates the DSH ledger. */
export function parseExternalUsageSnapshot(value, config, nowMs = Date.now()) {
  if (!object(value)) return null
  if (Object.hasOwn(value, 'sources') && !Array.isArray(value.sources)) return null
  const fetchedAt = timestamp(value.fetchedAt)
  if (!Number.isFinite(fetchedAt) || fetchedAt > nowMs + 300000 || nowMs - fetchedAt > MAX_AGE) return null
  const entries = Array.isArray(value.sources) ? value.sources : [value]
  if (entries.length < 1 || entries.length > 8) return null
  const seen = new Set()
  const sources = []
  const combinedDays = {}
  let recordCount = 0
  for (const entry of entries) {
    if (!object(entry) || typeof entry.source !== 'string' || entry.source.length < 1 || entry.source.length > 64 || seen.has(entry.source)) return null
    seen.add(entry.source)
    if (object(entry.days) === Array.isArray(entry.records)) return null // exactly one input mode
    const days = {}
    if (object(entry.days)) {
      if (Object.keys(entry.days).length > 3660) return null
      for (const [date, raw] of Object.entries(entry.days)) {
        if (!dateKey(date) || date > localDayKey(nowMs) || !object(raw) || !count(raw.input) || !count(raw.output) || !count(raw.cached) || !count(raw.calls) || !money(raw.costUsd)) return null
        if (raw.cacheWrite !== undefined && !count(raw.cacheWrite)) return null
        if (raw.reasoning !== undefined && !count(raw.reasoning)) return null
        days[date] = { ...zeroDay(date), input: raw.input, output: raw.output, cacheRead: raw.cached, cacheWrite: raw.cacheWrite ?? 0, reasoning: raw.reasoning ?? 0, calls: raw.calls, cost: raw.costUsd, apiCost: raw.costUsd }
      }
    } else {
      recordCount += entry.records.length
      if (recordCount > 5000) return null
      const ids = new Set()
      for (const raw of entry.records) {
        if (!object(raw) || typeof raw.id !== 'string' || raw.id.length < 1 || raw.id.length > 128 || ids.has(raw.id)) return null
        ids.add(raw.id)
        const at = timestamp(raw.at)
        if (!Number.isFinite(at) || at > nowMs + 300000 || !count(raw.input) || !count(raw.output) || !count(raw.cached)) return null
        if (raw.cacheWrite !== undefined && !count(raw.cacheWrite)) return null
        if (raw.reasoning !== undefined && !count(raw.reasoning)) return null
        if (typeof raw.provider !== 'string' || !raw.provider || typeof raw.model !== 'string' || !raw.model) return null
        const resolved = providerPriceEntryFor(raw.provider, raw.model, config?.prices, {
          mode: config?.priceMatch === 'exact' ? 'exact' : 'auto', overrides: config?.priceOverrides,
        })
        if (!resolved.priced) return null
        const peak = { enabled: resolved.billingMode === 'deepseek-peak' && config?.peakEnabled === true,
          effectiveAtMs: Date.parse(config?.peakEffectiveAt ?? ''), windows: config?.peakWindows, holidays: config?.peakHolidays }
        const tokens = { input: raw.input, output: raw.output, cacheRead: raw.cached, cacheWrite: raw.cacheWrite ?? 0, reasoning: raw.reasoning ?? 0 }
        const priced = costOf(tokens, resolved.entry, at, peak)
        const usd = usdFromCost(priced, resolved.currency, config?.exchangeRate)
        const date = localDayKey(at)
        const day = days[date] ?? (days[date] = zeroDay(date))
        for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning']) day[key] += tokens[key]
        day.calls++
        day.cost += usd
        day.apiCost += usd
      }
    }
    for (const [date, day] of Object.entries(days)) add(combinedDays[date] ?? (combinedDays[date] = zeroDay(date)), day)
    sources.push({ source: entry.source, ...summary(days, localDayKey(nowMs)) })
  }
  return { fetchedAt, stale: nowMs - fetchedAt > FRESH_AGE, sources,
    combined: summary(combinedDays, localDayKey(nowMs)) }
}

/** Bounded, fail-closed read of a regular file. Producers should write a temp file and rename it. */
export async function readExternalUsageSnapshot(path, config, nowMs = Date.now()) {
  let file
  try {
    file = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0))
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > EXTERNAL_USAGE_MAX_BYTES) return null
    const buffer = Buffer.alloc(EXTERNAL_USAGE_MAX_BYTES + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null)
      if (!bytesRead) break
      length += bytesRead
    }
    if (length > EXTERNAL_USAGE_MAX_BYTES) return null
    return parseExternalUsageSnapshot(JSON.parse(buffer.subarray(0, length).toString('utf8')), config, nowMs)
  } catch { return null } finally { await file?.close().catch(() => {}) }
}

/** Fresh external usage participates in same-account balance reconciliation. */
export function externalTodayCostForReconcile(snapshot) {
  if (snapshot?.stale === true) return null
  const cost = snapshot?.combined?.today?.cost
  return Number.isFinite(cost) && cost >= 0 ? cost : 0
}
