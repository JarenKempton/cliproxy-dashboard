// Lending this proxy's accounts to peers, one pool (provider) at a time.
// Everything is off until a pool is shared; see http/pool.ts for the gateway.

import { createHash, randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { listAuthFiles } from '../../src/lib/api'
import { fetchQuota, providerOf } from '../../src/lib/quota'
import type { Lender, LenderStatus, LentPool } from '../../src/lib/sharing'
import type { Db } from './db/client'
import { poolPeers, poolSharing, settings } from './db/schema'
import { setKeyLabel } from './keys'
import { saveBackup } from './http/management'
import { hashKey } from './usage/cliproxy-record'
import { accountHours } from './usage/summary'

export const POOLS = { claude: 'claude', codex: 'codex', grok: 'xai', muse: 'meta' } as const
export type Pool = keyof typeof POOLS
export const isPool = (p: unknown): p is Pool => typeof p === 'string' && p in POOLS

export type Peer = { id: number; name: string; createdAt: number }
export type Sharing = { until: number | null }
type AuthEntry = { name: string; provider?: string; type?: string; disabled?: boolean; unavailable?: boolean }

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex')
const STATUS_TTL_MS = 60e3
const COST_HISTORY_MS = 14 * 86400e3
const GATEWAY = /^(.*)\/pool(\/v1)?\/?$/

type UpstreamKey = { 'api-key'?: string; 'base-url'?: string; 'api-key-entries'?: { 'api-key'?: string }[] }

export class SharingStore {
  private status: { at: number; body: LenderStatus } | null = null

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
    setKeyLabel(this.db, hashKey(proxyKey), `Pool: ${name}`)
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
        if (list.some((m) => m.id === model)) return pool
      }
    }
    return null
  }

  owner(): string {
    return this.db.select().from(settings).where(eq(settings.key, 'owner')).get()?.value ?? ''
  }

  setOwner(name: string) {
    this.db.insert(settings).values({ key: 'owner', value: name }).onConflictDoUpdate({ target: settings.key, set: { value: name } }).run()
  }

  // The pools shared right now, with each account's quota windows and recent
  // hourly cost, so a borrower can fold them into its own burndown.
  async lenderStatus(now = Date.now()): Promise<LenderStatus> {
    if (this.status && now - this.status.at < STATUS_TTL_MS) return this.status.body
    const sharing = this.sharing(now)
    const shared = (Object.keys(POOLS) as Pool[]).filter((p) => sharing[p])
    const files = shared.length ? (await listAuthFiles()).filter((f) => !f.disabled) : []
    const hours = shared.length ? accountHours(this.db, now - COST_HISTORY_MS) : []
    const pools: LentPool[] = []
    for (const pool of shared) {
      const provider = POOLS[pool]
      const accounts = []
      for (const f of files.filter((file) => providerOf(file) === provider)) {
        const quota = await fetchQuota(f).catch(() => null)
        if (!quota) continue
        const label = f.email || f.label || f.name
        const cost = hours.filter((h) => h.provider === provider && h.account === label).map((h): [number, number] => [h.hour, h.costMicros])
        accounts.push({ windows: quota.windows, cost })
      }
      if (accounts.length) pools.push({ pool, provider, until: sharing[pool]!.until, accounts })
    }
    const body = { owner: this.owner(), pools }
    this.status = { at: now, body }
    return body
  }

  forgetStatus() {
    this.status = null
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
