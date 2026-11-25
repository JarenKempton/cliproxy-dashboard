import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'drizzle-orm'
import { openDb } from '../db/client'
import { requests } from '../db/schema'
import { isUsageRecord, toRequestRow } from '../usage/cliproxy-record'
import { PriceBook } from '../usage/pricing'
import { CliproxyCollector } from './cliproxy'
import { RespConnection, RespError } from './resp'

function encodeResp(value: string | number | null | string[]): string {
  if (value === null) return '$-1\r\n'
  if (typeof value === 'number') return `:${value}\r\n`
  if (typeof value === 'string') return `$${Buffer.byteLength(value)}\r\n${value}\r\n`
  return `*${value.length}\r\n${value.map((v) => encodeResp(v)).join('')}`
}

function parseCommands(buf: Buffer): { cmds: string[][]; rest: Buffer } {
  const cmds: string[][] = []
  let pos = 0
  while (pos < buf.length) {
    const start = pos
    if (buf[pos] !== 0x2a) break
    const lineEnd = buf.indexOf('\r\n', pos)
    if (lineEnd === -1) break
    const count = Number(buf.toString('utf8', pos + 1, lineEnd))
    pos = lineEnd + 2
    const args: string[] = []
    let incomplete = false
    for (let i = 0; i < count; i++) {
      const lenEnd = buf.indexOf('\r\n', pos)
      if (lenEnd === -1) {
        incomplete = true
        break
      }
      const len = Number(buf.toString('utf8', pos + 1, lenEnd))
      const dataStart = lenEnd + 2
      if (buf.length < dataStart + len + 2) {
        incomplete = true
        break
      }
      args.push(buf.toString('utf8', dataStart, dataStart + len))
      pos = dataStart + len + 2
    }
    if (incomplete) {
      pos = start
      break
    }
    cmds.push(args)
  }
  return { cmds, rest: buf.subarray(pos) }
}

type Handler = (cmd: string[], socket: Socket) => void

async function startFakeResp(onCommand: Handler): Promise<{ server: Server; port: number; sockets: Socket[] }> {
  const sockets: Socket[] = []
  const server = createServer((socket) => {
    sockets.push(socket)
    let buf: Buffer = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk])
      const { cmds, rest } = parseCommands(buf)
      buf = rest
      for (const cmd of cmds) onCommand(cmd, socket)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('failed to bind server')
  return { server, port: address.port, sockets }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await Bun.sleep(15)
  }
  throw new Error('timed out waiting for condition')
}

function makeRecord(id: string, overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    timestamp: '2026-11-24T12:00:00.000Z',
    request_id: id,
    provider: 'openai',
    model: 'gpt-6.1-sol',
    failed: false,
    tokens: { input_tokens: 100, output_tokens: 20 },
    ...overrides,
  })
}

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  while (cleanups.length) {
    const fn = cleanups.pop()!
    await fn()
  }
})

describe('D2: SQLite pragmas', () => {
  test('configures busy_timeout, WAL, synchronous=NORMAL, and foreign_keys', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cliproxy-db-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))

    const db = openDb(join(dir, 'usage.db'))
    const busyTimeout = db.get<[number]>(sql`PRAGMA busy_timeout`)
    const journalMode = db.get<[string]>(sql`PRAGMA journal_mode`)
    const synchronous = db.get<[number]>(sql`PRAGMA synchronous`)
    const foreignKeys = db.get<[number]>(sql`PRAGMA foreign_keys`)

    expect(busyTimeout?.[0]).toBe(5000)
    expect(journalMode?.[0].toLowerCase()).toBe('wal')
    expect(synchronous?.[0]).toBe(1) // 1 = NORMAL
    expect(foreignKeys?.[0]).toBe(1)
  })
})

