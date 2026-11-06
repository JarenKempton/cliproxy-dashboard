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

  test('plan fills each account at its reset and empties it by the next', () => {
    const pool = poolOf([drained, half], spanStart, spanEnd, now)!
    const at = (t: number) => pool.plan.find((p) => p.t >= t)!.pool
    const reset = Date.UTC(2026, 9, 31, 16)
    expect(at(reset - 2 * HOUR)).toBeLessThan(at(reset) - 45)
    expect(pool.planNow).toBeGreaterThan(35)
    expect(pool.planNow).toBeLessThan(50)
  })

  test('says when the pool is below plan and when it gets back', () => {
    const pool = poolOf([drained, half], spanStart, spanEnd, now)!
    expect(pool.left).toBeLessThan(pool.planNow)
    expect(pool.belowPlan!.from).toBe(now)
    expect(pool.belowPlan!.until).toBeGreaterThan(now)
    const light = (used: number, reset: number) => account(used, reset, [[Date.UTC(2026, 9, 29, 14), 10]])
    expect(poolOf([light(5, Date.UTC(2026, 10, 5, 3)), light(5, Date.UTC(2026, 10, 3, 3))], spanStart, spanEnd, now)!.belowPlan).toBeNull()
  })

  test('safe pace is the fastest that never runs the pool dry before a window passes', () => {
    const heavy = (used: number) => account(used, Date.UTC(2026, 10, 5, 3), [[Date.UTC(2026, 9, 29, 14), 4000], [Date.UTC(2026, 9, 30, 14), 4000]])
    const pool = poolOf([heavy(80), heavy(80)], spanStart, spanEnd, now)!
    expect(pool.safePerDay).toBeGreaterThan(0)
    expect(pool.safePerDay).toBeLessThan(pool.usualPerDay)
    expect(poolOf([heavy(100), heavy(100)], spanStart, spanEnd, now)!.safePerDay).toBe(0)
  })

  test('a projected reset lands on the hour it happens, as the plan does', () => {
    const light = (reset: number) => account(5, reset, [[Date.UTC(2026, 9, 29, 14), 10]])
    const pool = poolOf([light(now + 3 * HOUR), light(Date.UTC(2026, 10, 3, 3))], spanStart, spanEnd, now)!
    expect(pool.projected.find((p) => p.t === now + 3 * HOUR)!.pool).toBeGreaterThan(97)
  })

  test('an empty pool is not back on plan until it has quota again', () => {
    const heavy = account(98, Date.UTC(2026, 10, 2, 8), [[Date.UTC(2026, 9, 29, 14), 4000], [Date.UTC(2026, 9, 30, 14), 4000]])
    const pool = poolOf([heavy], spanStart, spanEnd, now)!
    expect(pool.belowPlan!.until).toBeGreaterThanOrEqual(Date.UTC(2026, 10, 2, 8))
  })

  test('a single account is a pool of one', () => {
    const pool = poolOf([half], spanStart, spanEnd, now)!
    expect(pool.left).toBe(50)
    expect(pool.plan.find((p) => p.t >= Date.UTC(2026, 10, 5, 3))!.pool).toBeGreaterThan(99)
  })

  test('weekends weigh far less than workdays', () => {
    expect(workWeight(Date.UTC(2026, 9, 31, 14))).toBeLessThan(workWeight(Date.UTC(2026, 9, 26, 14)) / 5)
  })
})

describe('a pool a peer lends', () => {
  const own = account(50, Date.UTC(2026, 10, 5, 3), [[Date.UTC(2026, 9, 29, 14), 250], [Date.UTC(2026, 9, 30, 14), 250]])
  const lent = (lentUntil: number | null, spend: [number, number][] = []): PoolAccount => ({ ...account(0, Date.UTC(2026, 10, 2, 3), spend), lentUntil })
  const sixHours = now + 6 * HOUR

  test('adds its capacity until sharing ends, then leaves the pool', () => {
    const pool = poolOf([own, lent(sixHours)], spanStart, spanEnd, now)!
    expect(pool.left).toBe(75)
    const alone = poolOf([own], spanStart, spanEnd, now)!
    for (const t of [sixHours, sixHours + 30 * HOUR]) {
      expect(pool.projected.find((p) => p.t >= t)!.pool).toBeCloseTo(alone.projected.find((p) => p.t >= t)!.pool, 6)
    }
    expect(pool.resets).not.toContain(Date.UTC(2026, 10, 2, 3))
  })

  test('is drawn on only after your own accounts, even when it resets sooner', () => {
    const busy = account(50, Date.UTC(2026, 10, 5, 3), [[Date.UTC(2026, 9, 20, 14), 200000], [Date.UTC(2026, 9, 29, 14), 25000], [Date.UTC(2026, 9, 30, 14), 25000]])
    const pool = poolOf([busy, lent(sixHours)], spanStart, spanEnd, now)!
    const at = (t: number) => pool.projected.find((p) => p.t >= t)!.pool
    const ownLeft = at(sixHours)
    expect(ownLeft).toBeLessThan(48)
    expect(at(sixHours - HOUR)).toBeCloseTo((ownLeft + 100) / 2, 0)
  })

  test('keeps your usual pace from your own spending, not the lender’s', () => {
    const alone = poolOf([own], spanStart, spanEnd, now)!
    const withLent = poolOf([own, lent(null, [[Date.UTC(2026, 9, 30, 14), 90000]])], spanStart, spanEnd, now)!
    expect(withLent.usualPerDay * 2).toBeCloseTo(alone.usualPerDay, 6)
  })
})

describe('sharing spend on the burndown', () => {
  const window = Date.UTC(2026, 10, 5, 3)
  const spend: [number, number][] = [[Date.UTC(2026, 9, 29, 14), 250], [Date.UTC(2026, 9, 30, 14), 250]]

  test('shows where the pool would have been without what a peer used', () => {
    const lent = { ...account(50, window, spend), peerCost: new Map([[Date.UTC(2026, 9, 30, 14), 250]]) }
    const pool = poolOf([lent], spanStart, spanEnd, now)!
    expect(pool.pastWithoutPeers!.at(-1)).toEqual({ t: now, pool: 75 })
    const before = (p: { t: number }) => p.t === Date.UTC(2026, 9, 30, 12)
    expect(pool.pastWithoutPeers!.find(before)!.pool).toBe(pool.past.find(before)!.pool)
  })

  test('has nothing to show without sharing spend', () => {
    expect(poolOf([account(50, window, spend)], spanStart, spanEnd, now)!.pastWithoutPeers).toBeNull()
  })
})

