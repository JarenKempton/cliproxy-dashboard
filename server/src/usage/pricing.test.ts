import { describe, expect, test } from 'bun:test'
import { openDb } from '../db/client'
import { PriceBook } from './pricing'

// Minimal stand-in for LiteLLM's table: only the Meta rows that exist there
// today. Wonder Full and Wonder's contributor variant have no row anywhere.
const TABLE = {
  'meta/muse-wonder-1.0': { litellm_provider: 'meta', input_cost_per_token: 4e-6, output_cost_per_token: 2e-5, cache_read_input_token_cost: 2e-7 },
  'meta/muse-spark-1.3-contributor': { litellm_provider: 'meta', input_cost_per_token: 1e-7, output_cost_per_token: 2e-7, cache_read_input_token_cost: 2e-9 },
}

function book() {
  const b = new PriceBook(openDb(':memory:'), '/nonexistent/prices.json')
  ;(b as unknown as { table: typeof TABLE }).table = TABLE
  return b
}

describe('muse fallback pricing', () => {
  test('prices Wonder Full at standard Wonder rates', () => {
    const priced = book().lookup('muse-wonder-full-1.0')
    expect(priced?.rates).toEqual({ input: 4_000_000, output: 20_000_000, cacheRead: 200_000, cacheWrite: null })
    expect(priced?.pricedAs).toContain('muse-wonder-1.0')
  })

  test('prices unlisted contributor variants at the contributor rate', () => {
    for (const model of ['muse-wonder-1.0-contributor', 'muse-wonder-full-1.0-contributor']) {
      expect(book().lookup(model)?.rates).toEqual({ input: 100_000, output: 200_000, cacheRead: 2_000, cacheWrite: null })
    }
  })

  test('table entries win over the fallback', () => {
    const priced = book().lookup('muse-spark-1.3-contributor')
    expect(priced?.pricedAs).toBe('meta/muse-spark-1.3-contributor')
  })

  test('unknown models stay unpriced', () => {
    expect(book().lookup('muse-nonexistent-9.9')).toBeNull()
    expect(book().lookup('totally-unknown')).toBeNull()
  })
})
