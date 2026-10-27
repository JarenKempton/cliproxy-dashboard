// Turns a failed quota lookup into something a person can act on.

import { ApiError, UpstreamError } from './api'
import { QuotaUnavailableError } from './quota'

const DEFAULT_BACKOFF_MS = 10 * 60e3

export type QuotaError = {
  title: string
  hint: string
  code: string // compact technical line: "HTTP 429 · rate_limit_error"
  message?: string // provider's own words
  retryAt?: number
}

export function describeQuotaError(err: unknown, provider: string): QuotaError {
  const who = ({ codex: 'OpenAI', meta: 'Meta' } as Record<string, string>)[provider] ?? 'Anthropic'
  if (err instanceof QuotaUnavailableError) {
    return { title: 'Quota unavailable', hint: `${who} omitted usage from a successful response. The dashboard will check again on its next refresh.`, code: 'no_usage', message: err.message }
  }
  if (err instanceof UpstreamError) {
    const code = [`HTTP ${err.status}`, err.type].filter(Boolean).join(' · ')
    // A 429 without Retry-After still backs off, so polling doesn't prolong it.
    const retryMs = err.retryAfterMs ?? (err.status === 429 ? DEFAULT_BACKOFF_MS : undefined)
    const base = { code, message: err.detail, retryAt: retryMs ? Date.now() + retryMs : undefined }
    if (err.status === 429)
      return { ...base, title: 'Rate-limited', hint: `${who} is limiting how often this account’s usage can be checked. The dashboard will wait before asking again.` }
    if (err.status === 401)
      return { ...base, title: 'Login expired', hint: `${who} rejected the saved login. The proxy usually refreshes it on its own; if this persists, log in again from Accounts.` }
    if (err.status === 403)
      return { ...base, title: 'Access denied', hint: `${who} refused the usage request. This often happens right after an account is turned back on, before its login is refreshed.` }
    if (err.status >= 500) return { ...base, title: `${who} is having trouble`, hint: 'Their usage service returned an error. Try again shortly.' }
    return { ...base, title: 'Lookup failed', hint: `${who} returned an unexpected response.` }
  }
  if (err instanceof ApiError) {
    return { title: err.guard ? 'Blocked by the dev bridge' : 'Proxy error', hint: 'The request didn’t reach the provider.', code: `HTTP ${err.status}`, message: err.message }
  }
  return { title: 'Couldn’t reach the proxy', hint: 'Check that CLIProxyAPI and the dev server are running.', code: 'network', message: (err as Error)?.message }
}
