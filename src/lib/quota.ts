// Fetches and normalizes per-account quota windows from the upstream usage
// endpoints, via the proxy's /api-call (which substitutes the account token).

import { upstreamCall, upstreamGet, type AuthFile } from './api'

const HOUR = 3600e3
const WEEK = 168 * HOUR

export type QuotaWindow = {
  id: string
  label: string
  usedPercent: number
  resetAtMs: number | null // null: window hasn't started yet
  periodMs: number
}

// Codex "reset credits": each one resets the account's usage limits once.
export type ResetCredits = { available: number; expiresAtMs: number[] }

export type Quota = { windows: QuotaWindow[]; plan?: string; resetCredits?: ResetCredits }

export class QuotaUnavailableError extends Error {}

export const providerOf = (f: AuthFile) => (f.provider ?? f.type ?? '').toLowerCase()

const parseTime = (s: unknown) => {
  const ms = typeof s === 'string' && s ? Date.parse(s) : NaN
  return Number.isNaN(ms) ? null : ms
}

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
  rate_limit_reset_credits?: { available_count?: number }
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

function codexHeaders(f: AuthFile): Record<string, string> {
  const header: Record<string, string> = {
    Authorization: 'Bearer $TOKEN$',
    'Content-Type': 'application/json',
    'User-Agent': 'codex-tui/0.149.1 (Mac OS 26.5.2; arm64) iTerm.app/3.6.11 (codex-tui; 0.149.1)',
  }
  const accountId = f.id_token?.chatgpt_account_id
  if (accountId) header['Chatgpt-Account-Id'] = accountId
  return header
}

const RESET_CREDITS_URL = 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits'

type CreditsPayload = { credits?: { reset_type?: string; status?: string; expires_at?: string }[] }

// Expiry dates of available credits; optional, so failures just mean no dates.
async function creditExpiries(f: AuthFile): Promise<number[]> {
  try {
    const body = (await upstreamGet(f.auth_index, RESET_CREDITS_URL, {
      ...codexHeaders(f),
      Accept: 'application/json',
      'OpenAI-Beta': 'codex-1',
      Originator: 'Codex Desktop',
    })) as CreditsPayload
    return (body.credits ?? [])
      .filter((c) => c.reset_type === 'codex_rate_limits' && c.status === 'available' && c.expires_at)
      .map((c) => Date.parse(c.expires_at!))
      .filter(Number.isFinite)
      .sort((a, b) => a - b)
  } catch {
    return []
  }
}

// Spends one reset credit. Irreversible; the UI confirms first.
export async function spendResetCredit(f: AuthFile) {
  await upstreamCall(
    f.auth_index,
    'POST',
    `${RESET_CREDITS_URL}/consume`,
    codexHeaders(f),
    JSON.stringify({ redeem_request_id: crypto.randomUUID() }),
  )
}

async function codexQuota(f: AuthFile): Promise<Quota> {
  const usage = (await upstreamGet(f.auth_index, 'https://chatgpt.com/backend-api/wham/usage', codexHeaders(f))) as CodexUsage
  const available = usage.rate_limit_reset_credits?.available_count ?? 0
  return {
    resetCredits: { available, expiresAtMs: available > 0 ? await creditExpiries(f) : [] },
    windows: [
      ...codexWindows(usage.rate_limit ?? null, ''),
      ...(usage.additional_rate_limits ?? []).flatMap((a) => codexWindows(a.rate_limit ?? null, `${a.limit_name ?? 'Extra'} `)),
    ],
    plan: usage.plan_type ?? f.id_token?.plan_type,
  }
}

// --- Muse Code (Meta) -----------------------------------------------------

// The bridge answers this call itself with the plan and usage (see
// server/src/http/meta-quota.ts); it is never forwarded to Meta as-is.
const META_MINT_URL = 'https://api.meta.ai/muse-code/key'

type MetaWindow = { used_percent?: number; resets_at?: number; window_duration_mins?: number } | null

type MetaUsage = {
  subs_tier_name?: string
  subs_usage?: { window?: MetaWindow; weekly?: MetaWindow } | null
}

function metaWindow(w: MetaWindow | undefined, id: string, label: string, periodMs: number): QuotaWindow[] {
  if (!w || typeof w.used_percent !== 'number') return []
  return [{ id, label, usedPercent: w.used_percent, resetAtMs: w.resets_at ? w.resets_at * 1000 : null, periodMs }]
}

async function metaQuota(f: AuthFile): Promise<Quota> {
  const usage = (await upstreamCall(f.auth_index, 'POST', META_MINT_URL, {})) as MetaUsage
  const window = usage.subs_usage?.window
  const windows = [
    ...metaWindow(window, 'session', '5-hour', (window?.window_duration_mins ?? 300) * 60e3),
    ...metaWindow(usage.subs_usage?.weekly, 'weekly', 'Weekly', WEEK),
  ]
  if (!windows.length) {
    throw new QuotaUnavailableError('Meta returned no usage percentages. Any percentages shown are the last reported reading, not current quota.')
  }
  return {
    windows,
    plan: usage.subs_tier_name?.replace(/^Muse Code /, '').replace(/ Usage$/, ''),
  }
}

// --- xAI (Grok) -----------------------------------------------------------

// The billing endpoint the Grok Build CLI reads. It answers in proto3 JSON,
// which omits zero values, so a missing percentage means nothing used yet.
const XAI_BILLING_URL = 'https://cli-chat-proxy.grok.com/v1/billing?format=credits'

const XAI_HEADERS = {
  Authorization: 'Bearer $TOKEN$',
  'X-XAI-Token-Auth': 'xai-grok-cli',
  'x-grok-client-version': '1.0.46',
  Accept: 'application/json',
}

type XaiBilling = {
  config?: {
    currentPeriod?: { type?: string; start?: string; end?: string }
    creditUsagePercent?: number
  }
} | null

async function xaiQuota(f: AuthFile): Promise<Quota> {
  const { currentPeriod: period, creditUsagePercent } = ((await upstreamGet(f.auth_index, XAI_BILLING_URL, XAI_HEADERS)) as XaiBilling)?.config ?? {}
  if (!period) throw new QuotaUnavailableError('xAI returned no usage period.')
  const start = parseTime(period.start)
  const resetAtMs = parseTime(period.end)
  const monthly = period.type === 'USAGE_PERIOD_TYPE_MONTHLY'
  const periodMs = monthly ? (start && resetAtMs && resetAtMs > start ? resetAtMs - start : 30 * 24 * HOUR) : WEEK
  return {
    windows: [{ id: monthly ? 'monthly' : 'weekly', label: monthly ? 'Monthly' : 'Weekly', usedPercent: creditUsagePercent ?? 0, resetAtMs, periodMs }],
  }
}

// --------------------------------------------------------------------------

export const PROVIDER_NAMES: Record<string, string> = { claude: 'Claude', codex: 'Codex', meta: 'Muse Code', xai: 'Grok' }

export function supportsQuota(f: AuthFile) {
  return providerOf(f) in PROVIDER_NAMES
}

const QUOTA_FETCHERS: Record<string, (f: AuthFile) => Promise<Quota>> = { claude: claudeQuota, codex: codexQuota, meta: metaQuota, xai: xaiQuota }

export function fetchQuota(f: AuthFile): Promise<Quota> {
  return QUOTA_FETCHERS[providerOf(f)](f)
}
