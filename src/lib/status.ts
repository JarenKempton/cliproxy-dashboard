import type { AuthFile } from './api'
import { formatRelative } from './format'

export type Tone = 'good' | 'warn' | 'bad' | 'off'

// status_message is often a raw upstream JSON error body.
function friendlyMessage(raw?: string): string | undefined {
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

export function accountStatus(f: AuthFile, now: number): { tone: Tone; text: string } {
  if (f.disabled) return { tone: 'off', text: 'Off' }
  const message = friendlyMessage(f.status_message)
  const cooldown = (f.cooldowns ?? [])
    .map((c) => Date.parse(c.retry_at))
    .filter((t) => t > now)
    .sort((a, b) => b - a)[0]
  if (cooldown) return { tone: 'warn', text: `${message ?? 'Cooling down'} · back ${formatRelative(cooldown, now)}` }
  if (f.unavailable || f.status === 'error') return { tone: 'bad', text: message ?? 'Error' }
  return { tone: 'good', text: 'Active' }
}
