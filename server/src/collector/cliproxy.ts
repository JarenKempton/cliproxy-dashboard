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
import { RespConnection, RespError } from './resp'

const CHANNEL = 'usage'
const DRAIN_BATCH = 500
const INSERT_CHUNK_SIZE = 250
const MAX_PENDING_ROWS = 5000
const INITIAL_BACKOFF_MS = 1000
const MAX_BACKOFF_MS = 30e3
const PING_INTERVAL_MS = 30e3
const PING_TIMEOUT_MS = 10e3
const DRAIN_TIMEOUT_MS = 15e3

type RequestRow = ReturnType<typeof toRequestRow>

function isRetryableDbError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { code?: unknown; message?: unknown; cause?: unknown }
  const code = typeof e.code === 'string' ? e.code : ''
  const msg = typeof e.message === 'string' ? e.message.toLowerCase() : ''
  if (
    code.startsWith('SQLITE_BUSY') ||
    code.startsWith('SQLITE_LOCKED') ||
    msg.includes('sqlite_busy') ||
    msg.includes('sqlite_locked') ||
    msg.includes('database is locked') ||
    msg.includes('database table is locked')
  ) {
    return true
  }
  return e.cause ? isRetryableDbError(e.cause) : false
}

class AuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AuthError'
  }
}

export type CollectorStatus = {
  connected: boolean
  since: number | null
  lastRecordAt: number | null
  stored: number
  lastError: string | null
}

type Options = {
  host: string
  port: number
  managementKey: string
  pingIntervalMs?: number
  pingTimeoutMs?: number
  drainTimeoutMs?: number
  initialBackoffMs?: number
  maxBackoffMs?: number
}

export class CliproxyCollector {
  status: CollectorStatus = { connected: false, since: null, lastRecordAt: null, stored: 0, lastError: null }
  private backoffMs: number
  private stopped = false
  private activeSub?: RespConnection
  private activeDrain?: RespConnection
  private retryTimer?: ReturnType<typeof setTimeout>
  private pendingFlushTimer?: ReturnType<typeof setTimeout>
  private pendingRows: RequestRow[] = []

  constructor(
    private db: Db,
    private prices: PriceBook,
    private options: Options,
  ) {
    this.backoffMs = options.initialBackoffMs ?? INITIAL_BACKOFF_MS
  }

  start() {
    this.stopped = false
    void this.run()
  }

