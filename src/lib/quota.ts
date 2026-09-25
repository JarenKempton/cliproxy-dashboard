// Fetches and normalizes per-account quota windows from the upstream usage
// endpoints, via the proxy's /api-call (which substitutes the account token).

import { upstreamGet, type AuthFile } from './api'

const HOUR = 3600e3
const WEEK = 168 * HOUR

export type QuotaWindow = {
  id: string
  label: string
  usedPercent: number
  resetAtMs: number | null // null: window hasn't started yet
  periodMs: number
}

export type Quota = { windows: QuotaWindow[]; plan?: string }

export const providerOf = (f: AuthFile) => (f.provider ?? f.type ?? '').toLowerCase()

const parseTime = (s: unknown) => (typeof s === 'string' && s ? Date.parse(s) : null)

// --- Claude ---------------------------------------------------------------

const CLAUDE_HEADERS = {
  Authorization: 'Bearer $TOKEN$',
  'Content-Type': 'application/json',
  'anthropic-beta': 'oauth-2025-04-20',
}

type ClaudeLimit = {
  kind?: string
  percent?: number
  resets_at?: string | null
  scope?: { model?: { display_name?: string | null } } | null
}
type ClaudeWindow = { utilization?: number; resets_at?: string | null } | null

type ClaudeUsage = {
  limits?: ClaudeLimit[]
  five_hour?: ClaudeWindow
  seven_day?: ClaudeWindow
}

type ClaudeProfile = {
  account?: { has_claude_max?: boolean; has_claude_pro?: boolean }
  organization?: { organization_type?: string; subscription_status?: string }
}

function claudeWindows(usage: ClaudeUsage): QuotaWindow[] {
  // `limits[]` is the canonical list; the named windows are the older shape.
  if (usage.limits?.length) {
    return usage.limits.flatMap((l): QuotaWindow[] => {
      if (typeof l.percent !== 'number') return []
      const resetAtMs = parseTime(l.resets_at)
      if (l.kind === 'session') return [{ id: 'session', label: '5-hour', usedPercent: l.percent, resetAtMs, periodMs: 5 * HOUR }]
      if (l.kind === 'weekly_all') return [{ id: 'weekly', label: 'Weekly', usedPercent: l.percent, resetAtMs, periodMs: WEEK }]
      if (l.kind === 'weekly_scoped') {
        const model = l.scope?.model?.display_name ?? 'Model'
        return [{ id: `weekly-${model.toLowerCase()}`, label: `${model} weekly`, usedPercent: l.percent, resetAtMs, periodMs: WEEK }]
      }
      return []
    })
  }
  const named: [keyof ClaudeUsage, string, string, number][] = [
    ['five_hour', 'session', '5-hour', 5 * HOUR],
    ['seven_day', 'weekly', 'Weekly', WEEK],
  ]
  return named.flatMap(([key, id, label, periodMs]) => {
    const w = usage[key] as ClaudeWindow
    if (!w || typeof w.utilization !== 'number') return []
    return [{ id, label, usedPercent: w.utilization, resetAtMs: parseTime(w.resets_at), periodMs }]
  })
}

function claudePlan(p: ClaudeProfile): string | undefined {
  if (p.organization?.organization_type === 'claude_team' && p.organization.subscription_status === 'active') return 'Team'
  if (p.account?.has_claude_max) return 'Max'
  if (p.account?.has_claude_pro) return 'Pro'
  if (p.account) return 'Free'
  return undefined
}

// The plan rarely changes and the usage endpoints rate-limit hard, so the
// profile lookup (only used for the plan badge) runs at most once a day.
const PLAN_TTL_MS = 86400e3

