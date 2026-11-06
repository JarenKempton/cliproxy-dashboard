// Lending this proxy's accounts to peers, one pool (provider) at a time.
// Everything is off until a pool is shared; see http/pool.ts for the gateway.

import { createHash, randomBytes } from 'node:crypto'
import { eq, like } from 'drizzle-orm'
import { listAuthFiles } from '../../src/lib/api'
import type { AuthFile } from '../../src/lib/api'
import { fetchQuota, providerOf, type QuotaWindow } from '../../src/lib/quota'
import type { Floors, Lender, LenderStatus, LentPool } from '../../src/lib/sharing'
import type { Db } from './db/client'
import { keyLabels, poolPeers, poolSharing, settings } from './db/schema'
import { setKeyLabel } from './keys'
import { saveBackup } from './http/management'
import { hashKey } from './usage/cliproxy-record'
import { accountHours } from './usage/summary'
import { saveBackup } from './http/management'
import { Invites, joinPeer } from './pool-invites'

export const POOLS = { claude: 'claude', codex: 'codex', grok: 'xai', muse: 'meta' } as const
export type Pool = keyof typeof POOLS
export const isPool = (p: unknown): p is Pool => typeof p === 'string' && p in POOLS

export type Peer = { id: number; name: string; createdAt: number }
export type Sharing = { until: number | null }
type AuthEntry = { name: string; provider?: string; type?: string; disabled?: boolean; unavailable?: boolean }

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex')
const PEER_LABEL = 'Pool: '
const FLOOR_KEY = 'floor:'

// Every peer's proxy key, removed peers included: their labels stay.
export function peerKeyHashes(db: Db) {
  return db.select({ hash: keyLabels.keyHash }).from(keyLabels).where(like(keyLabels.label, `${PEER_LABEL}%`)).all().map((r) => r.hash)
}
const STATUS_TTL_MS = 60e3
const LAST_READING_MS = 15 * 60e3
const COST_HISTORY_MS = 14 * 86400e3
const GATEWAY = /^(.*)\/pool(\/v1)?\/?$/

type UpstreamKey = { 'api-key'?: string; 'base-url'?: string; 'api-key-entries'?: { 'api-key'?: string }[] }

export class SharingStore {
  private lastWindows = new Map<string, { at: number; windows: QuotaWindow[] }>()
  readonly invites = new Invites()
  private status = new Map<number, { at: number; body: LenderStatus }>()

  constructor(
    private db: Db,
    private proxyUrl: string,
    private managementKey: string,
  ) {}

  private management(path: string, init?: { method: string; body?: unknown }) {
    return fetch(`${this.proxyUrl}/v0/management${path}`, {
      method: init?.method ?? 'GET',
      headers: { Authorization: `Bearer ${this.managementKey}`, 'Content-Type': 'application/json' },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    })
  }

  // Each pool's sharing right now: null when not shared (or expired), else
  // when it ends, with null meaning until turned off.
  sharing(now = Date.now()): Record<Pool, Sharing | null> {
    const rows = new Map(this.db.select().from(poolSharing).all().map((r) => [r.pool, r.until?.getTime() ?? null]))
    return Object.fromEntries(
      Object.keys(POOLS).map((p) => {
        const until = rows.get(p)
        return [p, until === undefined || (until !== null && until <= now) ? null : { until }]
      }),
    ) as Record<Pool, Sharing | null>
  }

  share(pool: Pool, until: number | null) {
    const value = until === null ? null : new Date(until)
    this.db.insert(poolSharing).values({ pool, until: value }).onConflictDoUpdate({ target: poolSharing.pool, set: { until: value } }).run()
  }

  stopSharing(pool: Pool) {
    this.db.delete(poolSharing).where(eq(poolSharing.pool, pool)).run()
  }

  peers(): Peer[] {
    return this.db
      .select({ id: poolPeers.id, name: poolPeers.name, createdAt: poolPeers.createdAt })
      .from(poolPeers)
      .all()
      .map((p) => ({ ...p, createdAt: p.createdAt.getTime() }))
  }

  // Returns the peer's pool token. It is shown once and only its hash is kept.
  async backupConfig() {
    const res = await this.management('/config.yaml')
    if (!res.ok) throw new Error(`couldn’t back up config.yaml before writing (HTTP ${res.status})`)
    saveBackup(await res.text())
  }

