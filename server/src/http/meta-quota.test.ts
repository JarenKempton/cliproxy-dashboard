import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { type AuthFile } from '../../../src/lib/api'
import { describeQuotaError } from '../../../src/lib/errors'
import { fetchQuota } from '../../../src/lib/quota'

const account: AuthFile = { name: 'meta-test.json', auth_index: 'meta-test', provider: 'meta' }
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>>

function respond(body: unknown) {
  fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ status_code: 200, body }))
}

afterEach(() => fetchSpy?.mockRestore())

describe('Muse quota', () => {
  test('does not replace the last reading with a successful empty quota', async () => {
    for (const subs_usage of [undefined, null, {}, { window: null, weekly: null }]) {
      respond({ subs_tier_name: 'Muse Code Power Usage', subs_usage })
      const result = await fetchQuota(account).then(
        (quota) => ({ quota }),
        (error: unknown) => ({ error: describeQuotaError(error, 'meta') }),
      )
      expect(result).toMatchObject({
        error: {
          title: 'Quota unavailable',
          code: 'no_usage',
          message: expect.stringContaining('not current'),
        },
      })
      fetchSpy.mockRestore()
    }
  })

  test('keeps reported zero and over-quota percentages, reset stamps and plan', async () => {
    respond({
      subs_tier_name: 'Muse Code Power Usage',
      subs_usage: {
        window: { used_percent: 0, resets_at: 1793088000, window_duration_mins: 300 },
        weekly: { used_percent: 125, resets_at: 1793577600 },
      },
    })
    expect(await fetchQuota(account)).toEqual({
      plan: 'Power',
      windows: [
        { id: 'session', label: '5-hour', usedPercent: 0, resetAtMs: 1793088000000, periodMs: 18000000 },
        { id: 'weekly', label: 'Weekly', usedPercent: 125, resetAtMs: 1793577600000, periodMs: 604800000 },
      ],
    })
  })

  test('keeps a reported weekly window without inventing a session window', async () => {
    respond({ subs_usage: { weekly: { used_percent: 36 } } })
    expect((await fetchQuota(account)).windows).toEqual([
      { id: 'weekly', label: 'Weekly', usedPercent: 36, resetAtMs: null, periodMs: 604800000 },
    ])
  })
})