  stop() {
    this.stopped = true
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = undefined
    }
    if (this.pendingFlushTimer) {
      clearTimeout(this.pendingFlushTimer)
      this.pendingFlushTimer = undefined
    }
    this.activeDrain?.close()
    this.activeDrain = undefined
    this.activeSub?.close()
    this.activeSub = undefined
  }

  private async run() {
    if (this.stopped) return
    const sub = new RespConnection()
    this.activeSub = sub
    let closeErr: Error | undefined
    let authFailed = false
    let subClosed = false
    const closed = new Promise<void>((resolve) => {
      sub.onClose = (err) => {
        subClosed = true
        closeErr = err
        resolve()
      }
    })
    try {
      const drainTimeoutMs = this.options.drainTimeoutMs ?? DRAIN_TIMEOUT_MS
      await sub.connect(this.options.host, this.options.port, drainTimeoutMs)
      await this.authenticate(sub, drainTimeoutMs)
      sub.onMessage = (_channel, payload) => this.store(payload)
      await sub.commandWithTimeout(drainTimeoutMs, 'SUBSCRIBE', CHANNEL)
      sub.startHeartbeat(
        this.options.pingIntervalMs ?? PING_INTERVAL_MS,
        this.options.pingTimeoutMs ?? PING_TIMEOUT_MS,
      )

      this.status = { ...this.status, connected: true, since: Date.now(), lastError: null }
      console.log('[collector] subscribed to CLIProxyAPI usage')

      await this.drainQueue(() => subClosed || this.stopped)
      this.backoffMs = this.options.initialBackoffMs ?? INITIAL_BACKOFF_MS
      await closed
      this.status.lastError = closeErr ? closeErr.message : 'connection closed'
    } catch (err) {
      if (err instanceof AuthError) authFailed = true
      this.status.lastError = closeErr ? closeErr.message : (err as Error).message
    } finally {
      this.activeDrain?.close()
      this.activeDrain = undefined
      sub.close()
      if (this.activeSub === sub) this.activeSub = undefined
      this.status.connected = false
    }

    if (this.stopped) return
    if (authFailed) {
      console.error(
        `[collector] authentication failed (${this.status.lastError}); stopping retries to avoid proxy IP ban`,
      )
      return
    }

    const maxBackoffMs = this.options.maxBackoffMs ?? MAX_BACKOFF_MS
    console.warn(`[collector] disconnected (${this.status.lastError}); retrying in ${this.backoffMs / 1000}s`)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined
      void this.run()
    }, this.backoffMs)
    this.backoffMs = Math.min(this.backoffMs * 2, maxBackoffMs)
  }

  private async authenticate(conn: RespConnection, timeoutMs: number) {
    try {
      await conn.commandWithTimeout(timeoutMs, 'AUTH', this.options.managementKey)
    } catch (err) {
      if (err instanceof RespError) {
        throw new AuthError(err.message)
      }
      throw err
    }
  }

  // Records published while nobody was subscribed wait in the queue.
  private async drainQueue(isCancelled: () => boolean) {
    // Flush any retained rows before popping new records from the proxy.
    if (this.pendingRows.length > 0) {
      const flushed = this.flushPendingRows()
      if (flushed) console.log(`[collector] flushed ${flushed} retained queued records`)
    }
    if (isCancelled()) return

    const timeoutMs = this.options.drainTimeoutMs ?? DRAIN_TIMEOUT_MS
    const conn = new RespConnection()
    this.activeDrain = conn
    try {
      await conn.connect(this.options.host, this.options.port, timeoutMs)
      if (isCancelled()) return
      await this.authenticate(conn, timeoutMs)
      let drained = 0
      for (;;) {
        if (isCancelled()) break
        const batch = await conn.commandWithTimeout(timeoutMs, 'LPOP', CHANNEL, DRAIN_BATCH)
        if (!Array.isArray(batch) || batch.length === 0) break
        const rows = this.parseBatch(batch)
        if (rows.length === 0) continue
        // Retain popped rows until the transaction commits so SQLITE_BUSY never loses them.
        this.retainRows(rows)
        drained += this.flushPendingRows()
      }
      if (drained) console.log(`[collector] drained ${drained} queued records`)
    } finally {
      conn.close()
      if (this.activeDrain === conn) this.activeDrain = undefined
    }
  }

  private parsePayload(payload: string): RequestRow | null {
    let record: unknown
    try {
      record = JSON.parse(payload)
    } catch {
      return null
    }
    if (!isUsageRecord(record)) return null
    try {
      return toRequestRow(record, this.prices)
    } catch (err) {
      console.warn('[collector] skipping invalid usage record:', err)
      return null
    }
  }

  private parseBatch(batch: unknown[]): RequestRow[] {
    const rows: RequestRow[] = []
    for (const payload of batch) {
      if (typeof payload !== 'string') continue
      const row = this.parsePayload(payload)
      if (row) rows.push(row)
    }
    return rows
  }

  private retainRows(rows: RequestRow[]) {
    if (rows.length === 0) return
    const space = MAX_PENDING_ROWS - this.pendingRows.length
    if (space <= 0) {
      console.warn(`[collector] pending retry buffer full (${MAX_PENDING_ROWS}); dropping ${rows.length} record(s)`)
      return
    }
    if (rows.length > space) {
      this.pendingRows.push(...rows.slice(0, space))
      console.warn(`[collector] pending retry buffer full (${MAX_PENDING_ROWS}); dropping ${rows.length - space} record(s)`)
      return
    }
    this.pendingRows.push(...rows)
  }

  private schedulePendingFlush() {
    if (this.stopped || this.pendingFlushTimer || this.pendingRows.length === 0) return
    const delayMs = this.options.initialBackoffMs ?? INITIAL_BACKOFF_MS
    this.pendingFlushTimer = setTimeout(() => {
      this.pendingFlushTimer = undefined
      if (this.stopped || this.pendingRows.length === 0) return
      try {
        this.flushPendingRows()
      } catch (err) {
        this.status.lastError = (err as Error).message
        console.warn('[collector] retry flush failed:', err)
        this.schedulePendingFlush()
      }
    }, delayMs)
  }

  private store(payload: string) {
    const row = this.parsePayload(payload)
    if (!row) return

    if (this.pendingRows.length > 0) {
      this.retainRows([row])
      try {
        this.flushPendingRows()
      } catch (err) {
        this.status.lastError = (err as Error).message
        console.warn('[collector] failed to flush pending usage records:', err)
        this.schedulePendingFlush()
      }
      return
    }

    try {
      const inserted = this.db
        .insert(requests)
        .values(row)
        .onConflictDoNothing()
        .returning({ id: requests.id })
        .get()
      if (inserted) {
        this.status.stored += 1
        this.status.lastRecordAt = Date.now()
      }
    } catch (err) {
      this.status.lastError = (err as Error).message
      if (isRetryableDbError(err)) {
        this.retainRows([row])
        this.schedulePendingFlush()
      }
      console.warn('[collector] failed to store usage record:', err)
    }
  }

  private flushPendingRows(): number {
    if (this.pendingRows.length === 0) return 0
    const rows = this.pendingRows
    try {
      const inserted = this.insertBatch(rows)
      this.pendingRows = []
      return inserted
    } catch (err) {
      if (isRetryableDbError(err)) throw err
      // Permanent row/binding error: salvage valid siblings row-by-row so one bad row
      // never poisons the queue.
      console.warn('[collector] batch insert failed with non-retryable error; falling back to per-row insert:', err)
      const inserted = this.insertRowsIndividually(rows)
      this.pendingRows = []
      return inserted
    }
  }

  private insertBatch(rows: RequestRow[]): number {
    const inserted = this.db.transaction(
      (tx) => {
        let count = 0
        for (let i = 0; i < rows.length; i += INSERT_CHUNK_SIZE) {
          const chunk = rows.slice(i, i + INSERT_CHUNK_SIZE)
          count += tx.insert(requests).values(chunk).onConflictDoNothing().returning({ id: requests.id }).all().length
        }
        return count
      },
      { behavior: 'immediate' },
    )
    if (inserted > 0) {
      this.status.stored += inserted
      this.status.lastRecordAt = Date.now()
    }
    return inserted
  }

  private insertRowsIndividually(rows: RequestRow[]): number {
    const inserted = this.db.transaction(
      (tx) => {
        let count = 0
        for (const row of rows) {
          try {
            if (tx.insert(requests).values(row).onConflictDoNothing().returning({ id: requests.id }).get()) {
              count += 1
            }
          } catch (err) {
            if (isRetryableDbError(err)) throw err
            console.warn('[collector] skipping un-storable usage record:', err)
          }
        }
        return count
      },
      { behavior: 'immediate' },
    )
    if (inserted > 0) {
      this.status.stored += inserted
      this.status.lastRecordAt = Date.now()
    }
    return inserted
  }
}
