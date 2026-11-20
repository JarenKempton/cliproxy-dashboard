import { afterEach, expect, test } from 'bun:test'
import { parse, stringify } from 'yaml'
import { openDb } from '../db/client'
import { SharingStore } from '../sharing'
import { poolSettings } from './sharing'

const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })

function fixture(config: Record<string, unknown>) {
  let text = stringify(config)
  let refused = false
  const writes: string[] = []
  const proxy = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    const path = new URL(req.url).pathname.replace('/v0/management', '')
    if (path === '/config.yaml') {
      if (req.method === 'PUT') {
        writes.push(path)
        if (refused) return new Response('unavailable', { status: 503 })
        text = await req.text()
      }
      return new Response(text)
    }
    const list = path.slice(1)
    const current = parse(text)
    if (req.method === 'PUT') {
      writes.push(path)
      current[list] = await req.json()
      text = stringify(current)
      return Response.json({ status: 'ok' })
    }
    const entries = (current[list] ?? []).map((entry: Record<string, unknown>) => {
      const { 'connection-pool': omitted, ...rest } = entry
      void omitted
      return rest
    })
    return Response.json({ [list]: entries })
  } })
  const db = openDb(':memory:')
  const restart = () => new SharingStore(db, proxy.url.origin, 'test-management')
  const store = restart()
  cleanups.push(() => { proxy.stop(true); db.$client.close() })
  return { store, restart, writes, config: () => parse(text), refuse: (value: boolean) => { refused = value } }
}

function lender() {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(req) {
    if (new URL(req.url).pathname.startsWith('/pool/invite/')) return Response.json({ owner: 'Example', token: 'pool-new', models: ['grok-proof'] })
    return Response.json({ owner: 'Example', pools: [{ pool: 'claude', provider: 'claude', until: null, floors: {}, accounts: [] }] })
  } })
  cleanups.push(() => server.stop(true))
  return server.url.origin
}

const claude = (gateway: string, token = 'pool-first') => ({ 'api-key': token, 'base-url': `${gateway}/pool`, priority: -1 })
const compat = (gateway: string, disabled = false) => ({ name: 'pool-example', 'base-url': `${gateway}/pool/v1`, 'api-key-entries': [{ 'api-key': 'pool-first' }], models: [{ name: 'grok-proof' }], disabled })

test('pause and concurrent rejoin keep newly introduced models paused until resume', async () => {
  const gateway = lender()
  const f = fixture({ 'claude-api-key': [claude(gateway)] })
  await Promise.all([f.store.pauseLender(gateway, true), f.store.join(`${gateway}/pool/invite/TEST-CODE`)])
  expect(f.config()['openai-compatibility'][0].disabled).toBe(true)
  expect(f.config()['claude-api-key'][0]['excluded-models']).toEqual(['*'])
  await f.restart().pauseLender(gateway, false)
  expect(f.config()['openai-compatibility'][0].disabled).toBeUndefined()
  expect(f.config()['claude-api-key'][0]['excluded-models']).toBeUndefined()
})

test('two tokens for the same gateway produce one control and one quota pool', async () => {
  const gateway = lender()
  const f = fixture({ 'claude-api-key': [claude(gateway), claude(gateway, 'pool-second')] })
  const lenders = await f.store.lenders()
  expect(lenders).toHaveLength(1)
  expect(lenders[0].pools).toHaveLength(1)
  await f.store.pauseLender(gateway, true)
  expect((await f.store.lenders())[0].paused).toBe(true)
})

test('pause preserves unreported connection settings and unrelated providers', async () => {
  const gateway = lender()
  const config = { 'openai-compatibility': [
    { ...compat(gateway), 'connection-pool': { enabled: true, 'max-idle-conns': 17 } },
    { ...compat('https://other.example'), name: 'other', 'connection-pool': { enabled: true } },
  ], logging: { untouched: true } }
  const f = fixture(config)
  await f.store.pauseLender(gateway, true)
  expect(f.config()['openai-compatibility'][0]['connection-pool']).toEqual(config['openai-compatibility'][0]['connection-pool'])
  expect(f.config()['openai-compatibility'][1]).toEqual(config['openai-compatibility'][1])
  await f.store.pauseLender(gateway, false)
  expect(f.config()).toEqual(config)
  expect(f.writes).toEqual(['/config.yaml', '/config.yaml'])
})

test('a rejected atomic config write leaves all providers unchanged and can be retried', async () => {
  const gateway = lender()
  const config = { 'claude-api-key': [claude(gateway)], 'codex-api-key': [{ 'api-key': 'pool-first', 'base-url': `${gateway}/pool/v1` }] }
  const f = fixture(config)
  f.refuse(true)
  const response = await poolSettings(f.store).request('http://localhost/api/pool/borrowed', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ gateway, paused: true }),
  })
  expect(response.status).toBe(502)
  expect(f.config()).toEqual(config)
  expect(f.writes).toEqual(['/config.yaml'])
  f.refuse(false)
  await f.store.pauseLender(gateway, true)
  expect(f.config()['claude-api-key'][0]['excluded-models']).toEqual(['*'])
  expect(f.config()['codex-api-key'][0]['excluded-models']).toEqual(['*'])
})

test('resume after a dashboard restart preserves manually disabled routes and exclusions', async () => {
  const gateway = lender()
  const config = { 'claude-api-key': [{ ...claude(gateway), 'excluded-models': ['claude-opus-*'] }], 'openai-compatibility': [compat(gateway, true)] }
  const f = fixture(config)
  await f.store.pauseLender(gateway, true)
  await f.restart().pauseLender(gateway, false)
  expect(f.config()).toEqual(config)
})

test('pause and rejoin preserve grouped v8 fields and restore inherited exclusions', async () => {
  const gateway = lender()
  const config = { 'config-version': 8, 'api-keys': {
    claude: [{ name: 'borrowed', 'base-url': `${gateway}/pool`, 'excluded-models': ['claude-opus-*'], keys: [{ 'api-key': 'pool-first' }] }],
    'openai-compatibility': [{ name: 'pool-example', 'base-url': `${gateway}/pool/v1`, disabled: true, 'connection-pool': { enabled: true }, keys: [{ 'api-key': 'pool-first' }], models: [{ name: 'grok-proof' }] }],
  } }
  const f = fixture(config)
  await f.store.pauseLender(gateway, true)
  expect(f.config()['api-keys'].claude[0].keys[0]['excluded-models']).toEqual(['claude-opus-*', '*'])
  await f.restart().pauseLender(gateway, false)
  expect(f.config()).toEqual(config)
  await f.store.join(`${gateway}/pool/invite/TEST-CODE`)
  expect(f.config()['api-keys'].claude[0].keys[0]['api-key']).toBe('pool-new')
  expect(f.config()['api-keys']['openai-compatibility'][0]['connection-pool']).toEqual({ enabled: true })
  expect(f.config()['api-keys']['openai-compatibility'][0].disabled).toBe(true)
})
