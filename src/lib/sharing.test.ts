import { expect, test } from 'bun:test'
import { sharingChoices } from './sharing'

const now = new Date(2026, 10, 5, 14, 0).getTime()
const HOUR = 3600e3

test('defaults to the pool’s next reset, then offers its weekly reset', () => {
  const choices = sharingChoices(
    [
      { id: 'session', label: '5-hour', usedPercent: 90, resetAtMs: now + 2.5 * HOUR, periodMs: 5 * HOUR },
      { id: 'weekly', label: 'Weekly', usedPercent: 40, resetAtMs: now + 50 * HOUR, periodMs: 168 * HOUR },
      { id: 'session', label: '5-hour', usedPercent: 10, resetAtMs: now + 4 * HOUR, periodMs: 5 * HOUR },
    ],
    now,
  )
  expect(choices.map((c) => [c.id, c.until])).toEqual([
    ['reset', now + 2.5 * HOUR],
    ['weekly', now + 50 * HOUR],
    ['2h', now + 2 * HOUR],
    ['8h', now + 8 * HOUR],
    ['today', new Date(2026, 10, 6).getTime()],
    ['off', null],
  ])
})

test('offers fixed durations when no reset is known', () => {
  expect(sharingChoices([{ id: 'weekly', label: 'Weekly', usedPercent: 0, resetAtMs: null, periodMs: 168 * HOUR }], now)[0].id).toBe('2h')
})
