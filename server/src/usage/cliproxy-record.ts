// CLIProxyAPI's per-request usage record (internal/redisqueue/plugin.go) and
// its mapping to a `requests` row.

import { createHash } from 'node:crypto'
import type { requests } from '../db/schema'
import { cacheSavingsOf, costOf, type PriceBook } from './pricing'

// The fields we use; the record carries more.
export type CliproxyRecord = {
  timestamp: string
  request_id: string
  execution_id?: string
  provider: string
  model: string
  alias?: string
  response_model?: string
  endpoint?: string
  auth_index?: string
  source?: string // account label, e.g. the account's email
  api_key?: string
  client_ip?: string
  x_forwarded_for?: string
  user_agent?: string
  session_id?: string
  latency_ms?: number
  ttft_ms?: number
  failed: boolean
  fail?: { status_code?: number }
  tokens?: {
    input_tokens?: number
    output_tokens?: number
    reasoning_tokens?: number
    cache_read_tokens?: number
    cache_creation_tokens?: number
  }
  // v2 accounting: non-overlapping split, preferred when present.
  token_breakdown?: {
    quality?: string
    input?: { uncached_tokens?: number; cache_read_tokens?: number; cache_write_tokens?: number }
    output?: { total_tokens?: number; reasoning_tokens?: number }
  }
}

type RequestRow = typeof requests.$inferInsert

const strOrNull = (v: unknown) => (typeof v === 'string' && v.length > 0 ? v : null)
const intOrNull = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : null)

// Control messages on the usage stream carry no request (e.g. {"support_refresh":true}).
export function isUsageRecord(value: unknown): value is CliproxyRecord {
  if (!value || typeof value !== 'object') return false
  const r = value as Partial<CliproxyRecord>
  const hasId =
    (typeof r.execution_id === 'string' && r.execution_id.length > 0) ||
    (typeof r.request_id === 'string' && r.request_id.length > 0)
  return (
    typeof r.timestamp === 'string' &&
    Number.isFinite(Date.parse(r.timestamp)) &&
    typeof r.model === 'string' &&
    r.model.length > 0 &&
    hasId
  )
}

export function toRequestRow(r: CliproxyRecord, prices: PriceBook): RequestRow {
  const occurredMs = Date.parse(r.timestamp)
  if (!Number.isFinite(occurredMs)) {
    throw new Error(`Invalid usage record timestamp: ${JSON.stringify(r.timestamp)}`)
  }
  const idPart = strOrNull(r.execution_id) || strOrNull(r.request_id)
  if (!idPart) {
    throw new Error('Usage record missing execution_id and request_id')
  }
  const tokens = tokensOf(r)
  const model = strOrNull(r.response_model) || r.model
  const price = prices.lookup(model)
  const userAgent = strOrNull(r.user_agent)

  return {
    id: `cliproxy:${idPart}:${r.timestamp}`,
    source: 'cliproxy',
    occurredAt: new Date(occurredMs),
    receivedAt: new Date(),

    provider: typeof r.provider === 'string' ? r.provider : '',
    model,
    requestedModel: strOrNull(r.alias),

    accountRef: strOrNull(r.auth_index),
    accountLabel: strOrNull(r.source),

    clientKeyHash: typeof r.api_key === 'string' && r.api_key.length > 0 ? hashKey(r.api_key) : null,
    clientIp: clientIpOf(r),
    userAgent,
    tool: toolOf(userAgent ?? undefined),
    sessionId: strOrNull(r.session_id),
    endpoint: strOrNull(r.endpoint),

    failed: Boolean(r.failed),
    statusCode: intOrNull(r.fail?.status_code),
    latencyMs: intOrNull(r.latency_ms),
    timeToFirstTokenMs: intOrNull(r.ttft_ms),

    inputTokens: tokens.input,
    cacheReadTokens: tokens.cacheRead,
    cacheWriteTokens: tokens.cacheWrite,
    outputTokens: tokens.output,
    reasoningTokens: tokens.reasoning,

    costMicros: price ? costOf(tokens, price.rates) : null,
    cacheSavingsMicros: price ? cacheSavingsOf(tokens, price.rates) : null,
    pricedAs: price?.pricedAs ?? null,
  }
}

function tokensOf(r: CliproxyRecord) {
  const b = r.token_breakdown
  if (b?.input && b.output) {
    return {
      input: intOrNull(b.input.uncached_tokens),
      cacheRead: intOrNull(b.input.cache_read_tokens),
      cacheWrite: intOrNull(b.input.cache_write_tokens),
      output: intOrNull(b.output.total_tokens),
      reasoning: intOrNull(b.output.reasoning_tokens),
    }
  }
  // Older records: input_tokens excludes cache tokens for Claude; best effort.
  const t = r.tokens ?? {}
  return {
    input: intOrNull(t.input_tokens),
    cacheRead: intOrNull(t.cache_read_tokens),
    cacheWrite: intOrNull(t.cache_creation_tokens),
    output: intOrNull(t.output_tokens),
    reasoning: intOrNull(t.reasoning_tokens),
  }
}

// Store only a short hash: enough to tell keys apart, useless as a credential.
export function hashKey(key: string) {
  return createHash('sha256').update(key).digest('hex').slice(0, 16)
}

// Requests forwarded by `tailscale serve` arrive from 127.0.0.1 with the
// real tailnet address in X-Forwarded-For.
function clientIpOf(r: CliproxyRecord) {
  const forwarded = typeof r.x_forwarded_for === 'string' ? r.x_forwarded_for.split(',')[0]?.trim() : undefined
  return forwarded || strOrNull(r.client_ip)
}

function toolOf(userAgent?: string) {
  if (!userAgent) return null
  if (userAgent.startsWith('claude-cli')) return 'claude-code'
  if (userAgent.startsWith('muse')) return 'muse-code'
  if (/codex/i.test(userAgent)) return 'codex'
  return userAgent.split(/[/ ]/)[0] || null
}
