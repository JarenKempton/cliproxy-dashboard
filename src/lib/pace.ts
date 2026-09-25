// Whether a window's usage is on pace to last until it resets.

import type { QuotaWindow } from './quota'

export type Pace =
  | { kind: 'idle' } // window hasn't started
  | { kind: 'maxed' }
  | { kind: 'early' } // too early in the window to extrapolate
  | { kind: 'ok'; projected: number } // percent used at reset if the rate holds
  | { kind: 'short'; runsOutAtMs: number }

const MIN_ELAPSED_FRACTION = 0.05

export function paceOf(w: QuotaWindow, now = Date.now()): Pace {
  if (w.usedPercent >= 100) return { kind: 'maxed' }
  if (w.resetAtMs === null) return { kind: 'idle' }
  const startMs = w.resetAtMs - w.periodMs
  const elapsed = Math.min(Math.max(now - startMs, 0), w.periodMs)
  if (elapsed / w.periodMs < MIN_ELAPSED_FRACTION || w.usedPercent <= 0) return { kind: 'early' }
  const projected = (w.usedPercent * w.periodMs) / elapsed
  if (projected <= 100) return { kind: 'ok', projected }
  return { kind: 'short', runsOutAtMs: startMs + (elapsed * 100) / w.usedPercent }
}
