// Local-network listener for machines without Tailscale. It serves only:
//
//   GET  /connect, /connect/undo, /connect/claim/:code   connect a machine (codes are minted in the dashboard)
//   GET  /connect/import                                 the history import script
//   POST /api/import                                     usage-only history; requires a proxy API key
//
// Imports are attributed to the sender's LAN IP.

import { Hono } from 'hono'
import { getConnInfo } from 'hono/bun'
import type { Db } from '../db/client'
import { importTranscripts, type TranscriptFile } from '../import/importer'
import type { ProxyKeys } from '../proxy-keys'
import type { PriceBook } from '../usage/pricing'
import { connectApp, type ConnectOptions } from './connect'

const MAX_FAILURES_PER_MINUTE = 10

export function startLanListener(db: Db, prices: PriceBook, keys: ProxyKeys, connect: ConnectOptions) {
  const failures: number[] = []
  const app = new Hono()

  app.route('/connect', connectApp({ ...connect, canMint: false }))

  app.post('/api/import', async (c) => {
    const now = Date.now()
    while (failures.length && failures[0] < now - 60e3) failures.shift()
    if (failures.length >= MAX_FAILURES_PER_MINUTE) return c.json({ error: 'too many attempts' }, 429)

    const key = c.req.header('authorization')?.replace(/^Bearer\s+/i, '') ?? ''
    if (!key || !(await keys.has(key))) {
      failures.push(now)
      return c.json({ error: 'a proxy API key is required' }, 401)
    }

    const { files } = await c.req.json<{ files?: TranscriptFile[] }>()
    if (!Array.isArray(files)) return c.json({ error: 'files is required' }, 400)
    const valid = files.filter((f) => (f.tool === 'claude-code' || f.tool === 'codex') && Array.isArray(f.lines))
    // IPv4 clients can appear as IPv4-mapped IPv6 ("::ffff:192.168.1.5").
    const clientIp = getConnInfo(c).remote.address?.replace(/^::ffff:/, '') ?? 'unknown'
    return c.json({ machineIp: clientIp, ...importTranscripts(db, prices, valid, clientIp) })
  })

  const server = Bun.serve({ hostname: '0.0.0.0', port: connect.lanPort, fetch: app.fetch })
  console.log(`[lan] listening on http://0.0.0.0:${server.port}`)
}
