import { afterAll, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sendManagementVia } from '../../../src/lib/api'
import { openDb } from '../db/client'
import { requests } from '../db/schema'
import { hashKey } from '../usage/cliproxy-record'
import { SharingStore } from '../sharing'
import { poolGateway, poolSettings } from './sharing'

type Account = { name: string; auth_index: string; email: string; provider: string; unavailable?: boolean; models: string[] }

const proxy = {
  refuseDeletes: false,
  quotaDown: false,
  quotaReads: 0,
  unreadable: [] as string[],
  upstreamKeys: [] as { 'api-key': string; 'base-url': string }[],
  apiKeys: ['sk-own-machine'],
  accounts: [] as Account[],
  forwarded: [] as { path: string; auth: string | null; apiKey: string | null; body: string }[],
}

const upstream = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === '/v0/management/api-keys') {
      if (req.method === 'GET') return Response.json({ 'api-keys': proxy.apiKeys })
      if (req.method === 'PUT') proxy.apiKeys = (await req.json()) as string[]
      if (req.method === 'DELETE' && proxy.refuseDeletes) return new Response('down', { status: 500 })
      if (req.method === 'DELETE') proxy.apiKeys = proxy.apiKeys.filter((k) => k !== url.searchParams.get('value'))
      return Response.json({ status: 'ok' })
    }
    if (url.pathname === '/v0/management/auth-files') return Response.json({ files: proxy.accounts })
    if (url.pathname === '/v0/management/claude-api-key') return Response.json({ 'claude-api-key': proxy.upstreamKeys })
    if (url.pathname === '/v0/management/api-call') {
      const call = (await req.json()) as { url: string; authIndex: string }
      if (call.url.endsWith('/usage')) proxy.quotaReads++
      if (proxy.quotaDown || proxy.unreadable.includes(call.authIndex)) return Response.json({ status_code: 429, header: { 'Retry-After': ['60'] }, body: '{}' })
      const usage = { limits: [{ kind: 'weekly_all', percent: 40, resets_at: '2099-01-01T00:00:00Z' }] }
      return Response.json({ status_code: 200, body: call.url.endsWith('/usage') ? JSON.stringify(usage) : '{}' })
    }
    if (url.pathname === '/v0/management/auth-files/models') {
      const account = proxy.accounts.find((a) => a.name === url.searchParams.get('name'))
      return Response.json({ models: (account?.models ?? []).map((id) => ({ id })) })
    }
    proxy.forwarded.push({ path: url.pathname, auth: req.headers.get('authorization'), apiKey: req.headers.get('x-api-key'), body: await req.text() })
    return Response.json({ ok: true })
  },
})

const db = openDb(join(mkdtempSync(join(tmpdir(), 'pool-')), 'usage.db'))
const store = new SharingStore(db, upstream.url.origin, 'management')
sendManagementVia((path, init) => fetch(`${upstream.url.origin}${path}`, init))
const gateway = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: poolGateway(upstream.url.origin, store).fetch })
const token = await store.addPeer('Curt')

afterAll(() => {
  gateway.stop(true)
  upstream.stop(true)
})

beforeEach(() => {
  for (const p of ['claude', 'codex', 'grok', 'muse'] as const) {
    store.stopSharing(p)
    for (const w of ['5-hour', 'Weekly']) store.setFloor(p, w, 0)
  }
  proxy.accounts = [
    { name: 'claude-1.json', auth_index: 'c1', email: 'lender@example.com', provider: 'claude', models: ['claude-sonnet-5-5'] },
    { name: 'codex-1.json', auth_index: 'x1', email: 'lender@example.com', provider: 'codex', models: ['gpt-5.5'] },
  ]
  proxy.forwarded = []
  store.forgetStatus()
})

