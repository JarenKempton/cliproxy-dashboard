// The pool gateway, where a peer's proxy borrows this proxy's accounts:
//
//   ALL /pool/v1/*   pool token required; the request's model must belong to a
//                    pool that is shared right now and has a working account
//                    here. Anything else is refused before the proxy sees it.
//
// A peer's proxy lists this as a low-priority upstream, e.g. a claude-api-key
// entry with base-url <dashboard>/pool and priority -1, so it is used only once
// the peer's own accounts are spent.
//
// And the dashboard's settings, on the loopback server only:
//
//   GET    /api/pool                  sharing, peers
//   PUT    /api/pool/sharing          { pool, shared }
//   POST   /api/pool/peers            { name } -> { token }, shown once
//   DELETE /api/pool/peers/:id

import { Hono } from 'hono'
import { getBunServer } from 'hono/bun'
import { isPool, type Sharing } from '../sharing'

const MAX_FAILURES_PER_MINUTE = 10
const HOP_BY_HOP = ['connection', 'keep-alive', 'transfer-encoding', 'content-encoding', 'content-length', 'host']
const CREDENTIALS = ['authorization', 'x-api-key', 'x-goog-api-key']

const withoutHeaders = (headers: Headers, names: string[]) => {
  const out = new Headers(headers)
  for (const h of names) out.delete(h)
  return out
}

const modelOf = (body: string) => {
  try {
    const model = (JSON.parse(body) as { model?: unknown }).model
    return typeof model === 'string' ? model : null
  } catch {
    return null
  }
}

export function poolGateway(target: string, pool: Sharing) {
  const failures: number[] = []
  const app = new Hono()

  app.all('/pool/v1/*', async (c) => {
    const now = Date.now()
    while (failures.length && failures[0] < now - 60e3) failures.shift()
    if (failures.length >= MAX_FAILURES_PER_MINUTE) return c.json({ error: 'too many attempts' }, 429)

    const token = c.req.header('authorization')?.replace(/^Bearer\s+/i, '') || c.req.header('x-api-key') || ''
    const peer = token ? pool.peerFor(token) : undefined
    if (!peer) {
      failures.push(now)
      return c.json({ error: 'a pool token is required' }, 401)
    }

    const body = ['GET', 'HEAD'].includes(c.req.method) ? '' : await c.req.text()
    const model = modelOf(body)
    if (!model) return c.json({ error: 'pool requests must name a model' }, 400)
    if (!(await pool.poolServing(model))) return c.json({ error: `${model} is not shared right now` }, 403)

    getBunServer<Bun.Server<unknown>>(c)?.timeout(c.req.raw, 0)
    const url = new URL(c.req.url)
    const headers = withoutHeaders(c.req.raw.headers, [...HOP_BY_HOP, ...CREDENTIALS])
    headers.set('Authorization', `Bearer ${peer.proxyKey}`)
    const res = await fetch(`${target}${url.pathname.replace(/^\/pool/, '')}${url.search}`, {
      method: c.req.method,
      headers,
      body,
    })
    return new Response(res.body, { status: res.status, headers: withoutHeaders(res.headers, HOP_BY_HOP) })
  })

  return app
}

export function poolSettings(pool: Sharing) {
  const app = new Hono().basePath('/api/pool')

  app.get('/', (c) => c.json({ sharing: pool.sharing(), peers: pool.peers() }))

  app.put('/sharing', async (c) => {
    const { pool: name, shared } = await c.req.json<{ pool?: string; shared?: boolean }>()
    if (!isPool(name) || typeof shared !== 'boolean') return c.json({ error: 'pool and shared are required' }, 400)
    pool.setShared(name, shared)
    return c.json({ sharing: pool.sharing() })
  })

  app.post('/peers', async (c) => {
    const { name } = await c.req.json<{ name?: string }>()
    const trimmed = name?.trim()
    if (!trimmed) return c.json({ error: 'name is required' }, 400)
    if (pool.peers().some((p) => p.name === trimmed)) return c.json({ error: `${trimmed} is already a peer` }, 409)
    try {
      return c.json({ token: await pool.addPeer(trimmed) })
    } catch (e) {
      return c.json({ error: (e as Error).message }, 502)
    }
  })

  app.delete('/peers/:id', async (c) => {
    await pool.removePeer(Number(c.req.param('id')))
    return c.json({ ok: true })
  })

  return app
}
