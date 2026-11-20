// Soonest reset first: ranks this proxy's accounts by when their weekly quota
// resets and writes that as each account's priority, so the proxy spends the
// quota that would expire first. An account with no weekly reading ranks
// last, at 0; borrowed upstreams sit below every account, at -1.

import { eq } from 'drizzle-orm'
import { listAuthFiles, type AuthFile } from '../../src/lib/api'
import { fetchQuota, type QuotaWindow } from '../../src/lib/quota'
import type { Db } from './db/client'
import { settings } from './db/schema'

const SETTING = 'drain-soonest'
const EVERY_MS = 15 * 60e3
const DAY = 86400e3

type ReadWindows = (f: AuthFile) => Promise<QuotaWindow[]>

// When the account's soonest weekly-or-longer window resets; Infinity if unknown.
export const weeklyReset = (windows: QuotaWindow[]) =>
  Math.min(...windows.filter((w) => w.periodMs >= DAY && w.resetAtMs !== null && w.resetAtMs > Date.now()).map((w) => w.resetAtMs!))

// Priority by account name: 1 for the latest reset up to the most for the
// soonest, equal resets sharing one; 0 when the reset is unknown.
export function rank(resets: Map<string, number>) {
  const times = [...new Set([...resets.values()].filter(Number.isFinite))].sort((a, b) => b - a)
  return new Map([...resets].map(([name, t]) => [name, times.indexOf(t) + 1]))
}

export class Drain {
  // The last weekly reset read per account, so a rate-limited read doesn't
  // drop an account to the bottom.
  private resets = new Map<string, number>()
  private pending = Promise.resolve()

  constructor(
    private db: Db,
    private proxyUrl: string,
    private managementKey: string,
    private readWindows: ReadWindows = async (f) => (await fetchQuota(f)).windows,
  ) {}

  on() {
    return this.db.select().from(settings).where(eq(settings.key, SETTING)).get()?.value === '1'
  }

  set(on: boolean) {
    return this.enqueue(async () => {
      if (on) await this.applyNow()
      else {
        const files = await listAuthFiles()
        await this.write(files, new Map(files.map((f) => [f.name, 0])))
      }
      const value = on ? '1' : '0'
      this.db.insert(settings).values({ key: SETTING, value }).onConflictDoUpdate({ target: settings.key, set: { value } }).run()
    })
  }

  private enqueue(operation: () => Promise<void>) {
    const result = this.pending.then(operation)
    this.pending = result.catch(() => {})
    return result
  }

  start() {
    const run = () => this.apply().catch((e: Error) => console.warn(`[drain] ${e.message}`))
    run()
    setInterval(run, EVERY_MS)
  }

  apply() {
    return this.enqueue(async () => {
      if (this.on()) await this.applyNow()
    })
  }

  private async applyNow() {
    const files = (await listAuthFiles()).filter((f) => !f.disabled)
    for (const f of files) {
      const windows = await this.readWindows(f).catch(() => null)
      const previous = this.resets.get(f.name) ?? Infinity
      const reset = windows === null ? previous : weeklyReset(windows)
      this.resets.set(f.name, reset > Date.now() ? reset : Infinity)
    }
    await this.write(files, rank(new Map(files.map((f) => [f.name, this.resets.get(f.name)!]))))
  }

  private async write(files: AuthFile[], priorities: Map<string, number>) {
    const written: AuthFile[] = []
    try {
      for (const f of files) {
        const priority = priorities.get(f.name) ?? 0
        if ((f.priority ?? 0) === priority) continue
        await this.patchPriority(f.name, priority)
        written.push(f)
      }
    } catch (error) {
      const rollback = await Promise.allSettled(written.map((f) => this.patchPriority(f.name, f.priority ?? 0)))
      const failures = rollback.filter((r) => r.status === 'rejected')
      if (failures.length) throw new AggregateError([error, ...failures.map((r) => r.reason)], 'Could not restore account priorities after a failed update; retry the switch')
      throw error
    }
  }

  private async patchPriority(name: string, priority: number) {
    const res = await fetch(`${this.proxyUrl}/v0/management/auth-files/fields`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${this.managementKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, priority }),
    })
    if (!res.ok) throw new Error(`the proxy refused ${name}’s priority (HTTP ${res.status})`)
  }
}
