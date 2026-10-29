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
