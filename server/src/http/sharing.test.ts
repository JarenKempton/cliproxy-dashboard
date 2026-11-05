import { afterAll, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../db/client'
import { Sharing } from '../sharing'
import { poolGateway } from './sharing'

type Account = { name: string; provider: string; unavailable?: boolean; models: string[] }

const proxy = {
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
const store = new Sharing(db, upstream.url.origin, 'management')
const gateway = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: poolGateway(upstream.url.origin, store).fetch })
const token = await store.addPeer('Curt')

afterAll(() => {
  gateway.stop(true)
  upstream.stop(true)
})

beforeEach(() => {
  for (const p of ['claude', 'codex', 'grok', 'muse'] as const) store.setShared(p, false)
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
  store.setShared('claude', true)
  const res = await borrow('claude-sonnet-5-5')
  expect(res.status).toBe(200)
  expect(proxy.forwarded).toEqual([
    { path: '/v1/messages', auth: `Bearer ${proxy.apiKeys[1]}`, apiKey: null, body: JSON.stringify({ model: 'claude-sonnet-5-5', messages: [] }) },
  ])
})

test('refuses a model from a pool that is not shared', async () => {
  store.setShared('claude', true)
  expect((await borrow('gpt-5.5', { authorization: `Bearer ${token}` })).status).toBe(403)
  expect(proxy.forwarded).toHaveLength(0)
})

test('refuses when the shared pool has no working account here, so requests cannot loop back', async () => {
  store.setShared('claude', true)
  proxy.accounts[0].unavailable = true
  expect((await borrow('claude-sonnet-5-5')).status).toBe(403)
  expect(proxy.forwarded).toHaveLength(0)
})

test('refuses a proxy key or an unknown token', async () => {
  store.setShared('claude', true)
  expect((await borrow('claude-sonnet-5-5', { 'x-api-key': 'sk-own-machine' })).status).toBe(401)
  expect((await borrow('claude-sonnet-5-5', { 'x-api-key': 'pool-guess' })).status).toBe(401)
  expect(proxy.forwarded).toHaveLength(0)
})

test('removing a peer revokes its token and its proxy key', async () => {
  store.setShared('claude', true)
  const other = await store.addPeer('Guest')
  const [peer] = store.peers().filter((p) => p.name === 'Guest')
  await store.removePeer(peer.id)
  expect((await borrow('claude-sonnet-5-5', { 'x-api-key': other })).status).toBe(401)
  expect(proxy.apiKeys).toHaveLength(2)
})
