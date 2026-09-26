// Usage summary for the dashboard. Definitions follow T3 Code's usage view:
//
// - Processed tokens = uncached input + cached input + cache writes + output.
//   Reasoning is part of output, never added on top.
// - Cache savings = cache reads priced at (input rate − cache read rate).
// - Unpriced = share of requests with no known price (not of tokens or dollars).
// - Sessions = distinct session ids per tool with activity in the window.
// - Days are the viewer's local days; "7d" means today and the 6 days before;
//   "all" starts on the day of the earliest stored request.

import { and, eq, gte, isNotNull, min, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/sqlite-core'
import type { Db } from '../db/client'
import { machineIdentities, machines, requests, tailnetDevices } from '../db/schema'

export type Range = '24h' | '7d' | '30d' | '90d' | 'all'
export const RANGES: Range[] = ['24h', '7d', '30d', '90d', 'all']
const RANGE_DAYS: Record<'7d' | '30d' | '90d', number> = { '7d': 7, '30d': 30, '90d': 90 }
const HOUR = 3600e3

export type Totals = {
  costMicros: number
  cacheSavingsMicros: number
  records: number
  unpricedRecords: number
  uncachedTokens: number
  cachedTokens: number
  cacheWriteTokens: number
  outputTokens: number
  processedTokens: number
}

const emptyTotals = (): Totals => ({
  costMicros: 0,
  cacheSavingsMicros: 0,
  records: 0,
  unpricedRecords: 0,
  uncachedTokens: 0,
  cachedTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
  processedTokens: 0,
})

const TOTAL_KEYS = Object.keys(emptyTotals()) as (keyof Totals)[]

// Adds g's totals into acc (only the numeric totals; acc may carry labels too).
function addTo(acc: Totals, g: Totals) {
  for (const key of TOTAL_KEYS) acc[key] += g[key]
}

// --- Time window -----------------------------------------------------------------

// Local calendar day of an instant, as "YYYY-MM-DD".
function dayKeyFormatter(timeZone: string) {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
  return (ms: number) => fmt.format(ms)
}

// The previous calendar day of a "YYYY-MM-DD" key (pure date math, no time zones).
function previousDay(key: string) {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10)
}

type Window = {
  startMs: number // first instant included
  bucket: 'hour' | 'day'
  keys: (number | string)[] // every bucket in order, including empty ones
  keyOf: (ms: number) => number | string
}

function windowFor(range: Range, timeZone: string, now: number, earliestMs: number | null): Window {
  if (range === '24h') {
    const currentHour = Math.floor(now / HOUR) * HOUR
    const startMs = currentHour - 23 * HOUR
    return {
      startMs,
      bucket: 'hour',
      keys: Array.from({ length: 24 }, (_, i) => startMs + i * HOUR),
      keyOf: (ms) => Math.floor(ms / HOUR) * HOUR,
    }
  }

  const dayOf = dayKeyFormatter(timeZone)
  const keys = [dayOf(now)]
  if (range === 'all') {
    const firstDay = dayOf(earliestMs ?? now)
    while (keys[0] > firstDay) keys.unshift(previousDay(keys[0]))
  } else {
    while (keys.length < RANGE_DAYS[range]) keys.unshift(previousDay(keys[0]))
  }

  // First whole hour that falls on the first day of the window.
  let startMs = Math.floor((now - (keys.length + 1) * 86400e3) / HOUR) * HOUR
  while (dayOf(startMs) < keys[0]) startMs += HOUR
  return { startMs, bucket: 'day', keys, keyOf: dayOf }
}

// --- Machine names ---------------------------------------------------------------
// Preference: dedicated key name > custom IP name > Tailscale name > IP.

const byKey = alias(machineIdentities, 'by_key')
const byIp = alias(machineIdentities, 'by_ip')
const keyMachine = alias(machines, 'key_machine')
const ipMachine = alias(machines, 'ip_machine')

const machine = {
  name: sql<string>`coalesce(${keyMachine.name}, ${ipMachine.name}, ${tailnetDevices.name}, ${requests.clientIp}, 'unknown')`,
  nameSource: sql<'custom' | 'tailscale' | null>`case
    when ${keyMachine.name} is not null or ${ipMachine.name} is not null then 'custom'
    when ${tailnetDevices.name} is not null then 'tailscale' end`,
  // The identity a rename applies to: the dedicated key if there is one, else the IP.
  identityKind: sql<'key' | 'ip'>`case when ${keyMachine.name} is not null then 'key' else 'ip' end`,
  identityValue: sql<string | null>`case when ${keyMachine.name} is not null then ${requests.clientKeyHash} else ${requests.clientIp} end`,
}

// --- Summary ---------------------------------------------------------------------

