// Imports transcript history as requests, for the time before the proxy
// collector existed. Anything at or after the first proxy-collected request is
// skipped, so imported history and live collection never overlap.

import { createHash } from 'node:crypto'
import { eq, min } from 'drizzle-orm'
import type { Db } from '../db/client'
import { requests } from '../db/schema'
import { cacheSavingsOf, costOf, type PriceBook } from '../usage/pricing'
import { newCodexState, parseClaudeLine, parseCodexLine, type TranscriptRecord } from './transcripts'

export type TranscriptFile = { tool: 'claude-code' | 'codex'; lines: string[] }

export type ImportResult = { imported: number; alreadyImported: number; afterCutoff: number; cutoffMs: number }

// When live collection began: the first request received from the proxy.
function collectionStart(db: Db): number {
  const row = db
    .select({ first: min(requests.occurredAt) })
    .from(requests)
    .where(eq(requests.source, 'cliproxy'))
    .get()
  return row?.first ? row.first.getTime() : Date.now()
}

function parseFile(file: TranscriptFile): TranscriptRecord[] {
  if (file.tool === 'claude-code') return file.lines.map(parseClaudeLine).filter((r) => r !== null)
  const state = newCodexState()
  return file.lines.map((line) => parseCodexLine(line, state)).filter((r) => r !== null)
}

// `clientIp` is the machine the history came from (its tailnet IP, or
// 127.0.0.1 for this machine), so it gets that machine's name.
export function importTranscripts(db: Db, prices: PriceBook, files: TranscriptFile[], clientIp: string): ImportResult {
  const cutoffMs = collectionStart(db)
  const result: ImportResult = { imported: 0, alreadyImported: 0, afterCutoff: 0, cutoffMs }
  const seen = new Set<string>()

  db.transaction((tx) => {
    for (const record of files.flatMap(parseFile)) {
      // Claude repeats a message's usage across lines; keep the first.
      if (seen.has(record.key)) continue
      seen.add(record.key)
      if (record.timestampMs >= cutoffMs) {
        result.afterCutoff++
        continue
      }

      const tokens = { input: record.uncached, cacheRead: record.cacheRead, cacheWrite: record.cacheWrite, output: record.output }
      const price = prices.lookup(record.model)
      const inserted = tx
        .insert(requests)
        .values({
          id: `${record.tool}-log:${createHash('sha256').update(record.key).digest('hex').slice(0, 24)}`,
          source: `${record.tool}-log`,
          occurredAt: new Date(record.timestampMs),
          receivedAt: new Date(),
          provider: record.tool === 'codex' ? 'codex' : 'claude',
          model: record.model,
          clientIp,
          tool: record.tool,
          sessionId: record.sessionId || null,
          failed: false,
          inputTokens: record.uncached,
          cacheReadTokens: record.cacheRead,
          cacheWriteTokens: record.cacheWrite,
          outputTokens: record.output,
          reasoningTokens: record.reasoning,
          costMicros: price ? costOf(tokens, price.rates) : null,
          cacheSavingsMicros: price ? cacheSavingsOf(tokens, price.rates) : null,
          pricedAs: price?.pricedAs ?? null,
        })
        .onConflictDoNothing()
        .returning({ id: requests.id })
        .all()
      if (inserted.length) result.imported++
      else result.alreadyImported++
    }
  })
  return result
}
