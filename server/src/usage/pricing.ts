// API-equivalent pricing from LiteLLM's public price table, with manual
// overrides from the database taking precedence.
//
// Subscription accounts aren't billed per token; this answers "what would
// this usage have cost on the pay-as-you-go API".

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Db } from '../db/client'
import { priceOverrides } from '../db/schema'

const PRICE_TABLE_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json'
const REFRESH_EVERY_MS = 24 * 3600e3

// Micro-dollars per million tokens.
export type Rates = {
  input: number
  output: number
  cacheRead: number | null
  cacheWrite: number | null
}

export type Tokens = {
  input: number | null
  cacheRead: number | null
  cacheWrite: number | null
  output: number | null
}

type LiteLlmEntry = {
  litellm_provider?: string
  mode?: string
  input_cost_per_token?: number
  output_cost_per_token?: number
  cache_read_input_token_cost?: number
  cache_creation_input_token_cost?: number
}

// USD per token → micro-dollars per million tokens.
const perMTok = (usdPerToken: number) => Math.round(usdPerToken * 1e12)

// Providers whose own list prices we prefer when a model appears under several.
const FIRST_PARTY = ['anthropic', 'openai']

export class PriceBook {
  private table: Record<string, LiteLlmEntry> = {}
  private overrides = new Map<string, Rates>()
  loadedAt: number | null = null

  constructor(
    private db: Db,
    private cachePath: string,
  ) {}

  async start() {
    this.loadOverrides()
    this.loadCache()
    await this.refresh()
    setInterval(() => this.refresh(), REFRESH_EVERY_MS)
  }

  // Downloads the latest table; on failure keeps whatever is cached.
  async refresh() {
    try {
      const res = await fetch(PRICE_TABLE_URL)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const text = await res.text()
      this.table = JSON.parse(text)
      this.loadedAt = Date.now()
      mkdirSync(dirname(this.cachePath), { recursive: true })
      writeFileSync(this.cachePath, text)
    } catch (err) {
      console.warn(`[pricing] refresh failed, using cached table: ${(err as Error).message}`)
    }
  }

  loadOverrides() {
    this.overrides.clear()
    for (const row of this.db.select().from(priceOverrides).all()) {
      this.overrides.set(row.model, {
        input: row.inputPerMTok,
        output: row.outputPerMTok,
        cacheRead: row.cacheReadPerMTok,
        cacheWrite: row.cacheWritePerMTok,
      })
    }
  }

  private loadCache() {
    try {
      this.table = JSON.parse(readFileSync(this.cachePath, 'utf8'))
      this.loadedAt = Date.now()
    } catch {
      // no cache yet
    }
  }

  // Finds rates for a model name, returning the entry name used.
  lookup(model: string): { rates: Rates; pricedAs: string } | null {
    const override = this.overrides.get(model)
    if (override) return { rates: override, pricedAs: `override:${model}` }

    const exact = this.table[model]
    if (exact && FIRST_PARTY.includes(exact.litellm_provider ?? '')) return this.toRates(model, exact)

    // Otherwise the same model listed by a reseller ("azure/gpt-6-luna"), first-party first.
    const candidates = Object.entries(this.table).filter(([key]) => key === model || key.endsWith(`/${model}`))
    candidates.sort(([, a], [, b]) => rank(a) - rank(b))
    for (const [key, entry] of candidates) {
      const priced = this.toRates(key, entry)
      if (priced) return priced
    }
    return null
  }

  private toRates(key: string, e: LiteLlmEntry) {
    if (e.input_cost_per_token == null || e.output_cost_per_token == null) return null
    return {
      pricedAs: key,
      rates: {
        input: perMTok(e.input_cost_per_token),
        output: perMTok(e.output_cost_per_token),
        cacheRead: e.cache_read_input_token_cost == null ? null : perMTok(e.cache_read_input_token_cost),
        cacheWrite: e.cache_creation_input_token_cost == null ? null : perMTok(e.cache_creation_input_token_cost),
      },
    }
  }
}

function rank(e: LiteLlmEntry) {
  const i = FIRST_PARTY.indexOf(e.litellm_provider ?? '')
  return i === -1 ? FIRST_PARTY.length : i
}

// Cost in micro-dollars. Cache tokens without a cache rate are charged at the
// plain input rate, which overstates rather than hides them.
export function costOf(tokens: Tokens, rates: Rates): number {
  const micros =
    (tokens.input ?? 0) * rates.input +
    (tokens.cacheRead ?? 0) * (rates.cacheRead ?? rates.input) +
    (tokens.cacheWrite ?? 0) * (rates.cacheWrite ?? rates.input) +
    (tokens.output ?? 0) * rates.output
  return Math.round(micros / 1e6)
}
