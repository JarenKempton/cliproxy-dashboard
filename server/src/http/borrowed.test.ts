import { afterEach, expect, test } from 'bun:test'
import { parse, stringify } from 'yaml'
import { openDb } from '../db/client'
import { BorrowedUpstreams } from '../borrowed-upstreams'
import { SharingStore } from '../sharing'
import { poolSettings } from './sharing'

const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })

function fixture(config: Record<string, unknown> | string) {
  let text = typeof config === 'string' ? config : stringify(config)
  let refused = false
  let onRead: (() => Promise<void>) | undefined
  const writes: string[] = []
  const proxy = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    const path = new URL(req.url).pathname.replace('/v0/management', '')
    if (path === '/config.yaml') {
      if (req.method === 'PUT') {
        writes.push(path)
        if (refused) return new Response('unavailable', { status: 503 })
        text = await req.text()
      }
      const snapshot = text
      if (req.method === 'GET') await onRead?.()
      return new Response(snapshot)
    }
    const list = path.slice(1)
    const current = parse(text)
    if (req.method === 'DELETE' && list === 'api-keys') {
      current[list] = current[list].filter((key: string) => key !== new URL(req.url).searchParams.get('value'))
      text = stringify(current)
      return Response.json({ status: 'ok' })
    }
    if (req.method === 'PUT') {
      writes.push(path)
      current[list] = await req.json()
      text = stringify(current)
      return Response.json({ status: 'ok' })
    }
    if (list === 'api-keys') return Response.json({ [list]: current[list] ?? [] })
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
  return {
    store, restart, writes, config: () => parse(text), refuse: (value: boolean) => { refused = value },
    replace: (config: Record<string, unknown>) => { text = stringify(config) },
    onRead: (callback?: () => Promise<void>) => { onRead = callback },
  }
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

test('distinct and identical duplicate routes retain their own pause snapshots', async () => {
  const gateway = lender()
  const base = { 'api-key': 'same', 'base-url': `${gateway}/pool/v1` }
  const config = { 'codex-api-key': [base, { ...base, 'excluded-models': ['*'] }, { ...base, 'proxy-url': 'http://localhost:1234', 'excluded-models': ['*'] }] }
  const f = fixture(config)
  await f.store.pauseLender(gateway, true)
  await f.restart().pauseLender(gateway, false)
  expect(f.config()).toEqual(config)
})

test('hybrid v8 legacy routes are normalized before pause snapshots are captured', async () => {
  const gateway = lender()
  const f = fixture({ 'config-version': 8, access: { 'api-keys': ['client'] }, 'codex-api-key': [{ 'api-key': 'same', 'base-url': `${gateway}/pool/v1` }] })
  await f.store.pauseLender(gateway, true)
  expect(f.config()['api-keys'].codex[0].keys[0]['excluded-models']).toEqual(['*'])
  await f.restart().pauseLender(gateway, false)
  expect(f.config()['api-keys'].codex[0].keys[0]['excluded-models']).toBeUndefined()
  expect(f.config()['api-keys'].codex[0]['excluded-models']).toBeUndefined()
})

test('pause resolves merged routes and trims upstream URLs', async () => {
  const gateway = lender()
  const f = fixture(`defaults: &borrowed\n  api-key: same\n  base-url: ${gateway}/pool/v1\ncodex-api-key:\n  - <<: *borrowed\nopenai-compatibility:\n  - name: borrowed\n    base-url: "${gateway}/pool/v1 "\n    api-key-entries: [{api-key: same}]\n`)
  await f.store.pauseLender(gateway, true)
  expect(f.config()['codex-api-key'][0]['excluded-models']).toEqual(['*'])
  expect(f.config()['openai-compatibility'][0].disabled).toBe(true)
  await f.restart().pauseLender(gateway, false)
  expect(f.config()['codex-api-key'][0]['excluded-models']).toBeUndefined()
  expect(f.config()['openai-compatibility'][0].disabled).toBeUndefined()
})

test('pause cannot resurrect a concurrently revoked peer key', async () => {
  const gateway = lender()
  const f = fixture({ 'api-keys': ['client'], 'claude-api-key': [claude(gateway)] })
  await f.store.addPeer('Example peer')
  const peer = f.store.peers()[0]
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  f.onRead(async () => { f.onRead(); entered.resolve(); await release.promise })
  const pause = f.store.pauseLender(gateway, true)
  await entered.promise
  const removal = f.store.removePeer(peer.id)
  await Bun.sleep(20)
  release.resolve()
  await Promise.all([pause, removal])
  expect(f.config()['api-keys']).toEqual(['client'])
  expect(f.store.peers()).toEqual([])
})

test('verified rejected pause does not retain stale snapshots across manual disable', async () => {
  const gateway = lender()
  const f = fixture({ 'openai-compatibility': [compat(gateway)] })
  f.refuse(true)
  await expect(f.store.pauseLender(gateway, true)).rejects.toThrow()
  f.replace({ 'openai-compatibility': [compat(gateway, true)] })
  f.refuse(false)
  await f.store.pauseLender(gateway, true)
  await f.restart().pauseLender(gateway, false)
  expect(f.config()['openai-compatibility'][0].disabled).toBe(true)
})

test('join preserves legacy client-key arrays even with config-version 8', async () => {
  const gateway = lender()
  const f = fixture({ 'config-version': 8, 'api-keys': ['client'] })
  await f.store.join(`${gateway}/pool/invite/TEST-CODE`)
  expect(f.config().access['api-keys']).toEqual(['client'])
  expect(f.config()['api-keys'].codex[0].keys[0]['api-key']).toBe('pool-new')
  await f.store.pauseLender(gateway, true)
  await f.restart().pauseLender(gateway, false)
  expect(f.config()['api-keys'].codex[0].keys[0]['excluded-models']).toBeUndefined()
})

test('v8 layout without version marker restores legacy routes after pause', async () => {
  const gateway = lender()
  const f = fixture({ server: { port: 8317 }, access: { 'api-keys': ['client'] }, 'codex-api-key': [{ 'api-key': 'same', 'base-url': `${gateway}/pool/v1` }] })
  await f.store.pauseLender(gateway, true)
  expect(f.config()['api-keys'].codex[0].keys[0]['excluded-models']).toEqual(['*'])
  await f.restart().pauseLender(gateway, false)
  expect(f.config()['api-keys'].codex[0].keys[0]['excluded-models']).toBeUndefined()
})

test('ancestor aliases, root merges and aliased client keys remain editable', async () => {
  const gateway = lender()
  for (const yaml of [
    `providers: &providers\n  codex: [{base-url: ${gateway}/pool/v1, keys: [{api-key: same}]}]\napi-keys: *providers\n`,
    `defaults: &defaults\n  codex-api-key: [{base-url: ${gateway}/pool/v1, api-key: same}]\n<<: *defaults\n`,
  ]) {
    const f = fixture(yaml)
    expect(await f.store.pauseLender(gateway, true)).toBe(true)
    expect(await f.restart().pauseLender(gateway, false)).toBe(true)
  }
  const f = fixture('config-version: 8\nclients: &clients [client]\napi-keys: *clients\n')
  await f.store.join(`${gateway}/pool/invite/TEST-CODE`)
  expect(f.config().access['api-keys']).toEqual(['client'])
})

test('rejoin token rotation preserves snapshots of unchanged duplicate routes', async () => {
  const gateway = lender()
  const base = { 'api-key': 'same', 'base-url': `${gateway}/pool/v1` }
  const f = fixture({ 'codex-api-key': [base, { ...base, 'excluded-models': ['*'] }] })
  await f.store.pauseLender(gateway, true)
  await f.store.join(`${gateway}/pool/invite/TEST-CODE`)
  await f.restart().pauseLender(gateway, false)
  expect(f.config()['codex-api-key'][0]['excluded-models']).toBeUndefined()
  expect(f.config()['codex-api-key'][1]['excluded-models']).toEqual(['*'])
})


test('thrown config write failures reconcile snapshots before a later manual disable', async () => {
  const gateway = lender()
  let text = stringify({ 'openai-compatibility': [compat(gateway)] })
  let reject = true
  const db = openDb(':memory:')
  cleanups.push(() => db.$client.close())
  const upstreams = new BorrowedUpstreams(db, async (_path, init) => {
    if (init?.method === 'PUT') {
      if (reject) throw new Error('disconnected before writing')
      text = init.raw!
    }
    return new Response(text)
  }, gateway)
  await expect(upstreams.pause(gateway, true)).rejects.toThrow('disconnected')
  text = stringify({ 'openai-compatibility': [compat(gateway, true)] })
  reject = false
  await upstreams.pause(gateway, true)
  await upstreams.pause(gateway, false)
  expect(parse(text)['openai-compatibility'][0].disabled).toBe(true)
})

test('historical providers Codex layout signal normalizes before snapshots', async () => {
  const gateway = lender()
  const f = fixture({ providers: { codex: { 'optimize-multi-agent-v2': true } }, 'codex-api-key': [{ 'api-key': 'same', 'base-url': `${gateway}/pool/v1` }] })
  await f.store.pauseLender(gateway, true)
  expect(f.config()['api-keys'].codex[0].keys[0]['excluded-models']).toEqual(['*'])
  await f.restart().pauseLender(gateway, false)
  expect(f.config()['api-keys'].codex[0].keys[0]['excluded-models']).toBeUndefined()
})

test.each(['0xdeadbeef', '0xDEADBEEF', '00123', '1E+03'])('alias expansion preserves client credential spelling %s and comments', async (literal) => {
  const gateway = lender()
  const { UpstreamConfig } = await import('../upstream-config')
  const source = `# client access\napi-keys: [${literal}] # keep credential spelling\nrequest-retry: &retry 0\nmax-retry-interval: *retry\ncodex-api-key:\n  - api-key: local-proof\n    base-url: ${gateway}/pool/v1\n`
  const config = new UpstreamConfig(source)
  const route = config.routes()[0]
  config.pause(route)
  const paused = config.toString()
  expect(paused).toContain(literal)
  expect(paused).toContain('# client access')
  expect(paused).toContain('# keep credential spelling')
  expect(new UpstreamConfig(paused).routes()[0].entry['excluded-models']).toEqual(['*'])
})