async function claudePlanCached(f: AuthFile): Promise<string | undefined> {
  const key = `cpa:plan:${f.auth_index}`
  try {
    const hit = JSON.parse(localStorage.getItem(key) ?? 'null') as { plan: string; at: number } | null
    if (hit && Date.now() - hit.at < PLAN_TTL_MS) return hit.plan
  } catch {
    // ignore a corrupt entry
  }
  try {
    const plan = claudePlan((await upstreamGet(f.auth_index, 'https://api.anthropic.com/api/oauth/profile', CLAUDE_HEADERS)) as ClaudeProfile)
    if (plan) localStorage.setItem(key, JSON.stringify({ plan, at: Date.now() }))
    return plan
  } catch {
    return undefined
  }
}

async function claudeQuota(f: AuthFile): Promise<Quota> {
  const usage = (await upstreamGet(f.auth_index, 'https://api.anthropic.com/api/oauth/usage', CLAUDE_HEADERS)) as ClaudeUsage
  return { windows: claudeWindows(usage), plan: await claudePlanCached(f) }
}

// --- Codex ----------------------------------------------------------------

type CodexWindow = {
  used_percent?: number
  limit_window_seconds?: number
  reset_after_seconds?: number
  reset_at?: number
} | null

type CodexRateLimit = {
  limit_reached?: boolean
  allowed?: boolean
  primary_window?: CodexWindow
  secondary_window?: CodexWindow
} | null

type CodexUsage = {
  plan_type?: string
  rate_limit?: CodexRateLimit
  additional_rate_limits?: { limit_name?: string; rate_limit?: CodexRateLimit }[] | null
}

function codexWindowLabel(seconds: number) {
  if (seconds === 5 * 3600) return '5-hour'
  if (seconds === 7 * 86400) return 'Weekly'
  if (seconds >= 28 * 86400) return 'Monthly'
  return `${Math.round(seconds / 3600)}-hour`
}

function codexWindows(rl: CodexRateLimit, prefix: string): QuotaWindow[] {
  if (!rl) return []
  const reached = rl.limit_reached || rl.allowed === false
  return [rl.primary_window, rl.secondary_window].flatMap((w, i): QuotaWindow[] => {
    if (!w) return []
    // Without durations, primary is the 5-hour window and secondary the weekly one.
    const seconds = w.limit_window_seconds ?? (i === 0 ? 5 * 3600 : 7 * 86400)
    const used = w.used_percent ?? (reached ? 100 : null)
    if (used === null) return []
    const resetAtMs = w.reset_at ? w.reset_at * 1000 : w.reset_after_seconds != null ? Date.now() + w.reset_after_seconds * 1000 : null
    const label = codexWindowLabel(seconds)
    return [{ id: `${prefix}${label.toLowerCase()}`, label: prefix ? `${prefix.trim()} ${label.toLowerCase()}` : label, usedPercent: used, resetAtMs, periodMs: seconds * 1000 }]
  })
}

async function codexQuota(f: AuthFile): Promise<Quota> {
  const header: Record<string, string> = {
    Authorization: 'Bearer $TOKEN$',
    'Content-Type': 'application/json',
    'User-Agent': 'codex-tui/0.149.1 (Mac OS 26.5.2; arm64) iTerm.app/3.6.11 (codex-tui; 0.149.1)',
  }
  const accountId = f.id_token?.chatgpt_account_id
  if (accountId) header['Chatgpt-Account-Id'] = accountId
  const usage = (await upstreamGet(f.auth_index, 'https://chatgpt.com/backend-api/wham/usage', header)) as CodexUsage
  return {
    windows: [
      ...codexWindows(usage.rate_limit ?? null, ''),
      ...(usage.additional_rate_limits ?? []).flatMap((a) => codexWindows(a.rate_limit ?? null, `${a.limit_name ?? 'Extra'} `)),
    ],
    plan: usage.plan_type ?? f.id_token?.plan_type,
  }
}

// --------------------------------------------------------------------------

export const PROVIDER_NAMES: Record<string, string> = { claude: 'Claude', codex: 'Codex' }

export function supportsQuota(f: AuthFile) {
  return providerOf(f) in PROVIDER_NAMES
}

export function fetchQuota(f: AuthFile): Promise<Quota> {
  return providerOf(f) === 'codex' ? codexQuota(f) : claudeQuota(f)
}
