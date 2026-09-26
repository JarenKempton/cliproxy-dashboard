// Naming the machines behind requests.

import { desc, eq, isNotNull, sql } from 'drizzle-orm'
import type { Db } from './db/client'
import { machineIdentities, machines, requests } from './db/schema'

export type IdentityKind = 'key' | 'ip'

export function listMachines(db: Db) {
  const rows = db
    .select({ id: machines.id, name: machines.name, kind: machineIdentities.kind, value: machineIdentities.value })
    .from(machines)
    .leftJoin(machineIdentities, eq(machineIdentities.machineId, machines.id))
    .orderBy(machines.name)
    .all()

  const byId = new Map<number, { id: number; name: string; identities: { kind: IdentityKind; value: string }[] }>()
  for (const row of rows) {
    const machine = byId.get(row.id) ?? { id: row.id, name: row.name, identities: [] }
    if (row.kind && row.value) machine.identities.push({ kind: row.kind, value: row.value })
    byId.set(row.id, machine)
  }
  return [...byId.values()]
}

// Keys and IPs seen in requests that aren't assigned to a machine yet.
export function unassignedIdentities(db: Db) {
  const seen = (column: typeof requests.clientKeyHash | typeof requests.clientIp, kind: IdentityKind) =>
    db
      .select({
        kind: sql<IdentityKind>`${kind}`,
        value: sql<string>`${column}`,
        requests: sql<number>`count(*)`,
        lastSeen: sql<number>`max(${requests.occurredAt})`,
        userAgent: sql<string>`max(${requests.userAgent})`,
      })
      .from(requests)
      .leftJoin(machineIdentities, sql`${machineIdentities.kind} = ${kind} and ${machineIdentities.value} = ${column}`)
      .where(sql`${isNotNull(column)} and ${machineIdentities.machineId} is null`)
      .groupBy(column)
      .orderBy(desc(sql`max(${requests.occurredAt})`))
      .all()

  return [...seen(requests.clientKeyHash, 'key'), ...seen(requests.clientIp, 'ip')]
}

// Creates the machine if needed and attaches the identity to it.
export function assignIdentity(db: Db, machineName: string, kind: IdentityKind, value: string) {
  return db.transaction((tx) => {
    const existing = tx.select().from(machines).where(eq(machines.name, machineName)).get()
    const machine = existing ?? tx.insert(machines).values({ name: machineName, createdAt: new Date() }).returning().get()
    tx.insert(machineIdentities)
      .values({ kind, value, machineId: machine.id })
      .onConflictDoUpdate({ target: [machineIdentities.kind, machineIdentities.value], set: { machineId: machine.id } })
      .run()
    return machine
  })
}

export function renameMachine(db: Db, id: number, name: string) {
  db.update(machines).set({ name }).where(eq(machines.id, id)).run()
}

export function deleteMachine(db: Db, id: number) {
  db.delete(machines).where(eq(machines.id, id)).run()
}
