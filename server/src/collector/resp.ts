// Minimal client for the Redis wire protocol (RESP2), which CLIProxyAPI
// speaks on its main port for the usage queue. Supports what the collector
// needs: commands with replies, plus pushed pub/sub messages.

import { createConnection, type Socket } from 'node:net'

export type RespValue = string | number | null | RespValue[] | Error

type Pending = { resolve: (v: RespValue) => void; reject: (e: Error) => void }

export class RespConnection {
  private socket!: Socket
  private buffer = Buffer.alloc(0)
  private pending: Pending[] = []
  // Called for pub/sub pushes: ["message", channel, payload].
  onMessage: (channel: string, payload: string) => void = () => {}
  onClose: (err?: Error) => void = () => {}

  connect(host: string, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      let connected = false
      this.socket = createConnection({ host, port }, () => {
        connected = true
        resolve()
      })
      // Errors always end in 'close'; before connecting they fail connect().
      this.socket.on('error', (err) => {
        if (!connected) reject(err)
      })
      this.socket.on('data', (chunk) => this.receive(chunk))
      this.socket.on('close', () => {
        for (const p of this.pending.splice(0)) p.reject(new Error('connection closed'))
        this.onClose()
      })
    })
  }

  command(...args: (string | number)[]): Promise<RespValue> {
    const parts = args.map(String)
    let out = `*${parts.length}\r\n`
    for (const p of parts) out += `$${Buffer.byteLength(p)}\r\n${p}\r\n`
    return new Promise((resolve, reject) => {
      this.pending.push({ resolve, reject })
      this.socket.write(out)
    })
  }

  close() {
    this.socket?.destroy()
  }

  private receive(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk])
    for (;;) {
      const parsed = parse(this.buffer, 0)
      if (!parsed) return // incomplete; wait for more data
      this.buffer = this.buffer.subarray(parsed.end)
      this.dispatch(parsed.value)
    }
  }

  private dispatch(value: RespValue) {
    if (Array.isArray(value) && value[0] === 'message' && typeof value[2] === 'string') {
      this.onMessage(String(value[1]), value[2])
      return
    }
    const waiter = this.pending.shift()
    if (!waiter) return
    if (value instanceof Error) waiter.reject(value)
    else waiter.resolve(value)
  }
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
      return { value: new Error(line), end: next }
    case ':':
      return { value: Number(line), end: next }
    case '$': {
      const length = Number(line)
      if (length === -1) return { value: null, end: next }
      if (buf.length < next + length + 2) return null
      return { value: buf.toString('utf8', next, next + length), end: next + length + 2 }
    }
    case '*': {
      const count = Number(line)
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
