// Fills in cost and cache savings for stored requests that are missing them:
// rows from before a column existed, or models the price table has since added.

import { eq, isNull, or } from 'drizzle-orm'
import type { Db } from '../db/client'
import { requests } from '../db/schema'
import { cacheSavingsOf, costOf, type PriceBook } from './pricing'

export function repriceMissing(db: Db, prices: PriceBook) {
  const rows = db
    .select()
    .from(requests)
    .where(or(isNull(requests.costMicros), isNull(requests.cacheSavingsMicros)))
    .all()

  let updated = 0
  db.transaction((tx) => {
    for (const row of rows) {
      const price = prices.lookup(row.model)
      if (!price) continue
      const tokens = {
        input: row.inputTokens,
        cacheRead: row.cacheReadTokens,
        cacheWrite: row.cacheWriteTokens,
        output: row.outputTokens,
      }
      tx.update(requests)
        .set({
          costMicros: costOf(tokens, price.rates),
          cacheSavingsMicros: cacheSavingsOf(tokens, price.rates),
          pricedAs: price.pricedAs,
        })
        .where(eq(requests.id, row.id))
        .run()
      updated++
    }
  })
  if (updated) console.log(`[pricing] priced ${updated} stored requests`)
}
