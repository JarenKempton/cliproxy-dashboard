// Client for the usage server (server/), reached through the dev server's /api proxy.

export type Range = '24h' | '7d' | '30d'

export type Totals = {
  requests: number
  failed: number
  costMicros: number
  unpriced: number
  inputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
}

export type Breakdown = Totals & { name: string }

export type Overview = {
  range: Range
  from: number
  bucketMs: number
  totals: Totals
  series: { at: number; costMicros: number; requests: number }[]
  byModel: Breakdown[]
  byMachine: Breakdown[]
  byAccount: Breakdown[]
  byTool: Breakdown[]
}

export type RecentRequest = {
  occurredAt: string
  model: string
  tool: string | null
  account: string | null
  machine: string
  failed: boolean
  latencyMs: number | null
  inputTokens: number | null
  cacheReadTokens: number | null
  cacheWriteTokens: number | null
  outputTokens: number | null
  costMicros: number | null
}

export type Device = {
  kind: 'key' | 'ip'
  value: string
  name: string | null
  nameSource: 'custom' | 'tailscale' | null
  tailscale: { name: string; os: string | null; online: boolean | null; isSelf: boolean } | null
  requests: number
  costMicros: number
  lastSeen: number | null
  userAgent: string | null
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`)
  return body as T
}

// Minutes east of UTC, so the server buckets by local hours and days.
const tz = () => -new Date().getTimezoneOffset()

export const getOverview = (range: Range) => api<Overview>(`/usage?range=${range}&tz=${tz()}`)
export const getRecent = (limit = 50) => api<RecentRequest[]>(`/usage/requests?limit=${limit}`)
export const getDevices = () => api<Device[]>('/devices')

export const nameDevice = (kind: Device['kind'], value: string, name: string) =>
  api('/devices/name', { method: 'PUT', body: JSON.stringify({ kind, value, name }) })

export const clearDeviceName = (kind: Device['kind'], value: string) =>
  api('/devices/name', { method: 'DELETE', body: JSON.stringify({ kind, value }) })

export const getKeyLabels = () => api<Record<string, string>>('/keys/labels')

export const setKeyLabel = (key: string, label: string) =>
  api('/keys/label', { method: 'PUT', body: JSON.stringify({ key, label }) })

export const dedicateKey = (key: string, machine: string) =>
  api('/keys/machine', { method: 'PUT', body: JSON.stringify({ key, name: machine }) })

// Same short hash the server stores (sha256, first 16 hex chars).
export async function hashKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16)
}

// --- Formatting ------------------------------------------------------------------

export function formatUsd(micros: number): string {
  const usd = micros / 1e6
  if (usd === 0) return '$0'
  if (usd < 0.01) return '<$0.01'
  if (usd >= 1000) return `$${(usd / 1000).toFixed(1)}k`
  return `$${usd.toFixed(2)}`
}

export function formatTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`
  return String(n)
}
