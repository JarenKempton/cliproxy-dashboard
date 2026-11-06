// The pool gateway, where a peer's proxy borrows this proxy's accounts:
//
//   GET /pool/invite/:code  one-time: the pool token for an invited peer
//   GET /pool/status pool token required; the pools shared right now, with
//                    their accounts' quota windows and hourly cost
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
//   GET    /api/pool                  sharing, peers, owner
//   PUT    /api/pool/owner            { owner }: the name peers see
//   PUT    /api/pool/floor            { pool, window, percent }: share of a quota window kept for yourself (0 clears)
//   GET    /api/pool/borrowed         peers this proxy borrows from, and what they share
//   GET    /api/pool/drain            { on }: whether accounts are ranked soonest reset first
//   PUT    /api/pool/drain            { on }: turn that on (ranks now) or off (clears every priority)
//   PUT    /api/pool/sharing          { pool, until }: a time, null (until turned off) or false (stop)
//   POST   /api/pool/peers            { name } -> { token, code, expires }: token and invite code, shown once
//   DELETE /api/pool/peers/:id
//   POST   /api/pool/join             { link }: claim a lender's invite into this proxy's config

import { Hono, type Context } from 'hono'
import { getBunServer, getConnInfo } from 'hono/bun'
import type { Drain } from '../drain'
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
    if (failures.size > 256) for (const [addr, times] of failures) if (times.every((t) => t <= now - 60e3)) failures.delete(addr)
    return recent.length > MAX_FAILURES_PER_MINUTE
  }

  const peerOf = (c: Context) => {
    const token = c.req.header('authorization')?.replace(/^Bearer\s+/i, '') || c.req.header('x-api-key') || ''
    const peer = token ? pool.peerFor(token) : undefined
    if (peer) return { peer }
    return tooManyFailures(c) ? { refused: c.json({ error: 'too many attempts' }, 429) } : { refused: c.json({ error: 'a pool token is required' }, 401) }
  }

  app.get('/pool/invite/:code', async (c) => {
    const ip = getConnInfo(c).remote.address ?? 'unknown'
    if ((failures.get(ip) ?? []).filter((t) => t > Date.now() - 60e3).length >= MAX_FAILURES_PER_MINUTE) return c.json({ error: 'too many attempts' }, 429)
    // Everything that can fail runs before the one-time code is spent.
    const models = await pool.lendableModels().catch((e: Error) => e)
    if (models instanceof Error) return c.json({ error: `the lender's proxy isn't ready: ${models.message}` }, 502)
    const token = pool.invites.claim(c.req.param('code'))
    if (!token) {
      tooManyFailures(c)
      return c.json({ error: 'unknown, used or expired invite' }, 404)
    }
    return c.json({ owner: pool.owner(), token, models })
  })

  app.get('/pool/status', async (c) => {
    const { peer, refused } = peerOf(c)
    return peer ? c.json(await pool.lenderStatus(peer)) : refused
  })

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

// Hosts this dashboard is reached by: loopback, an IP, its Tailscale name, or
// one configured (DASHBOARD_HOSTS, the Tailscale URLs). Anything else is a page whose name was pointed at this
// machine (DNS rebinding), which the browser would treat as same-origin.
export function trustedHost(hostname: string, extra: string[] = []) {
  const name = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  return name === 'localhost' || /^\d{1,3}(\.\d{1,3}){3}$/.test(name) || name.includes(':') || name.endsWith('.ts.net') || extra.includes(name)
}

export function poolSettings(pool: SharingStore, drain: Drain, extraHosts: string[] = []) {
  const app = new Hono().basePath('/api/pool')

  app.use('*', async (c, next) => {
    if (!trustedHost(new URL(c.req.url).hostname, extraHosts)) return c.json({ error: 'unknown host' }, 403)
    await next()
  })

  // Writes must be JSON, which a page on another site can only send after a
  // CORS preflight this server never answers.
  app.use('*', async (c, next) => {
    if (['POST', 'PUT'].includes(c.req.method) && !c.req.header('content-type')?.startsWith('application/json'))
      return c.json({ error: 'send JSON' }, 415)
    await next()
  })

  app.get('/', (c) => c.json({ sharing: pool.sharing(), floors: pool.floors(), peers: pool.peers(), owner: pool.owner() }))

  app.put('/floor', async (c) => {
    const { pool: name, window, percent } = await c.req.json<{ pool?: string; window?: string; percent?: number }>()
    if (!isPool(name) || !window?.trim() || !Number.isInteger(percent) || percent! < 0 || percent! > 90)
      return c.json({ error: 'pool, window and a whole percent from 0 to 90 are required' }, 400)
    pool.setFloor(name, window.trim(), percent!)
    pool.forgetStatus()
    return c.json({ floors: pool.floors() })
  })

  app.get('/borrowed', async (c) => c.json(await pool.lenders()))

  app.get('/drain', (c) => c.json({ on: drain.on() }))

  app.put('/drain', async (c) => {
    const { on } = await c.req.json<{ on?: boolean }>()
    if (typeof on !== 'boolean') return c.json({ error: 'on is required' }, 400)
    try {
      await drain.set(on)
      return c.json({ on: drain.on() })
    } catch (e) {
      return c.json({ error: (e as Error).message }, 502)
    }
  })

  app.put('/owner', async (c) => {
    const { owner } = await c.req.json<{ owner?: string }>()
    pool.setOwner(owner?.trim() ?? '')
    pool.forgetStatus()
    return c.json({ owner: pool.owner() })
  })

  app.put('/sharing', async (c) => {
    const { pool: name, until } = await c.req.json<{ pool?: string; until?: number | null | false }>()
    if (!isPool(name)) return c.json({ error: 'pool is required' }, 400)
    if (until === false) pool.stopSharing(name)
    else if (until === null || (typeof until === 'number' && until > Date.now())) pool.share(name, until)
    else return c.json({ error: 'until must be a future time, null (until turned off) or false (stop)' }, 400)
    pool.forgetStatus()
    return c.json({ sharing: pool.sharing() })
  })

  app.post('/peers', async (c) => {
    const { name } = await c.req.json<{ name?: string }>()
    const trimmed = name?.trim()
    if (!trimmed) return c.json({ error: 'name is required' }, 400)
    if (pool.peers().some((p) => p.name === trimmed)) return c.json({ error: `${trimmed} is already a peer` }, 409)
    try {
      const token = await pool.addPeer(trimmed)
      return c.json({ token, ...pool.invites.mint(token) })
    } catch (e) {
      return c.json({ error: (e as Error).message }, 502)
    }
  })

  app.post('/join', async (c) => {
    const { link } = await c.req.json<{ link?: string }>()
    if (!link?.trim()) return c.json({ error: 'link is required' }, 400)
    try {
      return c.json(await pool.join(link))
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400)
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
