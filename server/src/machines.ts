// Naming the machines behind requests.
//
// A machine is recognized by an identity: the proxy key it uses (stored as a
// short hash) or its IP. Identities you name are stored in machines /
// machine_identities; unnamed tailnet IPs fall back to their Tailscale name.

import { and, eq, isNotNull, notExists, sql } from 'drizzle-orm'
import type { Db } from './db/client'
import { machineIdentities, machines, requests, tailnetDevices } from './db/schema'

export type IdentityKind = 'key' | 'ip'

export type Device = {
  kind: IdentityKind
  value: string
  name: string | null // effective name for this identity alone
  nameSource: 'custom' | 'tailscale' | null
  tailscale: { name: string; os: string | null; online: boolean | null; isSelf: boolean } | null
  requests: number
  costMicros: number
  lastSeen: number | null
  userAgent: string | null
}

// Every identity that has sent requests or been named, with its name and activity.
export function listDevices(db: Db): Device[] {
  const activity = (column: typeof requests.clientKeyHash | typeof requests.clientIp) =>
    db
      .select({
        value: sql<string>`${column}`,
        requests: sql<number>`count(*)`,
        costMicros: sql<number>`coalesce(sum(${requests.costMicros}), 0)`,
        lastSeen: sql<number>`max(${requests.occurredAt})`,
        userAgent: sql<string | null>`max(${requests.userAgent})`,
      })
      .from(requests)
      .where(isNotNull(column))
      .groupBy(column)
      .all()

  const named = db
    .select({ kind: machineIdentities.kind, value: machineIdentities.value, name: machines.name })
    .from(machineIdentities)
    .innerJoin(machines, eq(machines.id, machineIdentities.machineId))
    .all()
  const nameOf = new Map(named.map((n) => [`${n.kind}:${n.value}`, n.name]))
  const tailnet = new Map(db.select().from(tailnetDevices).all().map((d) => [d.ip, d]))

  const devices = new Map<string, Device>()
  const upsert = (kind: IdentityKind, value: string, stats?: ReturnType<typeof activity>[number]) => {
    const custom = nameOf.get(`${kind}:${value}`) ?? null
    const ts = kind === 'ip' ? tailnet.get(value) : undefined
    devices.set(`${kind}:${value}`, {
      kind,
      value,
      name: custom ?? ts?.name ?? null,
      nameSource: custom ? 'custom' : ts ? 'tailscale' : null,
      tailscale: ts ? { name: ts.name, os: ts.os, online: ts.online, isSelf: ts.isSelf } : null,
      requests: stats?.requests ?? 0,
      costMicros: stats?.costMicros ?? 0,
      lastSeen: stats?.lastSeen ?? null,
      userAgent: stats?.userAgent ?? null,
    })
  }

  for (const row of activity(requests.clientKeyHash)) upsert('key', row.value, row)
  for (const row of activity(requests.clientIp)) upsert('ip', row.value, row)
  for (const n of named) if (!devices.has(`${n.kind}:${n.value}`)) upsert(n.kind, n.value)

  return [...devices.values()].sort((a, b) => (b.lastSeen ?? 0) - (a.lastSeen ?? 0))
}

// Gives an identity a name. Identities sharing a name are one machine.
export function nameIdentity(db: Db, kind: IdentityKind, value: string, name: string) {
  db.transaction((tx) => {
    const existing = tx.select().from(machines).where(eq(machines.name, name)).get()
    const machine = existing ?? tx.insert(machines).values({ name, createdAt: new Date() }).returning().get()
    tx.insert(machineIdentities)
      .values({ kind, value, machineId: machine.id })
      .onConflictDoUpdate({ target: [machineIdentities.kind, machineIdentities.value], set: { machineId: machine.id } })
      .run()
    deleteUnusedMachines(tx)
  })
}

// Removes a custom name; the identity falls back to its Tailscale name or IP.
export function clearIdentityName(db: Db, kind: IdentityKind, value: string) {
  db.transaction((tx) => {
    tx.delete(machineIdentities)
      .where(and(eq(machineIdentities.kind, kind), eq(machineIdentities.value, value)))
      .run()
    deleteUnusedMachines(tx)
  })
}

function deleteUnusedMachines(tx: Pick<Db, 'delete' | 'select'>) {
  tx.delete(machines)
    .where(notExists(tx.select().from(machineIdentities).where(eq(machineIdentities.machineId, machines.id))))
    .run()
}
