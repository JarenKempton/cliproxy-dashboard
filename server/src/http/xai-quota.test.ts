import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { type AuthFile } from '../../../src/lib/api'
import { describeQuotaError } from '../../../src/lib/errors'
import { fetchQuota } from '../../../src/lib/quota'

const account: AuthFile = { name: 'xai-test.json', auth_index: 'xai-test', provider: 'xai' }
const DAY = 86400e3
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>>

function respond(body: unknown) {
  fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ status_code: 200, body }))
}

afterEach(() => fetchSpy?.mockRestore())

const weekly = {
  type: 'USAGE_PERIOD_TYPE_WEEKLY',
  start: '2026-10-22T10:04:12.403150+00:00',
  end: '2026-10-29T10:04:12.403150+00:00',
}

describe('Grok quota', () => {
  test('reads the weekly credit pool through the proxy with the Grok CLI headers', async () => {
    respond({
      config: {
        currentPeriod: weekly,
        creditUsagePercent: 1.0,
        productUsage: [{ product: 'GrokBuild', usagePercent: 1.0 }, { product: 'GrokChat' }],
        isUnifiedBillingUser: true,
      },
    })
    expect(await fetchQuota(account)).toEqual({
      windows: [{ id: 'weekly', label: 'Weekly', usedPercent: 1, resetAtMs: Date.parse(weekly.end), periodMs: 7 * DAY }],
    })
    const [url, init] = fetchSpy.mock.calls[0]
    expect(url).toBe('/v0/management/api-call')
    expect(JSON.parse(String(init?.body))).toMatchObject({
      authIndex: 'xai-test',
      method: 'GET',
      url: 'https://cli-chat-proxy.grok.com/v1/billing?format=credits',
      header: { Authorization: 'Bearer $TOKEN$', 'X-XAI-Token-Auth': 'xai-grok-cli' },
    })
  })

  test('treats an omitted percentage as nothing used yet', async () => {
    respond({ config: { currentPeriod: weekly } })
    expect((await fetchQuota(account)).windows[0].usedPercent).toBe(0)
  })

  test('leaves an unparseable reset time unknown', async () => {
    respond({ config: { currentPeriod: { ...weekly, end: 'not-a-date' }, creditUsagePercent: 5 } })
    expect((await fetchQuota(account)).windows[0].resetAtMs).toBeNull()
  })

  test('sizes a monthly period from its own dates', async () => {
    respond({
      config: {
        currentPeriod: { type: 'USAGE_PERIOD_TYPE_MONTHLY', start: '2026-10-01T00:00:00Z', end: '2026-11-01T00:00:00Z' },
        creditUsagePercent: 10,
      },
    })
    expect((await fetchQuota(account)).windows).toEqual([
      { id: 'monthly', label: 'Monthly', usedPercent: 10, resetAtMs: Date.parse('2026-11-01T00:00:00Z'), periodMs: 31 * DAY },
    ])
  })

  test('reports a response without a usage period as unavailable', async () => {
    for (const body of [{}, { config: {} }, null]) {
      respond(body)
      const error = await fetchQuota(account).then(
        () => null,
        (e: unknown) => describeQuotaError(e, 'xai'),
      )
      expect(error).toMatchObject({ title: 'Quota unavailable', code: 'no_usage' })
      fetchSpy.mockRestore()
    }
  })
})