  // The peer row comes first and is undone if the proxy refuses the key, so a
  // key in the proxy always has a row to revoke it from.
  async addPeer(name: string): Promise<string> {
    const token = `pool-${randomBytes(24).toString('base64url')}`
    const proxyKey = `sk-pool-${randomBytes(24).toString('base64url')}`
    const res = await this.management('/api-keys')
    if (!res.ok) throw new Error(`the proxy refused to list keys (HTTP ${res.status})`)
    const { 'api-keys': existing = [] } = (await res.json()) as { 'api-keys'?: string[] }
    await this.backupConfig()
    const { id } = this.db.insert(poolPeers).values({ name, tokenHash: hashToken(token), proxyKey, createdAt: new Date() }).returning({ id: poolPeers.id }).get()
    const put = await this.management('/api-keys', { method: 'PUT', body: [...existing, proxyKey] }).catch((e: Error) => e)
    if (put instanceof Error || !put.ok) {
      this.db.delete(poolPeers).where(eq(poolPeers.id, id)).run()
      throw new Error(put instanceof Error ? `couldn’t reach the proxy: ${put.message}` : `the proxy refused the new key (HTTP ${put.status})`)
    }
    setKeyLabel(this.db, hashKey(proxyKey), `${PEER_LABEL}${name}`)
    return token
  }

  // The key's label stays, so past usage is still attributed to the peer.
  async removePeer(id: number) {
    const peer = this.db.select().from(poolPeers).where(eq(poolPeers.id, id)).get()
    if (!peer) return
    const res = await this.management(`/api-keys?value=${encodeURIComponent(peer.proxyKey)}`, { method: 'DELETE' })
    if (!res.ok && res.status !== 404) throw new Error(`the proxy refused to remove the key (HTTP ${res.status})`)
    this.db.delete(poolPeers).where(eq(poolPeers.id, id)).run()
  }

  // Model ids of this proxy's Grok and Muse accounts, which a borrower's proxy
  // must list by name to route them here.
  async lendableModels(): Promise<string[]> {
    const res = await this.management('/auth-files')
    if (!res.ok) return []
    const files = ((await res.json()) as { files?: AuthEntry[] }).files ?? []
    const models = new Set<string>()
    for (const f of files.filter((file) => [POOLS.grok, POOLS.muse].includes((file.provider ?? file.type) as 'xai' | 'meta') && !file.disabled)) {
      const list = await this.management(`/auth-files/models?name=${encodeURIComponent(f.name)}`)
      if (list.ok) for (const m of ((await list.json()) as { models?: { id: string }[] }).models ?? []) models.add(m.id)
    }
    return [...models]
  }

  // Adds a lender from its invite link to this proxy's config.
  join(link: string) {
    return joinPeer(link, (path, init) => this.management(path, init), async () => {
      const res = await this.management('/config.yaml')
      if (!res.ok) throw new Error(`Couldn’t back up config.yaml before writing (HTTP ${res.status})`)
      saveBackup(await res.text())
    })
  }

  peerFor(token: string) {
    return this.db.select().from(poolPeers).where(eq(poolPeers.tokenHash, hashToken(token))).get()
  }

  // The shared pool with a working account of this proxy's own for the model,
  // or null. Requiring a working local account keeps a borrowed request from
  // falling through to this proxy's own peer fallback and looping back.
  async poolServing(model: string): Promise<Pool | null> {
    const sharing = this.sharing()
    const shared = (Object.keys(POOLS) as Pool[]).filter((p) => sharing[p])
    if (!shared.length) return null
    const res = await this.management('/auth-files')
    if (!res.ok) return null
    const files = ((await res.json()) as { files?: AuthEntry[] }).files ?? []
    for (const pool of shared) {
      const accounts = files.filter((f) => (f.provider ?? f.type) === POOLS[pool] && !f.disabled && !f.unavailable)
      for (const account of accounts) {
        const models = await this.management(`/auth-files/models?name=${encodeURIComponent(account.name)}`)
        if (!models.ok) continue
        const { models: list = [] } = (await models.json()) as { models?: { id: string }[] }
        if (list.some((m) => m.id === model)) return (await this.aboveFloor(pool)) ? pool : null
      }
    }
    return null
  }

  // The share of each quota window kept for this proxy's own use, in
  // percent, by pool and window label ('5-hour', 'Weekly', ...).
  floors(): Record<Pool, Floors> {
    const floors = Object.fromEntries(Object.keys(POOLS).map((p) => [p, {}])) as Record<Pool, Floors>
    for (const row of this.db.select().from(settings).where(like(settings.key, `${FLOOR_KEY}%`)).all()) {
      const [pool, window] = row.key.slice(FLOOR_KEY.length).split(/:(.*)/s)
      if (isPool(pool) && window) floors[pool][window] = Number(row.value)
    }
    return floors
  }

  setFloor(pool: Pool, window: string, percent: number) {
    const key = `${FLOOR_KEY}${pool}:${window}`
    if (!percent) {
      this.db.delete(settings).where(eq(settings.key, key)).run()
      return
    }
    const value = String(percent)
    this.db.insert(settings).values({ key, value }).onConflictDoUpdate({ target: settings.key, set: { value } }).run()
  }

  owner(): string {
    return this.db.select().from(settings).where(eq(settings.key, 'owner')).get()?.value ?? ''
  }

  setOwner(name: string) {
    this.db.insert(settings).values({ key: 'owner', value: name }).onConflictDoUpdate({ target: settings.key, set: { value: name } }).run()
  }

