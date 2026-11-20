import { withConfigWrite } from './config-write'
import { createHash } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { Db } from './db/client'
import { settings } from './db/schema'
import { saveBackup } from './http/management'
import type { InviteClaim } from './pool-invites'
import { gatewayOf, isPaused, routeId, UPSTREAM_LISTS, UpstreamConfig, type PauseSnapshot, type UpstreamKey } from './upstream-config'

export type Management = (path: string, init?: { method: string; body?: unknown; raw?: string }) => Promise<Response>
type PauseState = { originals: Record<string, PauseSnapshot> }

export class BorrowedUpstreams {
  constructor(private db: Db, private management: Management, private target: string) {}

  private key(gateway: string) {
    return `borrowed-pause:${createHash('sha256').update(gateway).digest('hex')}`
  }

  private state(gateway: string): PauseState | undefined {
    const row = this.db.select().from(settings).where(eq(settings.key, this.key(gateway))).get()
    return row ? JSON.parse(row.value) as PauseState : undefined
  }

  private save(gateway: string, state?: PauseState) {
    const key = this.key(gateway)
    if (!state) return this.db.delete(settings).where(eq(settings.key, key)).run()
    const value = JSON.stringify(state)
    this.db.insert(settings).values({ key, value }).onConflictDoUpdate({ target: settings.key, set: { value } }).run()
  }

  async read() {
    const response = await this.management('/config.yaml')
    if (!response.ok) throw new Error(`The proxy refused to read config.yaml (HTTP ${response.status})`)
    return new UpstreamConfig(await response.text())
  }

  private async write(config: UpstreamConfig, gateway: string, next?: PauseState) {
    saveBackup(config.text)
    const previous = this.state(gateway)
    this.save(gateway, next)
    const response = await this.management('/config.yaml', { method: 'PUT', raw: config.toString() })
    if (!response.ok) {
      try {
        const actual = await this.management('/config.yaml')
        if (actual.ok && await actual.text() === config.text) this.save(gateway, previous)
      } catch {}
      throw new Error(`The proxy refused the config.yaml update (HTTP ${response.status})`)
    }
  }

  pause(gateway: string, paused: boolean) {
    return withConfigWrite(this.target, async () => {
      const config = await this.read()
      const routes = config.routes().filter((route) => gatewayOf(route.entry) === gateway)
      if (!routes.length) return false
      const state = this.state(gateway) ?? { originals: {} }
      for (const route of routes) {
        const id = routeId(route)
        if (paused) {
          if (!state.originals[id] || !isPaused(route)) state.originals[id] = config.snapshot(route)
          config.pause(route)
        } else if (isPaused(route)) {
          const kept = (route.entry['excluded-models'] ?? []).filter((model) => model !== '*')
          const fallback = route.list === 'openai-compatibility' ? { present: false } : { present: kept.length > 0, value: kept }
          config.restore(route, state.originals[id] ?? fallback)
        }
      }
      await this.write(config, gateway, state)
      if (!paused) this.save(gateway)
      return true
    })
  }

  join(gateway: string, claim: () => Promise<InviteClaim>) {
    return withConfigWrite(this.target, async () => {
      const before = await this.read()
      before.routes()
      saveBackup(before.text)
      const { owner, token, models } = await claim()
      const config = await this.read().catch((error: Error) => { throw new Error(`${error.message}. The invite is used up; ask for a new one.`) })
      const state = this.state(gateway)
      const routes = config.routes().filter((r) => gatewayOf(r.entry) === gateway)
      const paused = routes.length > 0 && routes.every(isPaused)
      const next = state ?? { originals: {} }
      const fallback = { priority: -1, 'disable-cooling': true }
      const additions: (UpstreamKey | null)[] = [
        { 'api-key': token, 'base-url': `${gateway}/pool`, ...fallback },
        { 'api-key': token, 'base-url': `${gateway}/pool/v1`, ...fallback },
        models.length ? { name: `pool-${(owner || new URL(gateway).hostname).toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, 'base-url': `${gateway}/pool/v1`, 'api-key-entries': [{ 'api-key': token }], models: models.map((name) => ({ name, alias: name })), ...fallback } : null,
      ]
      for (const [i, list] of UPSTREAM_LISTS.entries()) {
        const entry = additions[i]
        const existing = config.routes().find((r) => r.list === list && gatewayOf(r.entry) === gateway)
        if (!entry) {
          if (existing) config.remove(existing)
          continue
        }
        const original = existing && (next.originals[routeId(existing)] ?? config.snapshot(existing))
        const route = existing ? config.replace(existing, { ...entry, priority: existing.entry.priority ?? entry.priority }) : config.add(list, entry)
        if (paused) {
          next.originals[routeId(route)] = original ?? config.snapshot(route)
          config.pause(route)
        }
      }
      await this.write(config, gateway, paused ? next : state)
      return { owner, gateway }
    })
  }
}
