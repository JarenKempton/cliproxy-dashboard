// Collects CLIProxyAPI usage records into the database.
//
// The proxy keeps records in memory only (up to the configured retention,
// max 1 hour) and reading one removes it. So this must be the only consumer:
//
// 1. Subscribe to the "usage" channel: new records are pushed to us live.
// 2. Then drain anything that queued while we weren't subscribed (LPOP).
// 3. On any disconnect, back off and repeat.
//
// Inserts are idempotent, so a record seen twice is stored once.

import type { Db } from '../db/client'
import { requests } from '../db/schema'
import { isUsageRecord, toRequestRow } from '../usage/cliproxy-record'
import type { PriceBook } from '../usage/pricing'
import { RespConnection } from './resp'

const CHANNEL = 'usage'
const DRAIN_BATCH = 500
const MAX_BACKOFF_MS = 30e3

export type CollectorStatus = {
  connected: boolean
  since: number | null
  lastRecordAt: number | null
  stored: number
  lastError: string | null
}

type Options = { host: string; port: number; managementKey: string }

export class CliproxyCollector {
  status: CollectorStatus = { connected: false, since: null, lastRecordAt: null, stored: 0, lastError: null }
  private backoffMs = 1000

  constructor(
    private db: Db,
    private prices: PriceBook,
    private options: Options,
  ) {}

  start() {
    void this.run()
  }

  private async run() {
    const sub = new RespConnection()
    try {
      await sub.connect(this.options.host, this.options.port)
      await sub.command('AUTH', this.options.managementKey)
      sub.onMessage = (_channel, payload) => this.store(payload)
      await sub.command('SUBSCRIBE', CHANNEL)

      this.status = { ...this.status, connected: true, since: Date.now(), lastError: null }
      this.backoffMs = 1000
      console.log('[collector] subscribed to CLIProxyAPI usage')

      await this.drainQueue()
      await new Promise<void>((resolve) => (sub.onClose = () => resolve()))
      this.status.lastError = 'connection closed'
    } catch (err) {
      this.status.lastError = (err as Error).message
    } finally {
      sub.close()
      this.status.connected = false
    }

    console.warn(`[collector] disconnected (${this.status.lastError}); retrying in ${this.backoffMs / 1000}s`)
    setTimeout(() => this.run(), this.backoffMs)
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS)
  }

  // Records published while nobody was subscribed wait in the queue.
  private async drainQueue() {
    const conn = new RespConnection()
    try {
      await conn.connect(this.options.host, this.options.port)
      await conn.command('AUTH', this.options.managementKey)
      let drained = 0
      for (;;) {
        const batch = await conn.command('LPOP', CHANNEL, DRAIN_BATCH)
        if (!Array.isArray(batch) || batch.length === 0) break
        for (const payload of batch) if (typeof payload === 'string') this.store(payload)
        drained += batch.length
      }
      if (drained) console.log(`[collector] drained ${drained} queued records`)
    } finally {
      conn.close()
    }
  }

  private store(payload: string) {
    let record: unknown
    try {
      record = JSON.parse(payload)
    } catch {
      return
    }
    if (!isUsageRecord(record)) return

    const inserted = this.db
      .insert(requests)
      .values(toRequestRow(record, this.prices))
      .onConflictDoNothing()
      .returning({ id: requests.id })
      .all()
    if (inserted.length) {
      this.status.stored += 1
      this.status.lastRecordAt = Date.now()
    }
  }
}