const borrow = (model: string, headers: Record<string, string> = { 'x-api-key': token }) =>
  fetch(`${gateway.url.origin}/pool/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ model, messages: [] }),
  })

test('adding a peer gives the proxy a key of its own that the peer never holds', () => {
  expect(proxy.apiKeys).toHaveLength(2)
  expect(proxy.apiKeys[1]).toStartWith('sk-pool-')
  expect(proxy.apiKeys).not.toContain(token)
})

test('refuses everything while nothing is shared, without reaching the proxy', async () => {
  const res = await borrow('claude-sonnet-5-5')
  expect(res.status).toBe(403)
  expect(proxy.forwarded).toHaveLength(0)
})

test('forwards a shared pool’s model with the peer’s proxy key in place of the pool token', async () => {
  store.share('claude', null)
  const res = await borrow('claude-sonnet-5-5')
  expect(res.status).toBe(200)
  expect(proxy.forwarded).toEqual([
    { path: '/v1/messages', auth: `Bearer ${proxy.apiKeys[1]}`, apiKey: null, body: JSON.stringify({ model: 'claude-sonnet-5-5', messages: [] }) },
  ])
})

test('refuses a model from a pool that is not shared', async () => {
  store.share('claude', null)
  expect((await borrow('gpt-5.5', { authorization: `Bearer ${token}` })).status).toBe(403)
  expect(proxy.forwarded).toHaveLength(0)
})

test('refuses when the shared pool has no working account here, so requests cannot loop back', async () => {
  store.share('claude', null)
  proxy.accounts[0].unavailable = true
  expect((await borrow('claude-sonnet-5-5')).status).toBe(403)
  expect(proxy.forwarded).toHaveLength(0)
})

test('refuses a proxy key or an unknown token', async () => {
  store.share('claude', null)
  expect((await borrow('claude-sonnet-5-5', { 'x-api-key': 'sk-own-machine' })).status).toBe(401)
  expect((await borrow('claude-sonnet-5-5', { 'x-api-key': 'pool-guess' })).status).toBe(401)
  expect(proxy.forwarded).toHaveLength(0)
})

test('removing a peer revokes its token and its proxy key', async () => {
  store.share('claude', null)
  const other = await store.addPeer('Guest')
  const [peer] = store.peers().filter((p) => p.name === 'Guest')
  await store.removePeer(peer.id)
  expect((await borrow('claude-sonnet-5-5', { 'x-api-key': other })).status).toBe(401)
  expect(proxy.apiKeys).toHaveLength(2)
})

test('stops sharing by itself when the chosen time passes', async () => {
  store.share('claude', Date.now() + 150)
  expect((await borrow('claude-sonnet-5-5')).status).toBe(200)
  await Bun.sleep(200)
  expect((await borrow('claude-sonnet-5-5')).status).toBe(403)
  expect(store.sharing().claude).toBeNull()
})

test('forwards the body as checked, so a second "model" key can’t reach an unshared pool', async () => {
  store.share('claude', null)
  const res = await fetch(`${gateway.url.origin}/pool/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': token },
    body: '{"model":"gpt-5.5","model":"claude-sonnet-5-5","messages":[]}',
  })
  expect(res.status).toBe(200)
  expect(proxy.forwarded[0].body).toBe('{"model":"claude-sonnet-5-5","messages":[]}')
})

test('someone guessing tokens doesn’t lock out a peer with a valid one', async () => {
  store.share('claude', null)
  const own = poolGateway(upstream.url.origin, store)
  const send = (key: string) =>
    own.request('/pool/v1/messages', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': key }, body: '{"model":"claude-sonnet-5-5"}' }, { server: { requestIP: () => ({ address: '10.0.0.9' }), timeout: () => {} } })
  for (let i = 0; i < 12; i++) await send(`pool-guess-${i}`)
  expect((await send('pool-guess')).status).toBe(429)
  expect((await send(token)).status).toBe(200)
})

test('settings writes must be JSON, so another site can’t post them', async () => {
  const settings = poolSettings(store)
  const res = await settings.request('/api/pool/peers', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{"name":"Mallory"}' })
  expect(res.status).toBe(415)
  expect(store.peers().map((p) => p.name)).not.toContain('Mallory')
})

test('a peer stays until the proxy has actually dropped its key', async () => {
  await store.addPeer('Kept')
  const [peer] = store.peers().filter((p) => p.name === 'Kept')
  proxy.refuseDeletes = true
  await expect(store.removePeer(peer.id)).rejects.toThrow('refused to remove')
  expect(store.peers().map((p) => p.name)).toContain('Kept')
  proxy.refuseDeletes = false
  await store.removePeer(peer.id)
})

test('settings refuse a host that isn’t this dashboard, so a rebound DNS name can’t use them', async () => {
  const settings = poolSettings(store, ['dash.example.org'])
  const send = (host: string) => settings.request(`http://${host}/api/pool/peers`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"name":""}' })
  expect((await send('attacker.example:5174')).status).toBe(403)
  for (const host of ['127.0.0.1:5174', 'localhost:5174', '[::1]:5174', '192.168.1.20:8318', 'box.tail1234.ts.net', 'dash.example.org']) expect((await send(host)).status).toBe(400)
})

test('a peer isn’t left behind when the proxy can’t be reached while adding it', async () => {
  const before = store.peers().length
  const original = globalThis.fetch
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) =>
    String(input).endsWith('/api-keys') && init?.method === 'PUT' ? Promise.reject(new Error('reset')) : original(input, init)) as typeof fetch
  try {
    await expect(store.addPeer('Flaky')).rejects.toThrow('couldn’t reach the proxy')
  } finally {
    globalThis.fetch = original
  }
  expect(store.peers()).toHaveLength(before)
})

