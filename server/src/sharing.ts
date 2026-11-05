// Lending this proxy's accounts to peers, one pool (provider) at a time.
// Everything is off until a pool is shared; see http/pool.ts for the gateway.

import { createHash, randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { Db } from './db/client'
import { poolPeers, poolSharing } from './db/schema'
import { setKeyLabel } from './keys'
import { hashKey } from './usage/cliproxy-record'

export const POOLS = { claude: 'claude', codex: 'codex', grok: 'xai', muse: 'meta' } as const
export type Pool = keyof typeof POOLS
export const isPool = (p: unknown): p is Pool => typeof p === 'string' && p in POOLS

export type Peer = { id: number; name: string; createdAt: number }
type AuthEntry = { name: string; provider?: string; type?: string; disabled?: boolean; unavailable?: boolean }

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex')

export class Sharing {
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

  sharing(): Record<Pool, boolean> {
    const rows = new Map(this.db.select().from(poolSharing).all().map((r) => [r.pool, r.shared]))
    return Object.fromEntries(Object.keys(POOLS).map((p) => [p, rows.get(p) === true])) as Record<Pool, boolean>
  }

  setShared(pool: Pool, shared: boolean) {
    this.db.insert(poolSharing).values({ pool, shared }).onConflictDoUpdate({ target: poolSharing.pool, set: { shared } }).run()
  }

  peers(): Peer[] {
    return this.db
      .select({ id: poolPeers.id, name: poolPeers.name, createdAt: poolPeers.createdAt })
      .from(poolPeers)
      .all()
      .map((p) => ({ ...p, createdAt: p.createdAt.getTime() }))
  }

  // Returns the peer's pool token. It is shown once and only its hash is kept.
  async addPeer(name: string): Promise<string> {
    const token = `pool-${randomBytes(24).toString('base64url')}`
    const proxyKey = `sk-pool-${randomBytes(24).toString('base64url')}`
    const res = await this.management('/api-keys')
    if (!res.ok) throw new Error(`the proxy refused to list keys (HTTP ${res.status})`)
    const { 'api-keys': existing = [] } = (await res.json()) as { 'api-keys'?: string[] }
    const put = await this.management('/api-keys', { method: 'PUT', body: [...existing, proxyKey] })
    if (!put.ok) throw new Error(`the proxy refused the new key (HTTP ${put.status})`)
    this.db.insert(poolPeers).values({ name, tokenHash: hashToken(token), proxyKey, createdAt: new Date() }).run()
    setKeyLabel(this.db, hashKey(proxyKey), `Pool: ${name}`)
    return token
  }

  // The key's label stays, so past usage is still attributed to the peer.
  async removePeer(id: number) {
    const peer = this.db.select().from(poolPeers).where(eq(poolPeers.id, id)).get()
    if (!peer) return
    this.db.delete(poolPeers).where(eq(poolPeers.id, id)).run()
    await this.management(`/api-keys?value=${encodeURIComponent(peer.proxyKey)}`, { method: 'DELETE' })
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
}
