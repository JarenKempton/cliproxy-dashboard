// Client for the usage server's sharing settings (server/src/http/sharing.ts).

import { formatStamp } from './format'
import type { QuotaWindow } from './quota'

export const POOLS = [
  { id: 'claude', label: 'Claude', provider: 'claude' },
  { id: 'codex', label: 'Codex', provider: 'codex' },
  { id: 'grok', label: 'Grok', provider: 'xai' },
  { id: 'muse', label: 'Muse', provider: 'meta' },
] as const
export type Pool = (typeof POOLS)[number]['id']

export type Peer = { id: number; name: string; createdAt: number }
export type Sharing = { until: number | null }
// Percent of each quota window kept for yourself, by window label ('5-hour', 'Weekly', ...).
export type Floors = Record<string, number>

// "30% weekly · 20% 5-hour"
export const describeFloors = (floors: Floors) =>
  Object.entries(floors)
    .filter(([, f]) => f > 0)
    .map(([w, f]) => `${f}% ${w.toLowerCase()}`)
    .join(' · ')
export type SharingState = { sharing: Record<Pool, Sharing | null>; floors: Record<Pool, Floors>; peers: Peer[]; owner: string }
export type Choice = { id: string; label: string; until: number | null }

// What a lender reports about the pools it shares, for a borrower's Quota page.
// yourCost: the part of cost the asking peer sent.
export type LentAccount = { windows: QuotaWindow[]; cost: [hour: number, micros: number][]; yourCost: [hour: number, micros: number][] }
// floors: the percent of each window the lender keeps for itself.
export type LentPool = { pool: Pool; provider: string; until: number | null; floors: Floors; accounts: LentAccount[] }
export type LenderStatus = { owner: string; pools: LentPool[] }
// paused: this proxy keeps the lender's token but sends it nothing.
export type Lender = { gateway: string; owner?: string; paused: boolean; pools: LentPool[]; error?: string }

const HOUR = 3600e3

// How long to share a pool for, given its accounts' quota windows. The first
// choice is the default: until the pool's next reset when one is known.
export function sharingChoices(windows: QuotaWindow[], now: number): Choice[] {
  const soonest = (list: QuotaWindow[]) =>
    Math.min(...list.map((w) => w.resetAtMs ?? Infinity).filter((t) => t > now))
  const next = soonest(windows)
  const weekly = soonest(windows.filter((w) => w.id === 'weekly'))
  const choices: Choice[] = []
  if (Number.isFinite(next)) choices.push({ id: 'reset', label: `Until next reset · ${formatStamp(next, now)}`, until: next })
  if (Number.isFinite(weekly) && weekly !== next) choices.push({ id: 'weekly', label: `Until weekly reset · ${formatStamp(weekly, now)}`, until: weekly })
  choices.push(
    { id: '2h', label: 'For 2 hours', until: now + 2 * HOUR },
    { id: '8h', label: 'For 8 hours', until: now + 8 * HOUR },
    { id: 'today', label: 'Rest of today', until: new Date(now).setHours(24, 0, 0, 0) },
    { id: 'off', label: 'Until I turn it off', until: null },
  )
  return choices
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/pool${path}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`)
  return data as T
}

export const getSharing = () => call<SharingState>('GET', '')
// until: a time, null (until turned off) or false (stop now).
export const setSharing = (pool: Pool, until: number | null | false) => call<Pick<SharingState, 'sharing'>>('PUT', '/sharing', { pool, until })
export const getLenders = () => call<Lender[]>('GET', '/borrowed')
export const pauseLender = (gateway: string, paused: boolean) => call<{ ok: true }>('PUT', '/borrowed', { gateway, paused })
export const setFloor = (pool: Pool, window: string, percent: number) => call<Pick<SharingState, 'floors'>>('PUT', '/floor', { pool, window, percent })
export const setOwner = (owner: string) => call<{ owner: string }>('PUT', '/owner', { owner })
// code: a one-time invite for <this dashboard>/pool/invite/<code>, valid until expires.
export const addPeer = (name: string) => call<{ token: string; code: string; expires: number }>('POST', '/peers', { name })
export const joinPeer = (link: string) => call<{ owner: string; gateway: string }>('POST', '/join', { link })
export const removePeer = (id: number) => call<{ ok: true }>('DELETE', `/peers/${id}`)

// The proxy config a peer adds so its proxy falls back to this one.
export function peerConfig(gateway: string, token: string) {
  return `claude-api-key:
  - api-key: ${token}
    base-url: ${gateway}/pool
    priority: -1
    disable-cooling: true
codex-api-key:
  - api-key: ${token}
    base-url: ${gateway}/pool/v1
    priority: -1
    disable-cooling: true
openai-compatibility:
  - name: pool
    base-url: ${gateway}/pool/v1
    priority: -1
    disable-cooling: true
    api-key-entries:
      - api-key: ${token}
    models: [] # the Grok and Muse models to borrow, e.g. - name: grok-4`
}
