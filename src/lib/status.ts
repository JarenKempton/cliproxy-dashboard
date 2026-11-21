import type { AuthFile } from './api'
import { formatRelative } from './format'
import type { QuotaWindow } from './quota'

export type Tone = 'good' | 'warn' | 'bad' | 'off'

// status_message is often a raw upstream JSON error body.
export function friendlyMessage(raw?: string): string | undefined {
  if (!raw) return undefined
  try {
    const parsed = JSON.parse(raw)
    const err = parsed.error ?? parsed
    if (err.type === 'usage_limit_reached' || err.type === 'rate_limit_error') return 'Usage limit reached'
    if (typeof err.message === 'string') return err.message
  } catch {
    // not JSON
  }
  return raw
}

export function cooldownUntil(f: AuthFile, now: number): number | undefined {
  return (f.cooldowns ?? [])
    .map((c) => Date.parse(c.retry_at))
    .filter((t) => t > now)
    .sort((a, b) => b - a)[0]
}

export function accountStatus(f: AuthFile, now: number): { tone: Tone; text: string } {
  if (f.disabled) return { tone: 'off', text: 'Off' }
  const message = friendlyMessage(f.status_message)
  const cooldown = cooldownUntil(f, now)
  if (cooldown) return { tone: 'warn', text: `${message ?? 'Cooling down'} · back ${formatRelative(cooldown, now)}` }
  if (f.unavailable || f.status === 'error') return { tone: 'bad', text: message ?? 'Error' }
  return { tone: 'good', text: 'Active' }
}

export type Limit = { reason: string; until: number | null; binding?: QuotaWindow }

export function quotaLimit(f: AuthFile, windows: QuotaWindow[], now: number): Limit | null {
  if (f.disabled) return null
  const cooldown = cooldownUntil(f, now)
  const binding = windows
    .filter((w) => w.usedPercent >= 100)
    .sort((a, b) => (b.resetAtMs ?? Infinity) - (a.resetAtMs ?? Infinity))[0]
  if (!binding && !cooldown) return null
  const reset = binding?.resetAtMs && binding.resetAtMs > now ? binding.resetAtMs : null
  const until = Math.max(reset ?? 0, cooldown ?? 0) || null
  const reason = binding ? `${binding.label} limit reached` : friendlyMessage(f.status_message) ?? 'Cooling down'
  return { reason, until, binding }
}
