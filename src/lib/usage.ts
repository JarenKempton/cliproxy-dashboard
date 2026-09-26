// Client for the usage server (server/), reached through the dev server's /api proxy.

export type Range = '24h' | '7d' | '30d' | '90d' | 'all'

export type Totals = {
  costMicros: number
  cacheSavingsMicros: number
  records: number
  unpricedRecords: number
  uncachedTokens: number
  cachedTokens: number
  cacheWriteTokens: number
  outputTokens: number
  processedTokens: number
}

export type ToolUsage = Totals & { tool: string; sessions: number }
export type ModelUsage = Totals & { tool: string; model: string }
export type MachineUsage = Totals & {
  name: string
  nameSource: 'custom' | 'tailscale' | null
  identities: { kind: 'key' | 'ip'; value: string }[]
}
export type AccountUsage = Totals & { name: string }

export type UsageSummary = {
  range: Range
  timeZone: string
  bucket: 'hour' | 'day'
  totals: Totals & { sessions: number }
  tools: ToolUsage[]
  // One point per bucket: hour start (ms) or local day ("YYYY-MM-DD").
  series: { key: number | string; tools: Record<string, { costMicros: number; tokens: number }> }[]
  byModel: ModelUsage[]
  byMachine: MachineUsage[]
  byAccount: AccountUsage[]
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

// The viewer's time zone, so days are local days.
const timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone

export const getUsage = (range: Range) => api<UsageSummary>(`/usage?range=${range}&tz=${encodeURIComponent(timeZone())}`)
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

// --- Tools -------------------------------------------------------------------------

// Fixed order and colors, so a tool keeps its color whatever else is shown.
const TOOLS: Record<string, { label: string; color: string }> = {
  codex: { label: 'Codex', color: 'var(--codex)' },
  'claude-code': { label: 'Claude Code', color: 'var(--claude)' },
}
const TOOL_ORDER = Object.keys(TOOLS)

export const toolLabel = (tool: string) => TOOLS[tool]?.label ?? tool
export const toolColor = (tool: string) => TOOLS[tool]?.color ?? 'var(--fg-3)'
export const byToolOrder = (a: string, b: string) =>
  (TOOL_ORDER.indexOf(a) + 1 || 99) - (TOOL_ORDER.indexOf(b) + 1 || 99) || a.localeCompare(b)

// --- Formatting (matches T3 Code) ---------------------------------------------------

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 })

// $1,219.02
export const formatUsd = (micros: number) => usd.format(micros / 1e6)

// 849M, 6.04B, 19.9B: fewer decimals as the number grows.
export function formatTokens(n: number): string {
  const units: [number, string][] = [
    [1e12, 'T'],
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K'],
  ]
  for (const [size, suffix] of units) {
    if (n >= size) {
      const v = n / size
      const decimals = v >= 100 ? 0 : v >= 10 ? 1 : 2
      // Trim trailing zeros after the decimal point only ("6.00B" → "6B", "100M" stays).
      return `${v.toFixed(decimals).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')}${suffix}`
    }
  }
  return String(Math.round(n))
}

// 29.4%, <0.1%
export function formatPercent(fraction: number): string {
  if (fraction > 0 && fraction < 0.001) return '<0.1%'
  return `${(fraction * 100).toFixed(1)}%`
}

export const formatCount = (n: number) => n.toLocaleString('en-US')
