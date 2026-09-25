// Pace math for a quota window: where an even burn would be right now, and
// where the current rate lands by reset.

import type { QuotaWindow } from './quota'

export type PaceState = 'idle' | 'ok' | 'over' | 'maxed'

export type Pace = {
  state: PaceState
  startMs: number | null
  pacePercent: number | null // even-burn usage at this moment
  projectedPercent: number | null // usage at reset if the average rate holds
  runsOutAtMs: number | null // when usage hits 100% at the average rate, if before reset
}

// Too early in a window to extrapolate meaningfully.
const MIN_ELAPSED_FRACTION = 0.03

export function paceOf(w: QuotaWindow, now = Date.now()): Pace {
  if (w.resetAtMs === null) {
    return { state: w.usedPercent >= 100 ? 'maxed' : 'idle', startMs: null, pacePercent: null, projectedPercent: null, runsOutAtMs: null }
  }
  const startMs = w.resetAtMs - w.periodMs
  const elapsed = Math.min(Math.max(now - startMs, 0), w.periodMs)
  const fraction = elapsed / w.periodMs
  const pacePercent = fraction * 100
  if (w.usedPercent >= 100) return { state: 'maxed', startMs, pacePercent, projectedPercent: 100, runsOutAtMs: null }
  if (fraction < MIN_ELAPSED_FRACTION || w.usedPercent <= 0) {
    return { state: 'ok', startMs, pacePercent, projectedPercent: null, runsOutAtMs: null }
  }
  const projectedPercent = w.usedPercent / fraction
  const runsOutAtMs = projectedPercent > 100 ? startMs + (elapsed * 100) / w.usedPercent : null
  return { state: projectedPercent > 100 ? 'over' : 'ok', startMs, pacePercent, projectedPercent, runsOutAtMs }
}
