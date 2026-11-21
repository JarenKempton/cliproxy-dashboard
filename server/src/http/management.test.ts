import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { managementApp } from './management'

const TARGET = 'http://proxy.test'
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>>

afterEach(() => fetchSpy?.mockRestore())

function post(path: string, body: unknown) {
  fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ status: 'ok' }))
  return managementApp(TARGET, 'secret', false).request(`/v0/management${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('cooldown reset bridge', () => {
  test('forwards to the v8 management API with the management key', async () => {
    const res = await post('/routing/cooldown/reset', { auth_index: 'd3ad39a864a47e71' })
    expect(res.status).toBe(200)
    const [url, init] = fetchSpy.mock.calls[0]
    expect(url).toBe(`${TARGET}/v8/management/routing/cooldown/reset`)
    expect(init?.method).toBe('POST')
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer secret' })
    expect(JSON.parse(String(init?.body))).toEqual({ auth_index: 'd3ad39a864a47e71' })
  })

  test('refuses anything but a single account index', async () => {
    for (const body of [{}, { auth_index: 1 }, { auth_index: '' }, { auth_index: '  ' }, { auth_index: 'a', all: true }]) {
      const res = await post('/routing/cooldown/reset', body)
      expect(res.status).toBe(403)
      expect(fetchSpy).not.toHaveBeenCalled()
      fetchSpy.mockRestore()
    }
  })
})

describe('account login bridge', () => {
  test('forwards the supported login flows including Grok with server-side authentication', async () => {
    const login = { url: 'https://login.example/device', state: 'device-session', flow: 'device', user_code: 'ABCD-EFGH' }
    for (const provider of ['anthropic', 'codex', 'meta', 'xai']) {
      fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(login))
      const path = `/v0/management/${provider}-auth-url?is_webui=true`
      const res = await managementApp(TARGET, 'secret', false).request(path)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual(login)
      expect(fetchSpy).toHaveBeenCalledWith(`${TARGET}${path}`, expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ Authorization: 'Bearer secret' }),
      }))
      fetchSpy.mockRestore()
    }
  })

  test('keeps unrelated login flows and Grok callback writes blocked', async () => {
    fetchSpy = spyOn(globalThis, 'fetch')
    const app = managementApp(TARGET, 'secret', false)
    const res = await app.request('/v0/management/gemini-auth-url?is_webui=true')
    expect(res.status).toBe(403)
    const callback = await app.request('/v0/management/oauth-callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'xai', redirect_url: 'http://localhost/callback?code=not-needed' }),
    })
    expect(callback.status).toBe(403)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

test('stale Config editor saves cannot undo a completed lender pause', async () => {
  const initial = 'request-retry: 0\n'
  let current = initial
  fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async (_url: string | URL | Request, init?: RequestInit) => {
    if (init?.method === 'PUT') current = String(init.body)
    return new Response(current)
  }, { preconnect: fetch.preconnect }))
  const app = managementApp(TARGET, 'secret', false)
  const revision = `"${new Bun.CryptoHasher('sha256').update(initial).digest('hex')}"`
  current += 'codex-api-key: [{api-key: fake, excluded-models: ["*"]}]\n'
  const result = await app.request('/v0/management/config.yaml', {
    method: 'PUT', headers: { 'Content-Type': 'application/yaml', 'If-Match': revision }, body: 'request-retry: 2\n',
  })
  expect(result.status).toBe(409)
  expect(current).toContain('excluded-models')
  const missing = await app.request('/v0/management/config.yaml', { method: 'PUT', body: 'request-retry: 2\n' })
  expect(missing.status).toBe(428)
})
