// A provider's accounts as one quota pool (100% = every account full).
// History is rebuilt from proxy cost, calibrated so each account lands on its
// live reading; the projection runs your usual pace forward. The plan is where
// the pool should stand at each hour if every account spent its window evenly
// across work time, so it jumps up at each reset and reaches 0 only as an
// account resets. The safe pace is the most you can spend per workday from now
// without running dry before a full window passes. The sustainable pace spends exactly one refill of every
// account per window, so it does not depend on how much of the calendar is on
// screen. Paces are per workday:
// weekends count as light days. Requests drain the account that resets soonest
// first. Accounts a peer lends are used only after your own and leave the
// pool when the peer stops sharing; the usual pace comes from your own.

import type { QuotaWindow } from './quota'

const HOUR = 3600e3
const HISTORY_MS = 14 * 86400e3
const WEEKEND = 0.1
const OFF_HOURS = 0.15
const WORKDAY = 14 + 10 * OFF_HOURS
const MIN_USED_TO_CALIBRATE = 5
export const PLAN_SLACK = 1

// lentUntil: unset for your own accounts; for a peer's, when sharing ends (null: until they stop it).
// peerCost: the part of cost from sharing, i.e. what a peer borrowed from your
// account, or what you used of a peer's.
export type PoolAccount = {
  cost: Map<number, number>
  window: QuotaWindow & { resetAtMs: number }
  lentUntil?: number | null
  peerCost?: Map<number, number>
}
export type PoolPoint = { t: number; pool: number }
export type PeerDrop = { from: number; to: number; points: number }

export type Pool = {
  left: number
  past: PoolPoint[]
  // Stretches of the past where sharing spend drew the pool down, and by how
  // many points of the pool.
  peerDrops: PeerDrop[]
  projected: PoolPoint[]
  plan: PoolPoint[]
  planNow: number
  belowPlan: { from: number; until: number | null } | null
  resets: number[]
  usualPerDay: number
  sustainablePerDay: number
  safePerDay: number
  runsOutAt: number | null
}

export function workWeight(t: number) {
  const d = new Date(t)
  const hours = d.getHours() >= 8 && d.getHours() < 22 ? 1 : OFF_HOURS
  return d.getDay() === 0 || d.getDay() === 6 ? hours * WEEKEND : hours
}

const floorHour = (t: number) => Math.floor(t / HOUR) * HOUR

function costBetween(cost: Map<number, number>, from: number, to: number) {
  let sum = 0
  for (const [hour, micros] of cost) if (hour + HOUR > from && hour < to) sum += micros
  return sum
}

const windowStart = (w: PoolAccount['window'], t: number) => {
  const current = w.resetAtMs - w.periodMs
  return current + Math.floor((t - current) / w.periodMs) * w.periodMs
}

function resetsBetween(w: PoolAccount['window'], from: number, to: number) {
  const out: number[] = []
  for (let r = windowStart(w, from) + w.periodMs; r < to; r += w.periodMs) out.push(r)
  return out
}

type Slot = { left: number; resets: number[]; lent: boolean; until: number }

function simulate(slots: Slot[], from: number, to: number, perDay: number) {
  const s = slots.map((x) => ({ ...x, resets: [...x.resets] }))
  const order = (a: Slot, b: Slot) => Number(a.lent) - Number(b.lent) || (a.resets[0] ?? Infinity) - (b.resets[0] ?? Infinity)
  const level = (t: number) => {
    const live = s.filter((x) => t < x.until)
    return live.length ? live.reduce((sum, x) => sum + x.left, 0) / live.length : 0
  }
  const points: PoolPoint[] = [{ t: from, pool: level(from) }]
  for (let t = from; t < to; t += HOUR) {
    let burn = (perDay * s.length * workWeight(t)) / WORKDAY
    for (const x of [...s].sort(order)) {
      const take = Math.min(burn, x.left)
      x.left -= take
      burn -= take
    }
    const end = Math.min(t + HOUR, to)
    for (const x of s) {
      while (x.resets.length && end >= x.resets[0]) {
        x.left = 100
        x.resets.shift()
      }
      if (end >= x.until) {
        x.left = 0
        x.resets = []
      }
    }
    points.push({ t: end, pool: level(end) })
  }
  return points
}

const runsDry = (points: PoolPoint[]) => points.find((p) => p.pool < 0.5)

function workdaysIn(from: number, to: number) {
  let hours = 0
  for (let t = floorHour(from); t < to; t += HOUR) hours += workWeight(t)
  return hours / WORKDAY
}

