import { describe, expect, test } from 'bun:test'
import { poolOf, workWeight, type PoolAccount } from './pool'

process.env.TZ = 'UTC'

const HOUR = 3600e3
const WEEK = 168 * HOUR
const now = Date.UTC(2026, 9, 30, 19)
const spanStart = Date.UTC(2026, 9, 25)
const spanEnd = Date.UTC(2026, 10, 8)

function account(usedPercent: number, resetAtMs: number, spend: [number, number][]): PoolAccount {
  return { cost: new Map(spend), window: { id: 'weekly', label: 'Weekly', usedPercent, resetAtMs, periodMs: WEEK } }
}

describe('quota pool', () => {
  const drained = account(100, Date.UTC(2026, 9, 31, 16), [[Date.UTC(2026, 9, 26, 14), 600], [Date.UTC(2026, 9, 27, 14), 400]])
  const half = account(50, Date.UTC(2026, 10, 5, 3), [[Date.UTC(2026, 9, 29, 14), 250], [Date.UTC(2026, 9, 30, 14), 250]])

  test('lands on the live readings and refills the pool at each reset', () => {
    const pool = poolOf([drained, half], spanStart, spanEnd, now)!
    expect(pool.left).toBe(25)
    expect(pool.past.at(-1)).toEqual({ t: now, pool: 25 })
    expect(pool.resets).toEqual([Date.UTC(2026, 9, 29, 3), Date.UTC(2026, 9, 31, 16), Date.UTC(2026, 10, 5, 3), Date.UTC(2026, 10, 7, 16)])
    const afterRefill = pool.projected.find((p) => p.t > Date.UTC(2026, 9, 31, 17))!
    expect(afterRefill.pool).toBeGreaterThan(70)
    expect(pool.usualPerDay).toBeGreaterThan(0)
  })

  test('sustainable pace is one refill per window, whatever span is on screen', () => {
    const week = poolOf([drained, half], spanStart, Date.UTC(2026, 10, 1), now)!
    const twoWeeks = poolOf([drained, half], spanStart, spanEnd, now)!
    expect(week.sustainablePerDay).toBe(twoWeeks.sustainablePerDay)
    expect(week.sustainablePerDay).toBeCloseTo(100 / 5.2, 0)
  })

  test('says when the usual pace runs the pool dry', () => {
    const heavy = (used: number) => account(used, Date.UTC(2026, 10, 5, 3), [[Date.UTC(2026, 9, 29, 14), 4000], [Date.UTC(2026, 9, 30, 14), 4000]])
    const pool = poolOf([heavy(80), heavy(80)], spanStart, spanEnd, now)!
    expect(pool.runsOutAt).toBeGreaterThan(now)
    expect(pool.runsOutAt).toBeLessThan(Date.UTC(2026, 10, 5, 3))
    expect(poolOf([drained, half], spanStart, spanEnd, now)!.runsOutAt).toBeNull()
  })

  test('rebuilds history from cost: the drained account was full before its spend', () => {
    const pool = poolOf([drained, half], spanStart, spanEnd, now)!
    const sunday = pool.past.find((p) => p.t === Date.UTC(2026, 9, 25, 12))!
    const thursday = pool.past.find((p) => p.t === Date.UTC(2026, 9, 29, 12))!
    expect(sunday.pool).toBe(100)
    expect(thursday.pool).toBe(50)
  })

  test('needs a reading with real usage to calibrate', () => {
    expect(poolOf([account(0, Date.UTC(2026, 10, 5, 3), [])], spanStart, spanEnd, now)).toBeNull()
    expect(poolOf([drained, half], spanStart, spanEnd, spanEnd)).toBeNull()
  })

  test('weekends weigh far less than workdays', () => {
    expect(workWeight(Date.UTC(2026, 9, 31, 14))).toBeLessThan(workWeight(Date.UTC(2026, 9, 26, 14)) / 5)
  })
})
