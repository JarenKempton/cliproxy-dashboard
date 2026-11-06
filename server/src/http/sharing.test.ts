import { afterAll, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../db/client'
import { SharingStore } from '../sharing'
import { poolGateway, poolSettings } from './sharing'

type Account = { name: string; provider: string; unavailable?: boolean; models: string[] }

const proxy = {
  refuseDeletes: false,
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
const gateway = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: poolGateway(upstream.url.origin, store).fetch })
const token = await store.addPeer('Curt')

afterAll(() => {
  gateway.stop(true)
  upstream.stop(true)
})

beforeEach(() => {
  for (const p of ['claude', 'codex', 'grok', 'muse'] as const) store.stopSharing(p)
  proxy.accounts = [
    { name: 'claude-1.json', provider: 'claude', models: ['claude-sonnet-5-5'] },
    { name: 'codex-1.json', provider: 'codex', models: ['gpt-5.5'] },
  ]
  proxy.forwarded = []
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
  for (let i = 0; i < 12; i++) await borrow('claude-sonnet-5-5', { 'x-api-key': `pool-guess-${i}` })
  expect((await borrow('claude-sonnet-5-5', { 'x-api-key': 'pool-guess' })).status).toBe(429)
  expect((await borrow('claude-sonnet-5-5')).status).toBe(200)
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
  expect((await send('1.2')).status).toBe(403)
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