export function poolOf(accounts: PoolAccount[], spanStart: number, spanEnd: number, now: number): Pool | null {
  if (!accounts.length || now < spanStart || now >= spanEnd) return null
  const spent = accounts.map((a) => costBetween(a.cost, a.window.resetAtMs - a.window.periodMs, now))
  const calibrated = accounts.map((a, i) => (a.window.usedPercent >= MIN_USED_TO_CALIBRATE && spent[i] > 0 ? i : -1)).filter((i) => i >= 0)
  if (!calibrated.length) return null
  const shared = calibrated.reduce((s, i) => s + spent[i], 0) / calibrated.reduce((s, i) => s + accounts[i].window.usedPercent, 0)
  const microsPerPercent = accounts.map((a, i) => (calibrated.includes(i) ? spent[i] / a.window.usedPercent : shared))

  const peerUse = (i: number, from: number, to: number) => {
    const peer = accounts[i].peerCost
    return peer ? costBetween(peer, from, to) / microsPerPercent[i] : 0
  }
  const levelAt = (i: number, t: number) => {
    const a = accounts[i]
    const used = costBetween(a.cost, windowStart(a.window, t), t) / microsPerPercent[i]
    return Math.min(100, Math.max(0, 100 - used))
  }
  const poolAt = (t: number) => accounts.reduce((s, _, i) => s + levelAt(i, t), 0) / accounts.length

  const past: PoolPoint[] = []
  for (let t = floorHour(spanStart); t < now; t += HOUR) past.push({ t, pool: poolAt(t) })
  const left = accounts.reduce((s, a) => s + Math.max(0, 100 - a.window.usedPercent), 0) / accounts.length
  past.push({ t: now, pool: left })
  const peerDrops: PeerDrop[] = []
  for (let t = floorHour(spanStart); t < now; t += HOUR) {
    const points = accounts.reduce((s, _, i) => s + peerUse(i, t, Math.min(t + HOUR, now)), 0) / accounts.length
    if (points <= 0) continue
    const last = peerDrops.at(-1)
    if (last && last.to === t) Object.assign(last, { to: Math.min(t + HOUR, now), points: last.points + points })
    else peerDrops.push({ from: t, to: Math.min(t + HOUR, now), points })
  }

  const lentUntil = (a: PoolAccount) => (a.lentUntil === undefined || a.lentUntil === null ? Infinity : a.lentUntil)
  const usedRecently = accounts.reduce(
    (s, a, i) => (a.lentUntil === undefined ? s + costBetween(a.cost, now - HISTORY_MS, now) / microsPerPercent[i] : s),
    0,
  )
  const usualPerDay = usedRecently / accounts.length / workdaysIn(now - HISTORY_MS, now)
  const period = Math.max(...accounts.map((a) => a.window.periodMs))
  const sustainablePerDay = 100 / workdaysIn(now, now + period)

  const slotsFrom = (from: number, to: number, level: (i: number) => number) =>
    accounts.map((a, i) => ({
      left: level(i),
      resets: resetsBetween(a.window, from, to).filter((r) => r < lentUntil(a)),
      lent: a.lentUntil !== undefined,
      until: lentUntil(a),
    }))
  const liveLevel = (i: number) => Math.max(0, 100 - accounts[i].window.usedPercent)
  const aheadAt = (perDay: number) => simulate(slotsFrom(now, now + period, liveLevel), now, now + period, perDay)
  const dry = runsDry(aheadAt(usualPerDay))
  let [safePerDay, tooMuch] = [0, 100 * accounts.length]
  if (left >= 0.5) for (let i = 0; i < 20; i++) {
    const mid = (safePerDay + tooMuch) / 2
    if (runsDry(aheadAt(mid))) tooMuch = mid
    else safePerDay = mid
  }
  const projected = simulate(slotsFrom(now, spanEnd, liveLevel), now, spanEnd, usualPerDay)

  const windowWorkdays = new Map<number, number>()
  const workdaysOfWindow = (start: number, end: number) => {
    if (!windowWorkdays.has(start)) windowWorkdays.set(start, workdaysIn(start, end))
    return windowWorkdays.get(start)!
  }
  const planAt = (t: number) => {
    const live = accounts.filter((a) => t < lentUntil(a))
    return (
      live.reduce((s, a) => {
        const start = windowStart(a.window, t)
        const end = start + a.window.periodMs
        return s + (100 * workdaysIn(t, end)) / workdaysOfWindow(start, end)
      }, 0) / Math.max(1, live.length)
    )
  }
  const line = [...past, ...projected.slice(1)]
  const plan = line.map((p) => ({ t: p.t, pool: planAt(p.t) }))
  const under = (i: number) => line[i].pool < plan[i].pool - PLAN_SLACK
  const first = line.findIndex((p, i) => p.t >= now && under(i))
  const recovered = first < 0 ? -1 : line.findIndex((p, i) => i > first && !under(i) && p.pool >= 0.5)

  return {
    left,
    past,
    peerDrops,
    projected,
    plan,
    planNow: planAt(now),
    belowPlan: first < 0 ? null : { from: line[first].t, until: recovered < 0 ? null : line[recovered].t },
    resets: [...new Set(accounts.flatMap((a) => resetsBetween(a.window, spanStart, spanEnd).filter((r) => r < lentUntil(a))))].sort((a, b) => a - b),
    usualPerDay,
    sustainablePerDay,
    safePerDay,
    runsOutAt: dry ? dry.t : null,
  }
}