describe('D1: usage record validation', () => {
  test('rejects malformed timestamps and empty required fields, but accepts execution_id-only records', () => {
    expect(isUsageRecord(null)).toBe(false)
    expect(isUsageRecord({ timestamp: 'not-a-date', model: 'gpt-6.1-sol', request_id: 'r1' })).toBe(false)
    expect(isUsageRecord({ timestamp: '', model: 'gpt-6.1-sol', request_id: 'r1' })).toBe(false)
    expect(isUsageRecord({ timestamp: '2026-11-24T00:00:00Z', model: '', request_id: 'r1' })).toBe(false)
    expect(isUsageRecord({ timestamp: '2026-11-24T00:00:00Z', model: 'gpt-6.1-sol', request_id: '' })).toBe(false)
    expect(
      isUsageRecord({ timestamp: '2026-11-24T00:00:00Z', model: 'gpt-6.1-sol', request_id: '', execution_id: 'exec-1' }),
    ).toBe(true)
    expect(isUsageRecord({ timestamp: '2026-11-24T00:00:00Z', model: 'gpt-6.1-sol', request_id: 'r1' })).toBe(true)

    const db = openDb(':memory:')
    const prices = new PriceBook(db, '')
    const execRow = toRequestRow(
      {
        timestamp: '2026-11-24T00:00:00Z',
        request_id: '',
        execution_id: 'exec-1',
        provider: 'openai',
        model: 'gpt-6.1-sol',
        failed: false,
      },
      prices,
    )
    expect(execRow.id).toBe('cliproxy:exec-1:2026-11-24T00:00:00Z')

    expect(() =>
      toRequestRow(
        { timestamp: 'invalid', request_id: 'r1', provider: 'openai', model: 'gpt-6.1-sol', failed: false },
        prices,
      ),
    ).toThrow()
  })
})

