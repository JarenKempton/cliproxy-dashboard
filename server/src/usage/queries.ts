// Read-side queries for the Usage page.

import { and, desc, eq, gte, sql, type SQL } from 'drizzle-orm'
import { alias, type SQLiteColumn, type SQLiteSelect } from 'drizzle-orm/sqlite-core'
import type { Db } from '../db/client'
import { machineIdentities, machines, requests, tailnetDevices } from '../db/schema'

export type Range = '24h' | '7d' | '30d'

const RANGE_MS: Record<Range, number> = { '24h': 24 * 3600e3, '7d': 7 * 86400e3, '30d': 30 * 86400e3 }
const BUCKET_MS: Record<Range, number> = { '24h': 3600e3, '7d': 86400e3, '30d': 86400e3 }

// --- Machine resolution --------------------------------------------------------
// A request's machine name, in order of preference:
//   1. the name you gave its proxy key
//   2. the name you gave its IP
//   3. its Tailscale device name
//   4. its IP, so unnamed machines are still distinguishable

const byKey = alias(machineIdentities, 'by_key')
const byIp = alias(machineIdentities, 'by_ip')
const keyMachine = alias(machines, 'key_machine')
const ipMachine = alias(machines, 'ip_machine')

const machineName = sql<string>`coalesce(${keyMachine.name}, ${ipMachine.name}, ${tailnetDevices.name}, ${requests.clientIp}, 'unknown')`

function joinMachines<T extends SQLiteSelect>(query: T) {
  return query
    .leftJoin(byKey, and(eq(byKey.kind, 'key'), eq(byKey.value, requests.clientKeyHash)))
    .leftJoin(keyMachine, eq(keyMachine.id, byKey.machineId))
    .leftJoin(byIp, and(eq(byIp.kind, 'ip'), eq(byIp.value, requests.clientIp)))
    .leftJoin(ipMachine, eq(ipMachine.id, byIp.machineId))
    .leftJoin(tailnetDevices, eq(tailnetDevices.ip, requests.clientIp))
}

// --- Aggregates ------------------------------------------------------------------

const totals = {
  requests: sql<number>`count(*)`,
  failed: sql<number>`coalesce(sum(${requests.failed}), 0)`,
  costMicros: sql<number>`coalesce(sum(${requests.costMicros}), 0)`,
  unpriced: sql<number>`coalesce(sum(${requests.costMicros} is null), 0)`,
  inputTokens: sql<number>`coalesce(sum(${requests.inputTokens}), 0)`,
  cacheReadTokens: sql<number>`coalesce(sum(${requests.cacheReadTokens}), 0)`,
  cacheWriteTokens: sql<number>`coalesce(sum(${requests.cacheWriteTokens}), 0)`,
  outputTokens: sql<number>`coalesce(sum(${requests.outputTokens}), 0)`,
}

// `tzOffsetMs` shifts bucket edges so hours and days line up with local time.
export function usageOverview(db: Db, range: Range, tzOffsetMs = 0, now = Date.now()) {
  const from = new Date(now - RANGE_MS[range])
  const bucketMs = BUCKET_MS[range]
  const inRange = gte(requests.occurredAt, from)

  // Totals grouped by one dimension, most expensive first.
  const groupedBy = (name: SQLiteColumn | SQL<string>) =>
    joinMachines(
      db
        .select({ name: sql<string>`coalesce(${name}, 'unknown')`, ...totals })
        .from(requests)
        .$dynamic(),
    )
      .where(inRange)
      .groupBy(name)
      .orderBy(desc(totals.costMicros))
      .all()

  const bucket = sql<number>`((${requests.occurredAt} + ${tzOffsetMs}) / ${bucketMs}) * ${bucketMs} - ${tzOffsetMs}`

  return {
    range,
    from: from.getTime(),
    bucketMs,
    totals: db.select(totals).from(requests).where(inRange).get(),
    series: db
      .select({ at: bucket, costMicros: totals.costMicros, requests: totals.requests })
      .from(requests)
      .where(inRange)
      .groupBy(bucket)
      .orderBy(bucket)
      .all(),
    byModel: groupedBy(requests.model),
    byMachine: groupedBy(machineName),
    byAccount: groupedBy(requests.accountLabel),
    byTool: groupedBy(requests.tool),
  }
}

export function recentRequests(db: Db, limit = 50) {
  return joinMachines(
    db
      .select({
        occurredAt: requests.occurredAt,
        model: requests.model,
        tool: requests.tool,
        account: requests.accountLabel,
        machine: machineName,
        failed: requests.failed,
        latencyMs: requests.latencyMs,
        inputTokens: requests.inputTokens,
        cacheReadTokens: requests.cacheReadTokens,
        cacheWriteTokens: requests.cacheWriteTokens,
        outputTokens: requests.outputTokens,
        costMicros: requests.costMicros,
      })
      .from(requests)
      .$dynamic(),
  )
    .orderBy(desc(requests.occurredAt))
    .limit(limit)
    .all()
}
