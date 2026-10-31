// HTTP API for the dashboard, served by the usage server on loopback.

import { Hono } from 'hono'
import type { CliproxyCollector } from '../collector/cliproxy'
import type { Db } from '../db/client'
import { importTranscripts, type TranscriptFile } from '../import/importer'
import { listKeyLabels, setKeyLabel } from '../keys'
import { clearIdentityName, listDevices, nameIdentity, type IdentityKind } from '../machines'
import type { Tailnet } from '../tailnet'
import { hashKey } from '../usage/cliproxy-record'
import type { PriceBook } from '../usage/pricing'
import { accountHours, RANGES, recentActivity, usageSummary, type Range } from '../usage/summary'

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

  // ?range=24h|7d|30d|90d&tz=<IANA time zone> (days are the viewer's local days).
  app.get('/usage', (c) => {
    const range = (c.req.query('range') ?? '30d') as Range
    if (!RANGES.includes(range)) return c.json({ error: `range must be one of ${RANGES.join(', ')}` }, 400)
    return c.json(usageSummary(db, range, validTimeZone(c.req.query('tz'))))
  })

  // Body: { files: [{ tool: 'claude-code' | 'codex', lines: string[] }] }, usage-only
  // transcript lines from another machine (see /connect/import). The sender's
  // tailnet IP, forwarded by tailscale serve, says which machine it was.
  app.post('/import', async (c) => {
    const { files } = await c.req.json<{ files?: TranscriptFile[] }>()
    if (!Array.isArray(files)) return c.json({ error: 'files is required' }, 400)
    const valid = files.filter((f) => (f.tool === 'claude-code' || f.tool === 'codex') && Array.isArray(f.lines))
    const clientIp = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || '127.0.0.1'
    return c.json({ machineIp: clientIp, ...importTranscripts(db, prices, valid, clientIp) })
  })

  // ?minutes=5: accounts that served requests recently, and for which machines.
  app.get('/activity', (c) => {
    const minutes = Math.min(Math.max(Number(c.req.query('minutes')) || 5, 1), 60)
    return c.json(recentActivity(db, minutes))
  })

  // ?days=21: proxy cost per account and hour, to chart quota burn between readings.
  app.get('/account-hours', (c) => {
    const days = Math.min(Math.max(Number(c.req.query('days')) || 21, 1), 35)
    return c.json(accountHours(db, Date.now() - days * 86400e3))
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

  // Key labels by key hash (the dashboard hashes keys the same way to match).
  app.get('/keys/labels', (c) => c.json(listKeyLabels(db)))

  // Body: { key, label }. An empty label removes it. Only a short hash is stored.
  app.put('/keys/label', async (c) => {
    const { key, label } = await c.req.json<{ key?: string; label?: string }>()
    if (!key) return c.json({ error: 'key is required' }, 400)
    setKeyLabel(db, hashKey(key), label?.trim() ?? '')
    return c.json({ ok: true })
  })

  // Body: { key, name }. Marks a key as dedicated to one machine.
  app.put('/keys/machine', async (c) => {
    const { key, name } = await c.req.json<{ key?: string; name?: string }>()
    if (!key || !name?.trim()) return c.json({ error: 'key and name are required' }, 400)
    nameIdentity(db, 'key', hashKey(key), name.trim())
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
