// Minimal client for the Redis wire protocol (RESP2), which CLIProxyAPI
// speaks on its main port for the usage queue. Supports what the collector
// needs: commands with replies, plus pushed pub/sub messages.

import { createConnection, type Socket } from 'node:net'

export class RespError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RespError'
  }
}

export type RespValue = string | number | null | RespValue[] | RespError

type Pending = { resolve: (v: RespValue) => void; reject: (e: Error) => void }

const EMPTY_BUFFER: Buffer = Buffer.alloc(0)
const DEFAULT_KEEPALIVE_MS = 30_000
const DEFAULT_PING_INTERVAL_MS = 30_000
const DEFAULT_PING_TIMEOUT_MS = 10_000
const DECIMAL_INT_RE = /^-?\d+$/
const MAX_BULK_BYTES = 64 * 1024 * 1024
const MAX_ARRAY_ITEMS = 100_000

export class RespConnection {
  private socket?: Socket
  private buffer: Buffer = EMPTY_BUFFER
  private pending: Pending[] = []
  private lastError?: Error
  private closed = false
  private heartbeatTimer?: ReturnType<typeof setTimeout>
  private pingTimeoutTimer?: ReturnType<typeof setTimeout>
  // Called for pub/sub pushes: ["message", channel, payload].
  onMessage: (channel: string, payload: string) => void = () => {}
  onClose: (err?: Error) => void = () => {}

  connect(host: string, port: number, timeoutMs?: number): Promise<void> {
    this.closed = false
    this.lastError = undefined
    this.buffer = EMPTY_BUFFER
    return new Promise((resolve, reject) => {
      let settled = false
      let connectTimer: ReturnType<typeof setTimeout> | undefined
      const clearConnectTimer = () => {
        if (connectTimer) {
          clearTimeout(connectTimer)
          connectTimer = undefined
        }
      }
      const socket = createConnection({ host, port }, () => {
        clearConnectTimer()
        if (settled || this.closed) return
        socket.setKeepAlive(true, DEFAULT_KEEPALIVE_MS)
        socket.setNoDelay(true)
        settled = true
        resolve()
      })
      this.socket = socket
      if (timeoutMs !== undefined) {
        connectTimer = setTimeout(() => {
          connectTimer = undefined
          this.fail(new Error('RESP connect timeout'))
        }, timeoutMs)
      }
      // Errors always end in 'close'; before connecting they fail connect().
      socket.on('error', (err) => {
        clearConnectTimer()
        if (!this.lastError) this.lastError = err
        if (!settled) {
          settled = true
          reject(err)
        }
      })
      socket.on('data', (chunk) => this.receive(chunk))
      socket.on('close', () => {
        clearConnectTimer()
        this.closed = true
        this.stopHeartbeat()
        const err = this.lastError ?? new Error('connection closed')
        if (!settled) {
          settled = true
          reject(err)
        }
        for (const p of this.pending.splice(0)) p.reject(err)
        this.onClose(this.lastError)
      })
    })
  }

  command(...args: (string | number)[]): Promise<RespValue> {
    if (!this.socket || this.closed || this.socket.destroyed) {
      return Promise.reject(this.lastError ?? new Error('connection closed'))
    }
    const parts = args.map(String)
    let out = `*${parts.length}\r\n`
    for (const p of parts) out += `$${Buffer.byteLength(p)}\r\n${p}\r\n`
    return new Promise((resolve, reject) => {
      this.pending.push({ resolve, reject })
      this.socket!.write(out)
    })
  }

  async commandWithTimeout(timeoutMs: number, ...args: (string | number)[]): Promise<RespValue> {
    let timer: ReturnType<typeof setTimeout> | undefined
    timer = setTimeout(() => {
      timer = undefined
      this.fail(new Error(`RESP ${String(args[0] ?? 'command')} timeout`))
    }, timeoutMs)
    try {
      return await this.command(...args)
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  startHeartbeat(intervalMs = DEFAULT_PING_INTERVAL_MS, timeoutMs = DEFAULT_PING_TIMEOUT_MS) {
    this.stopHeartbeat()
    if (this.closed || !this.socket || this.socket.destroyed) return
    this.heartbeatTimer = setTimeout(() => {
      this.heartbeatTimer = undefined
      void this.sendPing(intervalMs, timeoutMs)
    }, intervalMs)
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer)
      this.heartbeatTimer = undefined
    }
    if (this.pingTimeoutTimer) {
      clearTimeout(this.pingTimeoutTimer)
      this.pingTimeoutTimer = undefined
    }
  }

