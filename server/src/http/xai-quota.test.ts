import { describe, expect, test } from 'bun:test'
import { QuotaUnavailableError } from '../../../src/lib/quota-types'
import { xaiWindows, type XaiConfig } from '../../../src/lib/xai-quota'

describe('xaiWindows', () => {
  test('parses the real weekly response body (1% usage)', () => {
    const config = {
      currentPeriod: {
        type: 'USAGE_PERIOD_TYPE_WEEKLY',
        start: '2026-10-22T10:04:12.403150+00:00',
        end: '2026-10-29T10:04:12.403150+00:00',
      },
      creditUsagePercent: 1.0,
      onDemandCap: { val: 0 },
      onDemandUsed: { val: 0 },
      productUsage: [{ product: 'GrokBuild', usagePercent: 1.0 }, { product: 'GrokChat' }, { product: 'GrokVoice' }],
      isUnifiedBillingUser: true,
      prepaidBalance: { val: 0 },
      topUpMethod: 'TOP_UP_METHOD_SAVED_PAYMENT_METHOD',
      billingPeriodStart: '2026-10-22T10:04:12.403150+00:00',
      billingPeriodEnd: '2026-10-29T10:04:12.403150+00:00',
    }

    const windows = xaiWindows(config)
    expect(windows).toHaveLength(1)
    expect(windows[0]).toMatchObject({
      id: 'weekly',
      label: 'Weekly',
      usedPercent: 1.0,
      resetAtMs: Date.parse('2026-10-29T10:04:12.403150+00:00'),
      periodMs: 7 * 24 * 3600e3,
    })
  })

  test('omitted creditUsagePercent with currentPeriod yields 0%', () => {
    const config: XaiConfig = {
      currentPeriod: {
        type: 'USAGE_PERIOD_TYPE_WEEKLY',
        start: '2026-10-22T10:04:12.403150+00:00',
        end: '2026-10-29T10:04:12.403150+00:00',
      },
      billingPeriodStart: '2026-10-22T10:04:12.403150+00:00',
      billingPeriodEnd: '2026-10-29T10:04:12.403150+00:00',
    }

    const windows = xaiWindows(config)
    expect(windows).toHaveLength(1)
    expect(windows[0]).toMatchObject({
      id: 'weekly',
      label: 'Weekly',
      usedPercent: 0,
      resetAtMs: Date.parse('2026-10-29T10:04:12.403150+00:00'),
    })
  })

  test('legacy monthly shape uses monthlyLimit/used in cents', () => {
    const config: XaiConfig = {
      monthlyLimit: { val: 2000 },
      used: { val: 500 },
      billingPeriodStart: '2026-10-01T00:00:00Z',
      billingPeriodEnd: '2026-10-31T23:59:59Z',
    }

    const windows = xaiWindows(config)
    expect(windows).toHaveLength(1)
    expect(windows[0]).toMatchObject({
      id: 'monthly',
      label: 'Monthly',
      usedPercent: 25,
      resetAtMs: Date.parse('2026-10-31T23:59:59Z'),
    })
  })

  test('empty config throws QuotaUnavailableError', () => {
    const config: XaiConfig = {}
    expect(() => xaiWindows(config)).toThrow(QuotaUnavailableError)
    expect(() => xaiWindows(config)).toThrow('xAI returned no usage percentages.')
  })

  test('unparseable currentPeriod.end falls back to billingPeriodEnd', () => {
    const config: XaiConfig = {
      currentPeriod: {
        type: 'USAGE_PERIOD_TYPE_WEEKLY',
        start: '2026-10-22T10:04:12.403150+00:00',
        end: 'not-a-date',
      },
      creditUsagePercent: 5.0,
      billingPeriodEnd: '2026-10-29T10:04:12.403150+00:00',
    }

    const windows = xaiWindows(config)
    expect(windows).toHaveLength(1)
    expect(windows[0].resetAtMs).toBe(Date.parse('2026-10-29T10:04:12.403150+00:00'))
  })

  test('legacy cents as strings ("2000"/"500" → 25%)', () => {
    const config: XaiConfig = {
      monthlyLimit: { val: '2000' as unknown as number },
      used: { val: '500' as unknown as number },
      billingPeriodStart: '2026-10-01T00:00:00Z',
      billingPeriodEnd: '2026-10-31T23:59:59Z',
    }

    const windows = xaiWindows(config)
    expect(windows).toHaveLength(1)
    expect(windows[0]).toMatchObject({
      id: 'monthly',
      label: 'Monthly',
      usedPercent: 25,
    })
  })

  test('currentPeriod without percent plus legacy fields → legacy percent', () => {
    const config: XaiConfig = {
      currentPeriod: {
        type: 'USAGE_PERIOD_TYPE_MONTHLY',
        start: '2026-10-01T00:00:00Z',
        end: '2026-10-31T23:59:59Z',
      },
      monthlyLimit: { val: 2000 },
      used: { val: 500 },
      billingPeriodStart: '2026-10-01T00:00:00Z',
      billingPeriodEnd: '2026-10-31T23:59:59Z',
    }

    const windows = xaiWindows(config)
    expect(windows).toHaveLength(1)
    expect(windows[0]).toMatchObject({
      id: 'monthly',
      label: 'Monthly',
      usedPercent: 25,
    })
  })

  test('monthly currentPeriod from 2026-10-01 to 2026-11-01 gets periodMs = 31 days', () => {
    const config: XaiConfig = {
      currentPeriod: {
        type: 'USAGE_PERIOD_TYPE_MONTHLY',
        start: '2026-10-01T00:00:00Z',
        end: '2026-11-01T00:00:00Z',
      },
      creditUsagePercent: 10.0,
    }

    const windows = xaiWindows(config)
    expect(windows).toHaveLength(1)
    expect(windows[0].periodMs).toBe(31 * 86400e3)
  })
})
