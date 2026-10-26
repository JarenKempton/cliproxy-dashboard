// Lets the Muse Code CLI run through the proxy. Muse reads its model catalog
// and config from /muse-code/* at the root of its endpoint, beside /v1, and
// won't start without them. CLIProxyAPI doesn't serve those yet
// (router-for-me/CLIProxyAPI#6563), so Muse points at the dashboard instead:
//
//   /muse-code/{models,config,search,browser_open}   fetched from Meta with one of the proxy's
//                                                    Meta accounts, for clients holding a proxy key
//   /v1/*                                            passed through to the proxy unchanged, so the
//                                                    proxy still checks the key, picks the account
//                                                    and records usage

import { Hono } from 'hono'
import type { ProxyKeys } from '../proxy-keys'

const META_ORIGIN = 'https://api.meta.ai'
const RELAYED = new Set(['models', 'config', 'search', 'browser_open'])
const SENT_UP = /^(accept|content-type|traceparent|if-none-match|x-tbh-.*|x-meta-ai-.*)$/i
const SENT_DOWN = new Set(['content-type', 'cache-control', 'etag', 'last-modified', 'retry-after'])
// Per-connection headers, plus the body framing Bun redoes after decompressing.
const HOP_BY_HOP = ['connection', 'keep-alive', 'transfer-encoding', 'content-encoding', 'content-length', 'host']

type AuthEntry = { auth_index: string; provider?: string; type?: string; disabled?: boolean; unavailable?: boolean }
type ApiCallResult = { status_code: number; header?: Record<string, string[]>; body: unknown }

const withoutHopByHop = (headers: Headers) => {
  const out = new Headers(headers)
  for (const h of HOP_BY_HOP) out.delete(h)
  return out
}

export function museRelay(target: string, managementKey: string, keys: ProxyKeys) {
  const management = (path: string, body?: unknown) =>
    fetch(`${target}/v0/management${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${managementKey}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  const app = new Hono()

  app.all('/muse-code/:name', async (c) => {
    const name = c.req.param('name')
    if (!RELAYED.has(name)) return c.json({ error: `/muse-code/${name} is not relayed` }, 404)
    const key = c.req.header('authorization')?.replace(/^Bearer\s+/i, '')
    if (!key || !(await keys.has(key))) return c.json({ error: 'a proxy API key is required' }, 401)

    const files = ((await (await management('/auth-files')).json()) as { files?: AuthEntry[] }).files ?? []
    const account = files.find((f) => (f.provider ?? f.type) === 'meta' && !f.disabled && !f.unavailable)
    if (!account) return c.json({ error: 'The proxy has no active Meta (Muse Code) account' }, 503)

    const query = new URL(c.req.url).searchParams
    query.delete('key')
    query.delete('auth_token')
    const search = query.size ? `?${query}` : ''
    const header = Object.fromEntries([...c.req.raw.headers].filter(([k]) => SENT_UP.test(k)))
    const res = await management('/api-call', {
      authIndex: account.auth_index,
      method: c.req.method,
      url: `${META_ORIGIN}/muse-code/${name}${search}`,
      header: { ...header, Authorization: 'Bearer $TOKEN$' },
      data: ['GET', 'HEAD'].includes(c.req.method) ? undefined : await c.req.text(),
    })
    if (!res.ok) return c.json({ error: `The proxy refused the relay (HTTP ${res.status})` }, 502)

    const out = (await res.json()) as ApiCallResult
    const headers = new Headers()
    for (const [k, v] of Object.entries(out.header ?? {})) if (SENT_DOWN.has(k.toLowerCase()) && v[0]) headers.set(k, v[0])
    return new Response(typeof out.body === 'string' ? out.body : JSON.stringify(out.body), { status: out.status_code, headers })
  })

  app.all('/v1/*', async (c) => {
    const url = new URL(c.req.url)
    const hasBody = !['GET', 'HEAD'].includes(c.req.method)
    const res = await fetch(`${target}${url.pathname}${url.search}`, {
      method: c.req.method,
      headers: withoutHopByHop(c.req.raw.headers),
      body: hasBody ? c.req.raw.body : undefined,
      duplex: 'half',
    } as RequestInit)
    return new Response(res.body, { status: res.status, headers: withoutHopByHop(res.headers) })
  })

  return app
}
