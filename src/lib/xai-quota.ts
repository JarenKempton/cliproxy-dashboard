// Grok (xAI) quota windows, parsed from the billing endpoint the Grok Build
// CLI reads (cli-chat-proxy.grok.com/v1/billing?format=credits).

import { QuotaUnavailableError, type QuotaWindow } from './quota-types'

const DAY = 86400e3
const WEEK = 7 * DAY

const parseTime = (s: unknown) => {
  const ms = typeof s === 'string' && s ? Date.parse(s) : NaN
  return Number.isNaN(ms) ? null : ms
}

type XaiPeriod = { type?: string; start?: string; end?: string }

// proto3 JSON: zero values are omitted, and int64 cents may arrive as strings.
type Cents = { val?: number | string }

export type XaiConfig = {
  currentPeriod?: XaiPeriod
  creditUsagePercent?: number
  // Legacy GrokBuildBillingConfig shape.
  monthlyLimit?: Cents
  used?: Cents
  billingPeriodStart?: string
  billingPeriodEnd?: string
}

function usedPercent(c: XaiConfig): number | null {
  if (typeof c.creditUsagePercent === 'number' && Number.isFinite(c.creditUsagePercent)) return c.creditUsagePercent
  const limit = Number(c.monthlyLimit?.val)
  if (limit > 0) return (Number(c.used?.val ?? 0) / limit) * 100
  // A current period without a percentage means nothing used yet.
  return c.currentPeriod ? 0 : null
}

export function xaiWindows(c: XaiConfig): QuotaWindow[] {
  const used = usedPercent(c)
  if (used === null) throw new QuotaUnavailableError('xAI returned no usage percentages.')

  const period = c.currentPeriod ?? { start: c.billingPeriodStart, end: c.billingPeriodEnd }
  const start = parseTime(period.start)
  const resetAtMs = parseTime(period.end) ?? parseTime(c.billingPeriodEnd)
  const lengthMs = start !== null && resetAtMs !== null && resetAtMs > start ? resetAtMs - start : null
  const days = lengthMs === null ? null : Math.round(lengthMs / DAY)

  const window = (id: string, label: string, periodMs: number): QuotaWindow[] => [{ id, label, usedPercent: used, resetAtMs, periodMs }]
  if (period.type === 'USAGE_PERIOD_TYPE_WEEKLY') return window('weekly', 'Weekly', WEEK)
  if (period.type === 'USAGE_PERIOD_TYPE_MONTHLY') return window('monthly', 'Monthly', lengthMs ?? 30 * DAY)
  if (lengthMs === null || days === 7) return window('weekly', 'Weekly', WEEK)
  if (days! >= 28) return window('monthly', 'Monthly', lengthMs)
  return window('window', `${days}-day`, lengthMs)
}