export function usageSummary(db: Db, range: Range, timeZone: string, now = Date.now()) {
  const earliest = db.select({ at: min(requests.occurredAt) }).from(requests).get()?.at
  const window = windowFor(range, timeZone, now, earliest ? earliest.getTime() : null)
  const inWindow = gte(requests.occurredAt, new Date(window.startMs))

  // One row per hour × tool × model × account × machine; everything else is
  // built from these.
  const hour = sql<number>`(${requests.occurredAt} / ${HOUR}) * ${HOUR}`
  const tool = sql<string>`coalesce(${requests.tool}, 'other')`
  const account = sql<string>`coalesce(${requests.accountLabel}, 'unknown')`
  const groups = db
    .select({
      hour,
      tool,
      model: requests.model,
      account,
      ...machine,
      costMicros: sql<number>`coalesce(sum(${requests.costMicros}), 0)`,
      cacheSavingsMicros: sql<number>`coalesce(sum(${requests.cacheSavingsMicros}), 0)`,
      records: sql<number>`count(*)`,
      unpricedRecords: sql<number>`coalesce(sum(${requests.costMicros} is null), 0)`,
      uncachedTokens: sql<number>`coalesce(sum(${requests.inputTokens}), 0)`,
      cachedTokens: sql<number>`coalesce(sum(${requests.cacheReadTokens}), 0)`,
      cacheWriteTokens: sql<number>`coalesce(sum(${requests.cacheWriteTokens}), 0)`,
      outputTokens: sql<number>`coalesce(sum(${requests.outputTokens}), 0)`,
    })
    .from(requests)
    .leftJoin(byKey, and(eq(byKey.kind, 'key'), eq(byKey.value, requests.clientKeyHash)))
    .leftJoin(keyMachine, eq(keyMachine.id, byKey.machineId))
    .leftJoin(byIp, and(eq(byIp.kind, 'ip'), eq(byIp.value, requests.clientIp)))
    .leftJoin(ipMachine, eq(ipMachine.id, byIp.machineId))
    .leftJoin(tailnetDevices, eq(tailnetDevices.ip, requests.clientIp))
    .where(inWindow)
    .groupBy(hour, tool, requests.model, account, machine.name, machine.identityKind, machine.identityValue)
    .all()
    .map((g) => ({ ...g, processedTokens: g.uncachedTokens + g.cachedTokens + g.cacheWriteTokens + g.outputTokens }))

  const sessions = db
    .select({ tool, sessions: sql<number>`count(distinct ${requests.sessionId})` })
    .from(requests)
    .where(and(inWindow, isNotNull(requests.sessionId)))
    .groupBy(tool)
    .all()
  const sessionsOf = new Map(sessions.map((s) => [s.tool, s.sessions]))

  const totals = emptyTotals()
  const tools = new Map<string, Totals>()
  const models = new Map<string, Totals & { tool: string; model: string }>()
  const accounts = new Map<string, Totals & { name: string }>()
  const machinesByName = new Map<
    string,
    Totals & { name: string; nameSource: 'custom' | 'tailscale' | null; identities: { kind: 'key' | 'ip'; value: string }[] }
  >()
  const series = new Map<number | string, Map<string, { costMicros: number; tokens: number }>>(
    window.keys.map((k) => [k, new Map()]),
  )

  for (const g of groups) {
    addTo(totals, g)
    addTo(getOr(tools, g.tool, emptyTotals), g)
    addTo(getOr(models, `${g.tool}\u0000${g.model}`, () => ({ ...emptyTotals(), tool: g.tool, model: g.model })), g)
    addTo(getOr(accounts, g.account, () => ({ ...emptyTotals(), name: g.account })), g)

    const m = getOr(machinesByName, g.name, () => ({ ...emptyTotals(), name: g.name, nameSource: g.nameSource, identities: [] }))
    addTo(m, g)
    if (g.identityValue && !m.identities.some((i) => i.kind === g.identityKind && i.value === g.identityValue)) {
      m.identities.push({ kind: g.identityKind, value: g.identityValue })
    }

    const bucket = series.get(window.keyOf(g.hour))
    if (bucket) {
      const point = getOr(bucket, g.tool, () => ({ costMicros: 0, tokens: 0 }))
      point.costMicros += g.costMicros
      point.tokens += g.processedTokens
    }
  }

  const byCost = <T extends Totals>(a: T, b: T) => b.costMicros - a.costMicros || b.processedTokens - a.processedTokens

  return {
    range,
    timeZone,
    bucket: window.bucket,
    totals: { ...totals, sessions: sessions.reduce((n, s) => n + s.sessions, 0) },
    tools: [...tools].map(([name, t]) => ({ tool: name, sessions: sessionsOf.get(name) ?? 0, ...t })).sort(byCost),
    series: [...series].map(([key, byTool]) => ({ key, tools: Object.fromEntries(byTool) })),
    byModel: [...models.values()].sort(byCost),
    byMachine: [...machinesByName.values()].sort(byCost),
    byAccount: [...accounts.values()].sort(byCost),
  }
}

export type UsageSummary = ReturnType<typeof usageSummary>

function getOr<K, V>(map: Map<K, V>, key: K, create: () => V): V {
  let value = map.get(key)
  if (value === undefined) map.set(key, (value = create()))
  return value
}
