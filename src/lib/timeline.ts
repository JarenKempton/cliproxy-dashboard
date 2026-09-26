// Quota windows timeline: which window each account's lane shows, and where
// its window occurrences fall on the visible span.
//
// Ported from Cli-Proxy-API-Management-Center (MIT, (c) 2026 Router-For.ME),
// src/features/quota/quotaTimelineModel.ts, trimmed to Claude and Codex.

import type { QuotaWindow } from './quota'

export const HOUR_MS = 3600e3
export const DAY_MS = 24 * HOUR_MS

export type TimelineMode = 'weekly' | 'session'

export const SPAN_DAYS: Record<TimelineMode, number> = { weekly: 14, session: 3 }
const SESSION_PERIOD_MS = 5 * HOUR_MS

export type TimelineBar = {
  startMs: number
  endMs: number
  left: number // percent of span, clipped
  width: number
  state: 'past' | 'live' | 'next'
  // Percent used, only for the API-reported current window.
  used: number | null
}

// Every window boundary of `periodMs` aligned to the known reset `anchorMs`,
// covering [fromMs, toMs], projected both backwards and forwards.
export function windowsIn(anchorMs: number, periodMs: number, fromMs: number, toMs: number) {
  if (!Number.isFinite(anchorMs) || !(periodMs > 0) || !(toMs > fromMs)) return []
  if (Math.ceil((toMs - fromMs) / periodMs) + 2 > 1000) return []
  let end = anchorMs + Math.ceil((fromMs - anchorMs) / periodMs) * periodMs
  const out: { startMs: number; endMs: number }[] = []
  while (end - periodMs < toMs) {
    out.push({ startMs: end - periodMs, endMs: end })
    end += periodMs
  }
  return out
}

export function startOfDay(ms: number) {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

// Weekly steps a week at a time from the containing Sunday; session a day at a
// time from today. Date arithmetic keeps DST transitions from shifting days.
// `compact` (phones) shows one week instead of two.
export function timelineSpan(mode: TimelineMode, offset: number, now: number, compact = false) {
  const days = compact && mode === 'weekly' ? 7 : SPAN_DAYS[mode]
  const base = new Date(startOfDay(now))
  if (mode === 'weekly') base.setDate(base.getDate() - base.getDay())
  base.setDate(base.getDate() + offset * (mode === 'weekly' ? 7 : 1))
  const startMs = base.getTime()
  const end = new Date(startMs)
  end.setDate(end.getDate() + days)
  return { startMs, endMs: end.getTime(), days }
}

// The window a lane is drawn from: the longest period that fits the view, and
// among those the most used one, since that's the limit that runs out first.
// (The upstream panel breaks ties by soonest reset, which can surface an idle
// model-scoped window over the account-wide one that's actually binding.)
export function pickLaneWindow(windows: QuotaWindow[], mode: TimelineMode): QuotaWindow | null {
  const usable = windows.filter((w) => w.resetAtMs !== null)
  if (mode === 'session') return usable.find((w) => w.periodMs === SESSION_PERIOD_MS) ?? null
  const maxPeriod = SPAN_DAYS.weekly * DAY_MS
  const fitting = usable.filter((w) => w.periodMs <= maxPeriod)
  const pool = fitting.length ? fitting : usable
  if (!pool.length) return null
  return pool.reduce((best, w) => {
    if (w.periodMs !== best.periodMs) return w.periodMs > best.periodMs ? w : best
    if (w.usedPercent !== best.usedPercent) return w.usedPercent > best.usedPercent ? w : best
    return w.resetAtMs! < best.resetAtMs! ? w : best
  })
}

export function projectLane(w: QuotaWindow, spanStartMs: number, spanEndMs: number, now: number): TimelineBar[] {
  const span = spanEndMs - spanStartMs
  if (w.resetAtMs === null || span <= 0) return []
  const pct = (ms: number) => ((ms - spanStartMs) / span) * 100
  return windowsIn(w.resetAtMs, w.periodMs, spanStartMs, spanEndMs).flatMap((win): TimelineBar[] => {
    const left = Math.max(0, pct(win.startMs))
    const right = Math.min(100, pct(win.endMs))
    if (right <= 0 || left >= 100 || right <= left) return []
    const state = win.endMs <= now ? 'past' : win.startMs <= now ? 'live' : 'next'
    return [
      {
        ...win,
        left,
        width: right - left,
        state,
        // The reported usage belongs only to the window ending at the anchor.
        used: state === 'live' && win.endMs === w.resetAtMs ? w.usedPercent : null,
      },
    ]
  })
}
