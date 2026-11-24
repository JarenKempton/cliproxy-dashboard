// HTTP API for the usage dashboard and external consumers.

import { Hono } from 'hono'
import type { CliproxyCollector } from '../collector/cliproxy'
import type { Db } from '../db/client'
import { importTranscripts, type TranscriptFile } from '../import/importer'
import { clearIdentityName, listDevices, nameIdentity, type IdentityKind } from '../machines'
import type { Tailnet } from '../tailnet'
import type { PriceBook } from '../usage/pricing'
import { RANGES, usageSummary, type Range } from '../usage/summary'

const isKind = (k: unknown): k is IdentityKind => k === 'key' || k === 'ip'

export function createApp(db: Db, collector: CliproxyCollector, prices: PriceBook, tailnet: Tailnet) {
  const app = new Hono().basePath('/api')

  app.get('/health', (c) =>
    c.json({
      collector: collector.status,
      pricesLoadedAt: prices.loadedAt,
      tailnet: { syncedAt: tailnet.syncedAt, error: tailnet.lastError },
    }),
  )

  // ?range=24h|7d|30d|90d|all&tz=<IANA time zone> (days are the viewer's local days).
  app.get('/usage', (c) => {
    const range = (c.req.query('range') ?? '30d') as Range
    if (!RANGES.includes(range)) return c.json({ error: `range must be one of ${RANGES.join(', ')}` }, 400)
    return c.json(usageSummary(db, range, validTimeZone(c.req.query('tz'))))
  })

  // Body: { files: [{ tool: 'claude-code' | 'codex', lines: string[] }] }, usage-only
  // transcript lines from another machine.
  app.post('/import', async (c) => {
    const { files } = await c.req.json<{ files?: TranscriptFile[] }>()
    if (!Array.isArray(files)) return c.json({ error: 'files is required' }, 400)
    const valid = files.filter((f) => (f.tool === 'claude-code' || f.tool === 'codex') && Array.isArray(f.lines))
    const clientIp = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || '127.0.0.1'
    return c.json({ machineIp: clientIp, ...importTranscripts(db, prices, valid, clientIp) })
  })

  // Machines as seen by the proxy: proxy keys and client IPs, with names.
  app.get('/devices', (c) => c.json(listDevices(db)))

  // Body: { kind: 'key' | 'ip', value, name }. Identities with the same name are one machine.
  app.put('/devices/name', async (c) => {
    const { kind, value, name } = await c.req.json<{ kind?: string; value?: string; name?: string }>()
    if (!isKind(kind) || !value || !name?.trim()) return c.json({ error: 'kind, value and name are required' }, 400)
    nameIdentity(db, kind, value, name.trim())
    return c.json({ ok: true })
  })

  // Body: { kind, value }. Falls back to the Tailscale name or IP.
  app.delete('/devices/name', async (c) => {
    const { kind, value } = await c.req.json<{ kind?: string; value?: string }>()
    if (!isKind(kind) || !value) return c.json({ error: 'kind and value are required' }, 400)
    clearIdentityName(db, kind, value)
    return c.json({ ok: true })
  })

  return app
}

function validTimeZone(tz: string | undefined) {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz }).resolvedOptions().timeZone
  } catch {
    return 'UTC'
  }
}