test('tells a peer what is shared right now: quota windows, hourly cost, its own part, and when it ends', async () => {
  const hour = Math.floor(Date.now() / 3600e3) * 3600e3 - 3600e3
  db.insert(requests)
    .values([
      { id: 'r1', source: 'cliproxy', occurredAt: new Date(hour + 60e3), receivedAt: new Date(), provider: 'claude', model: 'claude-sonnet-5-5', accountLabel: 'lender@example.com', failed: false, costMicros: 1200 },
      { id: 'r2', source: 'cliproxy', occurredAt: new Date(hour + 90e3), receivedAt: new Date(), provider: 'claude', model: 'claude-sonnet-5-5', accountLabel: 'lender@example.com', clientKeyHash: hashKey(proxy.apiKeys[1]), failed: false, costMicros: 300 },
    ])
    .run()
  store.setOwner('Jaren')
  const until = Date.now() + 3600e3
  store.share('claude', until)
  const status = (url: string, token?: string) => fetch(url, { headers: token ? { authorization: `Bearer ${token}` } : {} })

  expect((await status(`${gateway.url.origin}/pool/status`)).status).toBe(401)
  expect(await (await status(`${gateway.url.origin}/pool/status`, token)).json()).toEqual({
    owner: 'Jaren',
    pools: [
      {
        pool: 'claude',
        provider: 'claude',
        until,
        floors: {},
        accounts: [{ windows: [{ id: 'weekly', label: 'Weekly', usedPercent: 40, resetAtMs: Date.parse('2099-01-01T00:00:00Z'), periodMs: 168 * 3600e3 }], cost: [[hour, 1500]], yourCost: [[hour, 300]] }],
      },
    ],
  })
})

test('finds the peers this proxy borrows from in its own upstream config', async () => {
  store.setOwner('Jaren')
  store.share('claude', null)
  proxy.upstreamKeys = [
    { 'api-key': token, 'base-url': `${gateway.url.origin}/pool` },
    { 'api-key': 'sk-ant-real', 'base-url': 'https://api.anthropic.com' },
  ]
  const [lender, ...rest] = await store.lenders()
  expect(rest).toEqual([])
  expect(lender.gateway).toBe(gateway.url.origin)
  expect(lender.owner).toBe('Jaren')
  expect(lender.pools.map((p) => [p.pool, p.until])).toEqual([['claude', null]])
})

test('refuses once a window is down to the share its owner keeps, and ignores windows the pool lacks', async () => {
  store.share('claude', null)
  store.setFloor('claude', 'Weekly', 70)
  expect((await borrow('claude-sonnet-5-5')).status).toBe(403)
  store.setFloor('claude', 'Weekly', 50)
  store.setFloor('claude', '5-hour', 90)
  expect((await borrow('claude-sonnet-5-5')).status).toBe(200)
  expect(proxy.forwarded).toHaveLength(1)
  expect(store.floors().claude).toEqual({ Weekly: 50, '5-hour': 90 })
})

test('refuses while a kept share can’t be checked because quota can’t be read', async () => {
  store.share('claude', null)
  store.setFloor('claude', 'Weekly', 30)
  proxy.quotaDown = true
  expect((await borrow('claude-sonnet-5-5')).status).toBe(403)
  proxy.quotaDown = false
  expect((await borrow('claude-sonnet-5-5')).status).toBe(200)
})

test('refuses when any working account’s quota can’t be read, since it could be the one nearly spent', async () => {
  store.share('claude', null)
  store.setFloor('claude', 'Weekly', 30)
  proxy.accounts.push({ name: 'claude-2.json', auth_index: 'c2', email: 'second@example.com', provider: 'claude', models: ['claude-sonnet-5-5'] })
  proxy.unreadable = ['c2']
  expect((await borrow('claude-sonnet-5-5')).status).toBe(403)
  proxy.unreadable = []
  expect((await borrow('claude-sonnet-5-5')).status).toBe(200)
})

test('a brief quota outage uses the last good reading instead of cutting lending off', async () => {
  store.share('claude', null)
  store.setFloor('claude', 'Weekly', 30)
  expect((await borrow('claude-sonnet-5-5')).status).toBe(200)
  proxy.quotaDown = true
  expect((await borrow('claude-sonnet-5-5')).status).toBe(200)
  proxy.quotaDown = false
})

test('busy borrowing reads each account’s quota at most once a minute', async () => {
  store.share('claude', null)
  store.setFloor('claude', 'Weekly', 30)
  proxy.quotaReads = 0
  for (let i = 0; i < 5; i++) expect((await borrow('claude-sonnet-5-5')).status).toBe(200)
  expect(proxy.quotaReads).toBe(1)
})

