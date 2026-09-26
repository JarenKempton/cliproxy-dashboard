// Local-network listener for machines without Tailscale. It serves exactly
// two things and nothing else of the dashboard:
//
//   GET  /connect/import   the history import script
//   POST /api/import       usage-only history; requires a proxy API key
//
// Imports are attributed to the sender's LAN IP.

import { importScript } from '../../../src/lib/connect'
import type { Db } from '../db/client'
import { importTranscripts, type TranscriptFile } from '../import/importer'
import type { PriceBook } from '../usage/pricing'

type Options = { port: number; proxyUrl: string; managementKey: string }

const KEYS_TTL_MS = 60e3
const MAX_FAILURES_PER_MINUTE = 10

export function startLanListener(db: Db, prices: PriceBook, options: Options) {
  let keys: { list: string[]; at: number } | null = null
  const failures: number[] = []

  // The proxy's own key list decides who may import.
  async function isProxyKey(key: string) {
    if (!keys || Date.now() - keys.at > KEYS_TTL_MS) {
      const res = await fetch(`${options.proxyUrl}/v0/management/api-keys`, {
        headers: { Authorization: `Bearer ${options.managementKey}` },
      })
      const body = (await res.json()) as { 'api-keys'?: string[] }
      keys = { list: body['api-keys'] ?? [], at: Date.now() }
    }
    return keys.list.includes(key)
  }

  const server = Bun.serve({
    hostname: '0.0.0.0',
    port: options.port,
    async fetch(req, server) {
      const url = new URL(req.url)

      if (req.method === 'GET' && url.pathname === '/connect/import') {
        return new Response(importScript(url.origin), { headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
      }

      if (req.method === 'POST' && url.pathname === '/api/import') {
        const now = Date.now()
        while (failures.length && failures[0] < now - 60e3) failures.shift()
        if (failures.length >= MAX_FAILURES_PER_MINUTE) return Response.json({ error: 'too many attempts' }, { status: 429 })

        const key = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? ''
        if (!key || !(await isProxyKey(key))) {
          failures.push(now)
          return Response.json({ error: 'a proxy API key is required' }, { status: 401 })
        }

        const { files } = (await req.json()) as { files?: TranscriptFile[] }
        if (!Array.isArray(files)) return Response.json({ error: 'files is required' }, { status: 400 })
        const valid = files.filter((f) => (f.tool === 'claude-code' || f.tool === 'codex') && Array.isArray(f.lines))
        // IPv4 clients can appear as IPv4-mapped IPv6 ("::ffff:192.168.1.5").
        const clientIp = server.requestIP(req)?.address.replace(/^::ffff:/, '') ?? 'unknown'
        return Response.json({ machineIp: clientIp, ...importTranscripts(db, prices, valid, clientIp) })
      }

      return new Response('not found\n', { status: 404 })
    },
  })
  console.log(`[lan] import listener on http://0.0.0.0:${server.port}`)
}
