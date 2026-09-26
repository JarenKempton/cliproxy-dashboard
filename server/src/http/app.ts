// HTTP API for the dashboard. Bound to loopback; the dashboard reaches it
// through the Vite dev server's /api proxy.

import { Hono } from 'hono'
import type { CliproxyCollector } from '../collector/cliproxy'
import type { Db } from '../db/client'
import { assignIdentity, deleteMachine, listMachines, renameMachine, unassignedIdentities } from '../machines'
import type { PriceBook } from '../usage/pricing'
import { recentRequests, usageOverview, type Range } from '../usage/queries'

const RANGES: Range[] = ['24h', '7d', '30d']

export function createApp(db: Db, collector: CliproxyCollector, prices: PriceBook) {
  const app = new Hono().basePath('/api')

  app.get('/health', (c) =>
    c.json({ collector: collector.status, pricesLoadedAt: prices.loadedAt }),
  )

  app.get('/usage', (c) => {
    const range = (c.req.query('range') ?? '24h') as Range
    if (!RANGES.includes(range)) return c.json({ error: `range must be one of ${RANGES.join(', ')}` }, 400)
    return c.json(usageOverview(db, range))
  })

  app.get('/usage/requests', (c) => {
    const limit = Math.min(Number(c.req.query('limit') ?? 50) || 50, 500)
    return c.json(recentRequests(db, limit))
  })

  app.get('/machines', (c) => c.json({ machines: listMachines(db), unassigned: unassignedIdentities(db) }))

  // Body: { name, kind: 'key' | 'ip', value }
  app.post('/machines/identities', async (c) => {
    const { name, kind, value } = await c.req.json<{ name?: string; kind?: string; value?: string }>()
    if (!name?.trim() || (kind !== 'key' && kind !== 'ip') || !value) return c.json({ error: 'name, kind and value are required' }, 400)
    return c.json(assignIdentity(db, name.trim(), kind, value))
  })

  app.patch('/machines/:id', async (c) => {
    const { name } = await c.req.json<{ name?: string }>()
    if (!name?.trim()) return c.json({ error: 'name is required' }, 400)
    renameMachine(db, Number(c.req.param('id')), name.trim())
    return c.json({ ok: true })
  })

  app.delete('/machines/:id', (c) => {
    deleteMachine(db, Number(c.req.param('id')))
    return c.json({ ok: true })
  })

  return app
}
