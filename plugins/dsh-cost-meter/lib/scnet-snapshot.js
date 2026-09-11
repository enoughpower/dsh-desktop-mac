import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { scnetPlanPeriod } from './coding-plans.js'

export const SCNET_SNAPSHOT_MAX_BYTES = 16 * 1024
export const SCNET_SNAPSHOT_MAX_AGE_MS = 24 * 60 * 60 * 1000

// ISO 时间必须携带时区；数字采用 Unix 毫秒，不猜测秒/毫秒或本地时区。
function timestamp(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 && value <= 8.64e15 ? value : NaN
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return NaN
  return Date.parse(value)
}

/** 外部采集器负责来源真实性；这里仅验证文件契约，不把本地 JSON 视为实时官方查询。 */
export function parseScnetSnapshot(value, entry, nowMs = Date.now(), locale = 'en') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const { used, total } = value
  if (typeof used !== 'number' || !Number.isFinite(used) || used < 0
    || typeof total !== 'number' || !Number.isFinite(total) || total <= 0) return null
  const fetchedAt = timestamp(value.fetchedAt ?? value.at)
  if (!Number.isFinite(fetchedAt) || fetchedAt > nowMs || nowMs - fetchedAt > SCNET_SNAPSHOT_MAX_AGE_MS) return null
  let resetsAt = ''
  if (value.resetsAt !== undefined && value.resetsAt !== '') {
    const reset = timestamp(value.resetsAt)
    if (!Number.isFinite(reset) || reset <= nowMs || reset <= fetchedAt) return null
    resetsAt = new Date(reset).toISOString()
  } else {
    // 没有官方重置时间时不伪造重置时刻，但不能跨过配置的本地周期沿用旧快照。
    const period = scnetPlanPeriod(nowMs, entry?.planStart)
    const capturedPeriod = scnetPlanPeriod(fetchedAt, entry?.planStart)
    if (capturedPeriod.resetsAt !== period.resetsAt) return null
  }
  const percent = Math.min(100, Math.round((used / total) * 1000) / 10)
  const fmt = n => n.toLocaleString('en-US', { maximumFractionDigits: 2 })
  const source = locale === 'zh' ? '外部控制台快照' : 'external console snapshot'
  return {
    fetchedAt,
    windows: {
      monthly: { percent, resetsAt },
      credits: { resetsAt: '', text: `${fmt(used)} / ${fmt(total)} Credits (${source})` },
    },
  }
}

/** 有界异步读取普通文件；损坏、更新中、缺失或不可读均交还原本的本地估算路径。 */
export async function readScnetSnapshot(path, entry, nowMs = Date.now(), locale = 'en') {
  let file
  try {
    file = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0))
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > SCNET_SNAPSHOT_MAX_BYTES) return null
    const buffer = Buffer.alloc(SCNET_SNAPSHOT_MAX_BYTES + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null)
      if (bytesRead === 0) break
      length += bytesRead
    }
    if (length > SCNET_SNAPSHOT_MAX_BYTES) return null
    return parseScnetSnapshot(JSON.parse(buffer.subarray(0, length).toString('utf8')), entry, nowMs, locale)
  } catch {
    return null
  } finally {
    await file?.close().catch(() => {})
  }
}
