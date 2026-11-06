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
//   PUT    /api/pool/sharing          { pool, until }: a time, null (until turned off) or false (stop)
//   POST   /api/pool/peers            { name } -> { token }, shown once
//   DELETE /api/pool/peers/:id

import { Hono, type Context } from 'hono'
import { getBunServer, getConnInfo } from 'hono/bun'
import { isPool, type SharingStore } from '../sharing'

const MAX_FAILURES_PER_MINUTE = 10
const HOP_BY_HOP = ['connection', 'keep-alive', 'transfer-encoding', 'content-encoding', 'content-length', 'host']
const CREDENTIALS = ['authorization', 'x-api-key', 'x-goog-api-key']

const withoutHeaders = (headers: Headers, names: string[]) => {
  const out = new Headers(headers)
  for (const h of names) out.delete(h)
  return out
}

// The body as it will be forwarded: parsed and written back, so a duplicated
// "model" key can't name one model here and another to the proxy.
const parseBody = (body: string) => {
  try {
    const parsed = JSON.parse(body) as { model?: unknown }
    return typeof parsed.model === 'string' ? { model: parsed.model, body: JSON.stringify(parsed) } : null
  } catch {
    return null
  }
}

export function poolGateway(target: string, pool: SharingStore) {
  const app = new Hono()
  const failures = new Map<string, number[]>()

  // Failed attempts in the last minute from this address. A valid token is
  // always let through: at 192 random bits it can't be guessed, and a peer
  // shouldn't be locked out by someone else's noise on the same address.
  const tooManyFailures = (c: Context) => {
    const now = Date.now()
    const ip = getConnInfo(c).remote.address ?? 'unknown'
    const recent = [...(failures.get(ip) ?? []).filter((t) => t > now - 60e3), now]
    failures.set(ip, recent)
    return recent.length > MAX_FAILURES_PER_MINUTE
  }

  const peerOf = (c: Context) => {
    const token = c.req.header('authorization')?.replace(/^Bearer\s+/i, '') || c.req.header('x-api-key') || ''
    const peer = token ? pool.peerFor(token) : undefined
    if (peer) return { peer }
    return tooManyFailures(c) ? { refused: c.json({ error: 'too many attempts' }, 429) } : { refused: c.json({ error: 'a pool token is required' }, 401) }
  }

  app.all('/pool/v1/*', async (c) => {
    const { peer, refused } = peerOf(c)
    if (!peer) return refused

    const request = parseBody(['GET', 'HEAD'].includes(c.req.method) ? '' : await c.req.text())
    if (!request) return c.json({ error: 'pool requests must name a model' }, 400)
    if (!(await pool.poolServing(request.model))) return c.json({ error: `${request.model} is not shared right now` }, 403)

    getBunServer<Bun.Server<unknown>>(c)?.timeout(c.req.raw, 0)
    const url = new URL(c.req.url)
    const headers = withoutHeaders(c.req.raw.headers, [...HOP_BY_HOP, ...CREDENTIALS])
    headers.set('Authorization', `Bearer ${peer.proxyKey}`)
    const res = await fetch(`${target}${url.pathname.replace(/^\/pool/, '')}${url.search}`, {
      method: c.req.method,
      headers,
      body: request.body,
    })
    return new Response(res.body, { status: res.status, headers: withoutHeaders(res.headers, HOP_BY_HOP) })
  })

  return app
}

export function poolSettings(pool: SharingStore) {
  const app = new Hono().basePath('/api/pool')

  // Writes must be JSON, which a page on another site can only send after a
  // CORS preflight this server never answers.
  app.use('*', async (c, next) => {
    if (['POST', 'PUT'].includes(c.req.method) && !c.req.header('content-type')?.startsWith('application/json'))
      return c.json({ error: 'send JSON' }, 415)
    await next()
  })

  app.get('/', (c) => c.json({ sharing: pool.sharing(), peers: pool.peers() }))

  app.put('/sharing', async (c) => {
    const { pool: name, until } = await c.req.json<{ pool?: string; until?: number | null | false }>()
    if (!isPool(name)) return c.json({ error: 'pool is required' }, 400)
    if (until === false) pool.stopSharing(name)
    else if (until === null || (typeof until === 'number' && until > Date.now())) pool.share(name, until)
    else return c.json({ error: 'until must be a future time, null (until turned off) or false (stop)' }, 400)
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
    try {
      await pool.removePeer(Number(c.req.param('id')))
      return c.json({ ok: true })
    } catch (e) {
      return c.json({ error: (e as Error).message }, 502)
    }
  })

  return app
}