describe('D1, S10, D7: CliproxyCollector & RespConnection reliability', () => {
  test('drains a mixed batch in one transaction without losing valid records on bad payloads (D1)', async () => {
    const queue = [
      'not-json',
      makeRecord('bad-ts', { timestamp: 'invalid-date' }),
      makeRecord('ok-1'),
      makeRecord('ok-2'),
      makeRecord('ok-1'), // duplicate id
    ]
    const fake = await startFakeResp((cmd, socket) => {
      const op = cmd[0].toUpperCase()
      if (op === 'AUTH') socket.write('+OK\r\n')
      else if (op === 'SUBSCRIBE') socket.write(encodeResp(['subscribe', cmd[1], '1']))
      else if (op === 'LPOP') {
        const items = queue.splice(0, queue.length)
        socket.write(encodeResp(items))
      } else if (op === 'PING') socket.write('+PONG\r\n')
    })
    cleanups.push(() => {
      for (const s of fake.sockets) s.destroy()
      fake.server.close()
    })

    const db = openDb(':memory:')
    const prices = new PriceBook(db, '')
    const collector = new CliproxyCollector(db, prices, {
      host: '127.0.0.1',
      port: fake.port,
      managementKey: 'secret',
      initialBackoffMs: 25,
    })
    cleanups.push(() => collector.stop())

    collector.start()
    await waitFor(() => collector.status.stored === 2)

    const rows = db.select().from(requests).all()
    expect(rows).toHaveLength(2)
    expect(collector.status.connected).toBe(true)
    expect(collector.status.lastError).toBeNull()
  })

  test('reconnects cleanly when server sends malformed RESP bytes instead of crashing (D1)', async () => {
    let subCount = 0
    const fake = await startFakeResp((cmd, socket) => {
      const op = cmd[0].toUpperCase()
      if (op === 'AUTH') socket.write('+OK\r\n')
      else if (op === 'SUBSCRIBE') {
        subCount += 1
        socket.write(encodeResp(['subscribe', cmd[1], '1']))
        if (subCount === 1) {
          // Send corrupted RESP frame on first subscription
          setTimeout(() => socket.write('!corrupted\r\n'), 20)
        } else {
          // Deliver valid message on second subscription
          setTimeout(() => socket.write(encodeResp(['message', 'usage', makeRecord('after-reconnect')])), 20)
        }
      } else if (op === 'LPOP') socket.write(encodeResp([]))
      else if (op === 'PING') socket.write('+PONG\r\n')
    })
    cleanups.push(() => {
      for (const s of fake.sockets) s.destroy()
      fake.server.close()
    })

    const db = openDb(':memory:')
    const prices = new PriceBook(db, '')
    const collector = new CliproxyCollector(db, prices, {
      host: '127.0.0.1',
      port: fake.port,
      managementKey: 'secret',
      initialBackoffMs: 25,
      maxBackoffMs: 50,
    })
    cleanups.push(() => collector.stop())

    collector.start()
    await waitFor(() => collector.status.stored === 1)

    expect(subCount).toBeGreaterThanOrEqual(2)
    expect(db.select().from(requests).all()).toHaveLength(1)
  })

  test('stops retrying immediately on AUTH RespError to prevent proxy IP ban (S10)', async () => {
    let authAttempts = 0
    const fake = await startFakeResp((cmd, socket) => {
      if (cmd[0].toUpperCase() === 'AUTH') {
        authAttempts += 1
        socket.write('-WRONGPASS invalid management key\r\n')
      }
    })
    cleanups.push(() => {
      for (const s of fake.sockets) s.destroy()
      fake.server.close()
    })

    const db = openDb(':memory:')
    const prices = new PriceBook(db, '')
    const collector = new CliproxyCollector(db, prices, {
      host: '127.0.0.1',
      port: fake.port,
      managementKey: 'wrong-key',
      initialBackoffMs: 20,
      maxBackoffMs: 40,
    })
    cleanups.push(() => collector.stop())

    collector.start()
    await waitFor(() => collector.status.lastError !== null)
    // Wait long enough that multiple retries would have fired if it didn't stop.
    await Bun.sleep(120)

    expect(authAttempts).toBe(1)
    expect(collector.status.connected).toBe(false)
    expect(collector.status.lastError).toContain('WRONGPASS')
  })

  test('detects half-open connection via PING timeout, reconnects, and stays open across interleaved PING/PONG + messages (D7)', async () => {
    let subCount = 0
    let pingCount = 0
    let recoveredPings = 0
    const fake = await startFakeResp((cmd, socket) => {
      const op = cmd[0].toUpperCase()
      if (op === 'AUTH') socket.write('+OK\r\n')
      else if (op === 'SUBSCRIBE') {
        subCount += 1
        socket.write(encodeResp(['subscribe', cmd[1], '1']))
        if (subCount === 2) {
          setTimeout(() => socket.write(encodeResp(['message', 'usage', makeRecord('after-ping-timeout-1')])), 15)
          setTimeout(() => socket.write(encodeResp(['message', 'usage', makeRecord('after-ping-timeout-2')])), 55)
        }
      } else if (op === 'LPOP') socket.write(encodeResp([]))
      else if (op === 'PING') {
        pingCount += 1
        // Silently ignore PING on first connection to simulate a half-open socket;
        // reply with pub/sub pong array on subsequent connections.
        if (subCount >= 2) {
          recoveredPings += 1
          socket.write(encodeResp(['pong', '']))
        }
      }
    })
    cleanups.push(() => {
      for (const s of fake.sockets) s.destroy()
      fake.server.close()
    })

    const db = openDb(':memory:')
    const prices = new PriceBook(db, '')
    const collector = new CliproxyCollector(db, prices, {
      host: '127.0.0.1',
      port: fake.port,
      managementKey: 'secret',
      pingIntervalMs: 30,
      pingTimeoutMs: 50,
      initialBackoffMs: 25,
      maxBackoffMs: 50,
    })
    cleanups.push(() => collector.stop())

    collector.start()
    await waitFor(() => collector.status.stored === 2 && recoveredPings >= 2)

    expect(pingCount).toBeGreaterThanOrEqual(3)
    expect(subCount).toBe(2)
    expect(collector.status.connected).toBe(true)
  })

  test('retains popped batch across SQLITE_BUSY and commits on retry without losing records (D1/D2)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cliproxy-busy-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const dbPath = join(dir, 'usage.db')

    const db = openDb(dbPath)
    // Lower busy_timeout just for this test so contention triggers quickly.
    db.run(sql`PRAGMA busy_timeout = 30`)

    const locker = new Database(dbPath)
    cleanups.push(() => locker.close())
    locker.exec('BEGIN IMMEDIATE')

    const queue = [makeRecord('busy-1'), makeRecord('busy-2'), makeRecord('busy-3')]
    let lpopCalls = 0
    const fake = await startFakeResp((cmd, socket) => {
      const op = cmd[0].toUpperCase()
      if (op === 'AUTH') socket.write('+OK\r\n')
      else if (op === 'SUBSCRIBE') socket.write(encodeResp(['subscribe', cmd[1], '1']))
      else if (op === 'LPOP') {
        lpopCalls += 1
        socket.write(encodeResp(queue.splice(0, queue.length)))
      } else if (op === 'PING') socket.write('+PONG\r\n')
    })
    cleanups.push(() => {
      for (const s of fake.sockets) s.destroy()
      fake.server.close()
    })

    const prices = new PriceBook(db, '')
    const collector = new CliproxyCollector(db, prices, {
      host: '127.0.0.1',
      port: fake.port,
      managementKey: 'secret',
      initialBackoffMs: 30,
      maxBackoffMs: 60,
    })
    cleanups.push(() => collector.stop())

    collector.start()
    await waitFor(() => lpopCalls === 1 && collector.status.lastError !== null)
    expect(collector.status.stored).toBe(0)

    // Release the write lock; next retry should flush retained rows before LPOP.
    locker.exec('COMMIT')
    await waitFor(() => collector.status.stored === 3)
    expect(db.select().from(requests).all()).toHaveLength(3)
  })

  test('recovers when LPOP stalls during drainQueue via drain timeout (D7)', async () => {
    let lpopCalls = 0
    const fake = await startFakeResp((cmd, socket) => {
      const op = cmd[0].toUpperCase()
      if (op === 'AUTH') socket.write('+OK\r\n')
      else if (op === 'SUBSCRIBE') socket.write(encodeResp(['subscribe', cmd[1], '1']))
      else if (op === 'LPOP') {
        lpopCalls += 1
        // Stall first LPOP; respond on second attempt.
        if (lpopCalls >= 2) socket.write(encodeResp([makeRecord('after-drain-timeout')]))
      } else if (op === 'PING') socket.write('+PONG\r\n')
    })
    cleanups.push(() => {
      for (const s of fake.sockets) s.destroy()
      fake.server.close()
    })

    const db = openDb(':memory:')
    const prices = new PriceBook(db, '')
    const collector = new CliproxyCollector(db, prices, {
      host: '127.0.0.1',
      port: fake.port,
      managementKey: 'secret',
      drainTimeoutMs: 60,
      initialBackoffMs: 25,
      maxBackoffMs: 50,
    })
    cleanups.push(() => collector.stop())

    collector.start()
    await waitFor(() => collector.status.stored === 1)
    expect(lpopCalls).toBeGreaterThanOrEqual(2)
  })

  test('RespConnection rejects malformed bulk terminators, non-decimal lengths, and close-during-connect', async () => {
    const fake = await startFakeResp((cmd, socket) => {
      const op = cmd[0].toUpperCase()
      if (op === 'PING') socket.write('$4\r\nPONGXX')
      else if (op === 'ECHO') socket.write('$1e2\r\nhi\r\n')
    })
    cleanups.push(() => {
      for (const s of fake.sockets) s.destroy()
      fake.server.close()
    })

    const conn1 = new RespConnection()
    await conn1.connect('127.0.0.1', fake.port)
    cleanups.push(() => conn1.close())
    await expect(conn1.command('PING')).rejects.toThrow('malformed RESP bulk string terminator')

    const conn2 = new RespConnection()
    await conn2.connect('127.0.0.1', fake.port)
    cleanups.push(() => conn2.close())
    await expect(conn2.command('ECHO', 'x')).rejects.toThrow('invalid RESP bulk length')

    const conn3 = new RespConnection()
    const connectPromise = conn3.connect('127.0.0.1', fake.port)
    conn3.close()
    await expect(connectPromise).rejects.toThrow('connection closed')
  })

  test('sanitizes malformed field types (e.g. object latency_ms) without blocking the batch (D1)', async () => {
    const queue = [
      makeRecord('weird-fields', { latency_ms: { bad: true }, ttft_ms: 'nan', tokens: { input_tokens: {} } }),
      makeRecord('clean-sibling'),
    ]
    const fake = await startFakeResp((cmd, socket) => {
      const op = cmd[0].toUpperCase()
      if (op === 'AUTH') socket.write('+OK\r\n')
      else if (op === 'SUBSCRIBE') socket.write(encodeResp(['subscribe', cmd[1], '1']))
      else if (op === 'LPOP') socket.write(encodeResp(queue.splice(0, queue.length)))
      else if (op === 'PING') socket.write('+PONG\r\n')
    })
    cleanups.push(() => {
      for (const s of fake.sockets) s.destroy()
      fake.server.close()
    })

    const db = openDb(':memory:')
    const prices = new PriceBook(db, '')
    const collector = new CliproxyCollector(db, prices, {
      host: '127.0.0.1',
      port: fake.port,
      managementKey: 'secret',
      initialBackoffMs: 25,
    })
    cleanups.push(() => collector.stop())

    collector.start()
    await waitFor(() => collector.status.stored === 2)

    const rows = db.select().from(requests).all()
    expect(rows).toHaveLength(2)
    expect(rows.find((r) => r.id.includes('weird-fields'))?.latencyMs).toBeNull()
  })

  test('retains live pub/sub records across SQLITE_BUSY and flushes once lock clears (D1/D2)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cliproxy-live-busy-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const dbPath = join(dir, 'usage.db')

    const db = openDb(dbPath)
    db.run(sql`PRAGMA busy_timeout = 30`)

    let subSocket: Socket | undefined
    const fake = await startFakeResp((cmd, socket) => {
      const op = cmd[0].toUpperCase()
      if (op === 'AUTH') socket.write('+OK\r\n')
      else if (op === 'SUBSCRIBE') {
        subSocket = socket
        socket.write(encodeResp(['subscribe', cmd[1], '1']))
      } else if (op === 'LPOP') socket.write(encodeResp([]))
      else if (op === 'PING') socket.write('+PONG\r\n')
    })
    cleanups.push(() => {
      for (const s of fake.sockets) s.destroy()
      fake.server.close()
    })

    const prices = new PriceBook(db, '')
    const collector = new CliproxyCollector(db, prices, {
      host: '127.0.0.1',
      port: fake.port,
      managementKey: 'secret',
      initialBackoffMs: 40,
    })
    cleanups.push(() => collector.stop())

    collector.start()
    await waitFor(() => collector.status.connected && subSocket !== undefined)

    const locker = new Database(dbPath)
    cleanups.push(() => locker.close())
    locker.exec('BEGIN IMMEDIATE')

    subSocket!.write(encodeResp(['message', 'usage', makeRecord('live-during-lock')]))
    await waitFor(() => collector.status.lastError !== null)
    expect(collector.status.stored).toBe(0)

    locker.exec('COMMIT')
    await waitFor(() => collector.status.stored === 1)
    expect(db.select().from(requests).all()).toHaveLength(1)
  })

  test('lets an in-flight LPOP finish when subscription disconnects so popped records are not lost', async () => {
    const queue = [makeRecord('in-flight-lpop')]
    let subSocket: Socket | undefined
    let lpopCount = 0
    const fake = await startFakeResp((cmd, socket) => {
      const op = cmd[0].toUpperCase()
      if (op === 'AUTH') socket.write('+OK\r\n')
      else if (op === 'SUBSCRIBE') {
        subSocket = socket
        socket.write(encodeResp(['subscribe', cmd[1], '1']))
      } else if (op === 'LPOP') {
        lpopCount += 1
        const items = queue.splice(0, queue.length)
        if (lpopCount === 1) {
          // Drop the subscription while the first LPOP reply is still in flight.
          subSocket?.destroy()
          setTimeout(() => socket.write(encodeResp(items)), 60)
        } else {
          socket.write(encodeResp(items))
        }
      } else if (op === 'PING') socket.write('+PONG\r\n')
    })
    cleanups.push(() => {
      for (const s of fake.sockets) s.destroy()
      fake.server.close()
    })

    const db = openDb(':memory:')
    const prices = new PriceBook(db, '')
    const collector = new CliproxyCollector(db, prices, {
      host: '127.0.0.1',
      port: fake.port,
      managementKey: 'secret',
      drainTimeoutMs: 500,
      initialBackoffMs: 25,
    })
    cleanups.push(() => collector.stop())

    collector.start()
    await waitFor(() => collector.status.stored === 1)
    expect(db.select().from(requests).all()).toHaveLength(1)
  })

  test('RespConnection rejects commands with RespError on server error replies', async () => {
    const fake = await startFakeResp((cmd, socket) => {
      if (cmd[0].toUpperCase() === 'AUTH') socket.write('-ERR bad auth\r\n')
    })
    cleanups.push(() => {
      for (const s of fake.sockets) s.destroy()
      fake.server.close()
    })

    const conn = new RespConnection()
    await conn.connect('127.0.0.1', fake.port)
    cleanups.push(() => conn.close())

    let caught: unknown
    try {
      await conn.command('AUTH', 'bad')
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(RespError)
    expect((caught as Error).message).toBe('ERR bad auth')
  })
})
