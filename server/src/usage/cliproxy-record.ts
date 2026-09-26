// CLIProxyAPI's per-request usage record (internal/redisqueue/plugin.go) and
// its mapping to a `requests` row.

import { createHash } from 'node:crypto'
import type { requests } from '../db/schema'
import { costOf, type PriceBook } from './pricing'

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

// Control messages on the usage stream carry no request (e.g. {"support_refresh":true}).
export function isUsageRecord(value: unknown): value is CliproxyRecord {
  const r = value as CliproxyRecord
  return typeof r?.timestamp === 'string' && typeof r?.model === 'string' && typeof r?.request_id === 'string'
}

export function toRequestRow(r: CliproxyRecord, prices: PriceBook): RequestRow {
  const tokens = tokensOf(r)
  const model = r.response_model || r.model
  const price = prices.lookup(model)

  return {
    id: `cliproxy:${r.execution_id || r.request_id}:${r.timestamp}`,
    source: 'cliproxy',
    occurredAt: new Date(r.timestamp),
    receivedAt: new Date(),

    provider: r.provider,
    model,
    requestedModel: r.alias || null,

    accountRef: r.auth_index || null,
    accountLabel: r.source || null,

    clientKeyHash: r.api_key ? hashKey(r.api_key) : null,
    clientIp: clientIpOf(r),
    userAgent: r.user_agent || null,
    tool: toolOf(r.user_agent),
    sessionId: r.session_id || null,
    endpoint: r.endpoint || null,

    failed: r.failed,
    statusCode: r.fail?.status_code ?? null,
    latencyMs: r.latency_ms ?? null,
    timeToFirstTokenMs: r.ttft_ms ?? null,

    inputTokens: tokens.input,
    cacheReadTokens: tokens.cacheRead,
    cacheWriteTokens: tokens.cacheWrite,
    outputTokens: tokens.output,
    reasoningTokens: tokens.reasoning,

    costMicros: price ? costOf(tokens, price.rates) : null,
    pricedAs: price?.pricedAs ?? null,
  }
}

function tokensOf(r: CliproxyRecord) {
  const b = r.token_breakdown
  if (b?.input && b.output) {
    return {
      input: b.input.uncached_tokens ?? null,
      cacheRead: b.input.cache_read_tokens ?? null,
      cacheWrite: b.input.cache_write_tokens ?? null,
      output: b.output.total_tokens ?? null,
      reasoning: b.output.reasoning_tokens ?? null,
    }
  }
  // Older records: input_tokens excludes cache tokens for Claude; best effort.
  const t = r.tokens ?? {}
  return {
    input: t.input_tokens ?? null,
    cacheRead: t.cache_read_tokens ?? null,
    cacheWrite: t.cache_creation_tokens ?? null,
    output: t.output_tokens ?? null,
    reasoning: t.reasoning_tokens ?? null,
  }
}

// Store only a short hash: enough to tell keys apart, useless as a credential.
export function hashKey(key: string) {
  return createHash('sha256').update(key).digest('hex').slice(0, 16)
}

// Requests forwarded by `tailscale serve` arrive from 127.0.0.1 with the
// real tailnet address in X-Forwarded-For.
function clientIpOf(r: CliproxyRecord) {
  const forwarded = r.x_forwarded_for?.split(',')[0]?.trim()
  return forwarded || r.client_ip || null
}

function toolOf(userAgent?: string) {
  if (!userAgent) return null
  if (userAgent.startsWith('claude-cli')) return 'claude-code'
  if (/codex/i.test(userAgent)) return 'codex'
  return userAgent.split(/[/ ]/)[0] || null
}
