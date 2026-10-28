import { describe, expect, test } from 'bun:test'
import { openDb } from '../db/client'
import { requests } from '../db/schema'
import { usageSummary } from './summary'

const now = Date.UTC(2026, 9, 14, 12, 30)

function fixture(rows: Partial<typeof requests.$inferInsert>[]) {
  const db = openDb(':memory:')
  db.insert(requests).values(rows.map((row, i) => ({
    id: String(i), source: 'cliproxy', occurredAt: new Date(now - 1000),
    receivedAt: new Date(now), provider: 'codex', model: 'gpt-6.1-sol',
    tool: 'claude-code', sessionId: 'session', failed: false,
    inputTokens: 100, cacheReadTokens: 200, outputTokens: 10,
    costMicros: 1000, cacheSavingsMicros: 500, ...row,
  }))).run()
  return db
}

describe('usage provider attribution', () => {
  test('merges the served model across harnesses in every breakdown', () => {
    const db = fixture([
      { provider: 'codex', tool: 'claude-code' },
      { provider: 'openai', tool: 'OpenAI', sessionId: 'sdk' },
      { provider: 'codex', tool: 'T3', sessionId: 'chat' },
      // Historical imports incorrectly inherited their provider from the client.
      { source: 'claude-code-log', provider: 'claude', sessionId: 'history' },
      { model: 'claude-opus-5-5', provider: 'openai' },
    ])
    const summary = usageSummary(db, '24h', 'UTC', now)
    const openai = summary.providers.find((p) => p.provider === 'openai')!
    expect(summary.providers.map((p) => p.provider).sort()).toEqual(['anthropic', 'openai'])
    expect(openai.costMicros).toBe(4000)
    expect(openai.processedTokens).toBe(1240)
    expect(openai.sessions).toBe(4)
    expect(summary.byModel).toHaveLength(2)
    expect(summary.byModel[0]).toMatchObject({ provider: 'openai', model: 'gpt-6.1-sol', records: 4 })
    expect(summary.byMachine[0].models).toHaveLength(2)
    expect(summary.series.at(-1)?.providers.openai).toEqual({ costMicros: 4000, tokens: 1240 })
    expect(summary.totals).toMatchObject({ costMicros: 5000, cacheSavingsMicros: 2500, records: 5, sessions: 4 })
    // Preserve provenance and upstream routing information in storage.
    expect(db.select().from(requests).all()[3]).toMatchObject({ tool: 'claude-code', provider: 'claude' })
  })

  test('recognizes namespaced models and uses upstream only for opaque names', () => {
    const db = fixture([
      { model: ' OpenAI/GPT-6.1-SOL ', provider: 'claude' },
      { model: 'anthropic/claude-opus-5-5', provider: 'codex' },
      { model: 'o3-mini', provider: 'claude' },
      { model: 'gemini-2.5-pro', provider: 'openai' },
      { model: 'opaque-alias', provider: 'codex' },
      { model: 'opaque-alias', provider: 'T3', tool: 'T3' },
    ])
    const summary = usageSummary(db, '24h', 'UTC', now)
    expect(summary.providers.map((p) => [p.provider, p.records]).sort()).toEqual([
      ['anthropic', 1], ['gemini', 1], ['openai', 3], ['unknown', 1],
    ])
  })

  test('counts a failover session once overall and scopes ids to their client', () => {
    const db = fixture([
      {},
      { model: 'claude-opus-5-5', provider: 'claude' },
      { tool: 'codex' }, // same session string, different client
      { sessionId: null },
      { occurredAt: new Date(now - 48 * 3600e3), sessionId: 'old' },
    ])
    const summary = usageSummary(db, '24h', 'UTC', now)
    expect(summary.totals.sessions).toBe(2)
    expect(summary.providers.find((p) => p.provider === 'openai')?.sessions).toBe(2)
    expect(summary.providers.find((p) => p.provider === 'anthropic')?.sessions).toBe(1)
    expect(summary.totals.records).toBe(4)
  })

  test('maps grok-* models to xai vendor', () => {
    const db = fixture([
      { model: 'xai/grok-4.3', provider: 'codex' },
      { model: 'grok-4-fast', provider: 'claude' },
      { model: 'grok-beta', provider: 'openai' },
    ])
    const summary = usageSummary(db, '24h', 'UTC', now)
    expect(summary.providers.map((p) => [p.provider, p.records]).sort()).toEqual([['xai', 3]])
    // All three grok-* models are attributed to xai; exact order depends on stable sort of equal-cost rows.
    expect(summary.byModel).toHaveLength(3)
    expect(summary.byModel.every((m) => m.provider === 'xai')).toBe(true)
    const models = summary.byModel.map((m) => m.model).sort()
    expect(models).toEqual(['grok-4-fast', 'grok-beta', 'xai/grok-4.3'])
  })
})
