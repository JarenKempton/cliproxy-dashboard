import { expect, test } from 'bun:test'
import type { QuotaWindow } from './quota'
import { quotaLimit } from './status'

const H = 3600e3
const now = Date.parse('2026-11-21T12:00:00Z')
const win = (id: string, usedPercent: number, resetAtMs: number | null, periodMs = 5 * H): QuotaWindow => ({ id, label: id, usedPercent, resetAtMs, periodMs })
const account = { name: 'a.json', auth_index: 'a' }

test('a full 5-hour window does not make a used-up weekly account usable', () => {
  const limit = quotaLimit(account, [win('5-hour', 0, null), win('Weekly', 100, now + 41 * H, 168 * H)], now)
  expect(limit).toEqual({ reason: 'Weekly limit reached', until: now + 41 * H, binding: expect.objectContaining({ id: 'Weekly' }) })
})

test('the window that resets last decides when the account is back', () => {
  const limit = quotaLimit(account, [win('5-hour', 100, now + 2 * H), win('Weekly', 100, now + 30 * H, 168 * H)], now)
  expect(limit?.binding?.id).toBe('Weekly')
  expect(limit?.until).toBe(now + 30 * H)
})

test('a cooldown with headroom left reports the proxy reason and its end', () => {
  const cooled = { ...account, status_message: '{"error":{"type":"rate_limit_error"}}', cooldowns: [{ scope: 'auth', reason: 'quota', retry_at: new Date(now + H).toISOString() }] }
  expect(quotaLimit(cooled, [win('5-hour', 40, now + 2 * H)], now)).toEqual({ reason: 'Usage limit reached', until: now + H, binding: undefined })
})

test('accounts with headroom or turned off are not limited', () => {
  expect(quotaLimit(account, [win('5-hour', 99, now + H)], now)).toBeNull()
  expect(quotaLimit({ ...account, disabled: true }, [win('5-hour', 100, now + H)], now)).toBeNull()
})