  // The pools shared right now, with each account's quota windows, recent
  // hourly cost, and the part of it this peer sent, so the peer can fold them
  // into its own burndown.
  async lenderStatus(peer: { id: number; proxyKey: string }, now = Date.now()): Promise<LenderStatus> {
    const cached = this.status.get(peer.id)
    if (cached && now - cached.at < STATUS_TTL_MS) return cached.body
    const sharing = this.sharing(now)
    const floors = this.floors()
    const shared = (Object.keys(POOLS) as Pool[]).filter((p) => sharing[p])
    const files = shared.length ? (await listAuthFiles()).filter((f) => !f.disabled) : []
    const hours = shared.length ? accountHours(this.db, now - COST_HISTORY_MS, [hashKey(peer.proxyKey)]) : []
    const pools: LentPool[] = []
    for (const pool of shared) {
      const provider = POOLS[pool]
      const accounts = []
      for (const f of files.filter((file) => providerOf(file) === provider)) {
        const quota = await fetchQuota(f).catch(() => null)
        if (!quota) continue
        const label = f.email || f.label || f.name
        const mine = hours.filter((h) => h.provider === provider && h.account === label)
        accounts.push({
          windows: quota.windows,
          cost: mine.map((h): [number, number] => [h.hour, h.costMicros]),
          yourCost: mine.filter((h) => h.peerMicros > 0).map((h): [number, number] => [h.hour, h.peerMicros]),
        })
      }
      if (accounts.length) pools.push({ pool, provider, until: sharing[pool]!.until, floors: floors[pool], accounts })
    }
    const body = { owner: this.owner(), pools }
    this.status.set(peer.id, { at: now, body })
    return body
  }

  // Drops cached status and quota readings, after a setting changes.
  forgetStatus() {
    this.status.clear()
    this.lastWindows.clear()
  }

  // An account's quota windows: a reading under a minute old as is, else a
  // fresh read, else (the provider's usage endpoint rate-limits) the last good
  // reading from the past 15 minutes so a brief outage doesn't cut off
  // lending; null when there's none. Busy borrowing reads once a minute at most.
  private async windowsOf(f: AuthFile) {
    const last = this.lastWindows.get(f.auth_index)
    if (last && Date.now() - last.at < STATUS_TTL_MS) return last.windows
    const quota = await fetchQuota(f).catch(() => null)
    if (quota?.windows.length) {
      this.lastWindows.set(f.auth_index, { at: Date.now(), windows: quota.windows })
      return quota.windows
    }
    return last && Date.now() - last.at < LAST_READING_MS ? last.windows : null
  }

  // Whether every window with a floor has more left than it, averaged over
  // the pool's working accounts, every one of which must be readable. The
  // proxy picks which account serves a request, so with several accounts
  // this is pool-wide.
  private async aboveFloor(pool: Pool) {
    const floors = Object.entries(this.floors()[pool])
    if (!floors.length) return true
    const files = (await listAuthFiles()).filter((f) => providerOf(f) === POOLS[pool] && !f.disabled && !f.unavailable)
    const left = new Map<string, number[]>()
    for (const f of files) {
      const windows = await this.windowsOf(f)
      // An account that can't be read could be the one nearly spent, so the
      // kept share can't be checked: refuse.
      if (!windows) return false
      for (const w of windows) left.set(w.label, [...(left.get(w.label) ?? []), 100 - w.usedPercent])
    }
    // A window no account reports is one this pool doesn't have.
    if (!left.size) return false
    return floors.every(([window, floor]) => {
      const readings = left.get(window)
      return !readings || readings.reduce((s, l) => s + l, 0) / readings.length > floor
    })
  }

  // Peers this proxy borrows from, found in its own config as upstreams whose
  // base-url is a peer's /pool gateway, with what each shares right now.
  async lenders(): Promise<Lender[]> {
    const found = new Map<string, { gateway: string; token: string }>()
    for (const list of ['claude-api-key', 'codex-api-key', 'openai-compatibility']) {
      const res = await this.management(`/${list}`)
      if (!res.ok) continue
      const entries = (((await res.json()) as Record<string, UpstreamKey[] | null>)[list] ?? []) as UpstreamKey[]
      for (const e of entries) {
        const gateway = e['base-url']?.match(GATEWAY)?.[1]
        const tokens = [e['api-key'], ...(e['api-key-entries'] ?? []).map((k) => k['api-key'])].filter((t): t is string => !!t)
        for (const token of gateway ? tokens : []) found.set(`${gateway}|${token}`, { gateway: gateway!, token })
      }
    }
    return Promise.all(
      [...found.values()].map(async ({ gateway, token }): Promise<Lender> => {
        try {
          const res = await fetch(`${gateway}/pool/status`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15e3) })
          if (!res.ok) return { gateway, pools: [], error: `HTTP ${res.status}` }
          const status = (await res.json()) as LenderStatus
          return { gateway, owner: status.owner || undefined, pools: status.pools }
        } catch (e) {
          return { gateway, pools: [], error: (e as Error).message }
        }
      }),
    )
  }
}
