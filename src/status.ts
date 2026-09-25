import type { AuthFile } from './api'
import type { Status } from './components/StatusIcon'
import { formatWhen } from './format'

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

export function accountStatus(f: AuthFile, now: number): { status: Status; text: string } {
  if (f.disabled) return { status: 'neutral', text: 'Off' }
  const message = friendlyMessage(f.status_message)
  const cooldown = (f.cooldowns ?? [])
    .map((c) => Date.parse(c.retry_at))
    .filter((t) => t > now)
    .sort((a, b) => b - a)[0]
  if (cooldown) return { status: 'warning', text: `${message ?? 'Cooling down'} · back ${formatWhen(cooldown, now)}` }
  if (f.unavailable || f.status === 'error') return { status: 'critical', text: message ?? 'Error' }
  return { status: 'good', text: 'Active' }
}