  close() {
    this.closed = true
    this.stopHeartbeat()
    this.socket?.destroy()
  }

  private fail(err: Error) {
    if (!this.lastError) this.lastError = err
    this.closed = true
    this.stopHeartbeat()
    this.socket?.destroy(err)
  }

  private async sendPing(intervalMs: number, timeoutMs: number) {
    if (this.closed || !this.socket || this.socket.destroyed) return
    this.pingTimeoutTimer = setTimeout(() => {
      this.pingTimeoutTimer = undefined
      this.fail(new Error('RESP PING timeout'))
    }, timeoutMs)

    try {
      await this.command('PING')
    } catch (err) {
      // A server RESP error proves the connection is alive; stop pinging so we
      // don't spam an unsupported command while keeping the subscription open.
      if (err instanceof RespError) return
      return
    } finally {
      if (this.pingTimeoutTimer) {
        clearTimeout(this.pingTimeoutTimer)
        this.pingTimeoutTimer = undefined
      }
    }

    if (!this.closed && this.socket && !this.socket.destroyed) {
      this.startHeartbeat(intervalMs, timeoutMs)
    }
  }

  private receive(chunk: Buffer) {
    if (this.closed) return
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    let offset = 0
    try {
      for (;;) {
        if (offset >= this.buffer.length) break
        const parsed = parse(this.buffer, offset)
        if (!parsed) break // incomplete; wait for more data
        offset = parsed.end
        this.dispatch(parsed.value)
        if (this.closed) return
      }
      this.buffer = offset === this.buffer.length ? EMPTY_BUFFER : this.buffer.subarray(offset)
    } catch (err) {
      this.buffer = EMPTY_BUFFER
      this.fail(err instanceof Error ? err : new Error(String(err)))
    }
  }

  private dispatch(value: RespValue) {
    if (Array.isArray(value) && value[0] === 'message' && typeof value[2] === 'string') {
      this.onMessage(String(value[1]), value[2])
      return
    }
    const waiter = this.pending.shift()
    if (!waiter) return
    if (value instanceof RespError) waiter.reject(value)
    else waiter.resolve(value)
  }
}

function parseRespInt(line: string, label: string): number {
  if (!DECIMAL_INT_RE.test(line)) {
    throw new Error(`invalid RESP ${label}: ${JSON.stringify(line)}`)
  }
  const n = Number(line)
  if (!Number.isSafeInteger(n)) {
    throw new Error(`out-of-range RESP ${label}: ${JSON.stringify(line)}`)
  }
  return n
}

// Parses one value starting at `pos`; null if the buffer doesn't hold it all yet.
function parse(buf: Buffer, pos: number): { value: RespValue; end: number } | null {
  const lineEnd = buf.indexOf('\r\n', pos)
  if (lineEnd === -1) return null
  const type = String.fromCharCode(buf[pos])
  const line = buf.toString('utf8', pos + 1, lineEnd)
  const next = lineEnd + 2

  switch (type) {
    case '+':
      return { value: line, end: next }
    case '-':
      return { value: new RespError(line), end: next }
    case ':':
      return { value: parseRespInt(line, 'integer'), end: next }
    case '$': {
      const length = parseRespInt(line, 'bulk length')
      if (length < -1 || length > MAX_BULK_BYTES) {
        throw new Error(`invalid RESP bulk length: ${JSON.stringify(line)}`)
      }
      if (length === -1) return { value: null, end: next }
      if (buf.length < next + length + 2) return null
      if (buf[next + length] !== 0x0d || buf[next + length + 1] !== 0x0a) {
        throw new Error('malformed RESP bulk string terminator')
      }
      return { value: buf.toString('utf8', next, next + length), end: next + length + 2 }
    }
    case '*': {
      const count = parseRespInt(line, 'array length')
      if (count < -1 || count > MAX_ARRAY_ITEMS) {
        throw new Error(`invalid RESP array length: ${JSON.stringify(line)}`)
      }
      if (count === -1) return { value: null, end: next }
      const items: RespValue[] = []
      let at = next
      for (let i = 0; i < count; i++) {
        const item = parse(buf, at)
        if (!item) return null
        items.push(item.value)
        at = item.end
      }
      return { value: items, end: at }
    }
    default:
      throw new Error(`unexpected RESP type byte: ${JSON.stringify(type)}`)
  }
}
