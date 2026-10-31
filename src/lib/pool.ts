// A provider's accounts as one quota pool (100% = every account full).
// History is rebuilt from proxy cost, calibrated so each account lands on its
// live reading; the projection runs your usual pace forward. The sustainable
// pace spends exactly one refill of every account per window, so it does not
// depend on how much of the calendar is on screen. Paces are per workday:
// weekends count as light days. Requests drain the account that resets soonest
// first.

import type { QuotaWindow } from './quota'

const HOUR = 3600e3
const HISTORY_MS = 14 * 86400e3
const WEEKEND = 0.1
const OFF_HOURS = 0.15
const WORKDAY = 14 + 10 * OFF_HOURS
const MIN_USED_TO_CALIBRATE = 5

export type PoolAccount = { cost: Map<number, number>; window: QuotaWindow & { resetAtMs: number } }
export type PoolPoint = { t: number; pool: number }

export type Pool = {
  left: number
  past: PoolPoint[]
  projected: PoolPoint[]
  safe: PoolPoint[]
  resets: number[]
  usualPerDay: number
  sustainablePerDay: number
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
  return t >= current ? current : current - Math.ceil((current - t) / w.periodMs) * w.periodMs
}

function resetsBetween(w: PoolAccount['window'], from: number, to: number) {
  const out: number[] = []
  for (let r = windowStart(w, from) + w.periodMs; r < to; r += w.periodMs) out.push(r)
  return out
}

type Slot = { left: number; resets: number[] }

function simulate(slots: Slot[], from: number, to: number, perDay: number) {
  const s = slots.map((x) => ({ left: x.left, resets: [...x.resets] }))
  const level = () => s.reduce((sum, x) => sum + x.left, 0) / s.length
  const points: PoolPoint[] = [{ t: from, pool: level() }]
  for (let t = from; t < to; t += HOUR) {
    for (const x of s) {
      while (x.resets.length && t >= x.resets[0]) {
        x.left = 100
        x.resets.shift()
      }
    }
    let burn = (perDay * s.length * workWeight(t)) / WORKDAY
    for (const x of [...s].sort((a, b) => (a.resets[0] ?? Infinity) - (b.resets[0] ?? Infinity))) {
      const take = Math.min(burn, x.left)
      x.left -= take
      burn -= take
    }
    points.push({ t: Math.min(t + HOUR, to), pool: level() })
  }
  return points
}

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

  const usedRecently = accounts.reduce((s, a, i) => s + costBetween(a.cost, now - HISTORY_MS, now) / microsPerPercent[i], 0)
  const usualPerDay = usedRecently / accounts.length / workdaysIn(now - HISTORY_MS, now)
  const period = Math.max(...accounts.map((a) => a.window.periodMs))
  const sustainablePerDay = 100 / workdaysIn(now, now + period)

  const slotsFrom = (from: number, to: number, level: (i: number) => number) =>
    accounts.map((a, i) => ({ left: level(i), resets: resetsBetween(a.window, from, to) }))
  const liveLevel = (i: number) => Math.max(0, 100 - accounts[i].window.usedPercent)
  const ahead = simulate(slotsFrom(now, now + period, liveLevel), now, now + period, usualPerDay)
  const dry = ahead.find((p) => p.pool < 0.5)
  const safePast = simulate(slotsFrom(spanStart, now, (i) => levelAt(i, spanStart)), spanStart, now, sustainablePerDay)

  return {
    left,
    past,
    projected: simulate(slotsFrom(now, spanEnd, liveLevel), now, spanEnd, usualPerDay),
    safe: [...safePast.slice(0, -1), ...simulate(slotsFrom(now, spanEnd, liveLevel), now, spanEnd, sustainablePerDay)],
    resets: [...new Set(accounts.flatMap((a) => resetsBetween(a.window, spanStart, spanEnd)))].sort((a, b) => a - b),
    usualPerDay,
    sustainablePerDay,
    runsOutAt: dry ? dry.t : null,
  }
}
