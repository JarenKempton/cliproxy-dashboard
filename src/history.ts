// Usage samples per quota window, kept in localStorage so the weekly chart can
// draw the real burn curve instead of a straight line from the window start.

import type { QuotaWindow } from './quota'

export type Sample = [timeMs: number, usedPercent: number]

const PREFIX = 'cpa:hist:'
const MAX_SAMPLES = 400
const MIN_GAP_MS = 5 * 60e3

// Reset times jitter by a few ms between responses; bucket to the minute.
const keyOf = (authIndex: string, w: QuotaWindow) =>
  `${PREFIX}${authIndex}:${w.id}:${Math.round((w.resetAtMs ?? 0) / 60e3)}`

export function readSamples(authIndex: string, w: QuotaWindow): Sample[] {
  if (w.resetAtMs === null) return []
  try {
    return JSON.parse(localStorage.getItem(keyOf(authIndex, w)) ?? '[]')
  } catch {
    return []
  }
}

export function recordSample(authIndex: string, w: QuotaWindow, now = Date.now()) {
  if (w.resetAtMs === null) return
  const samples = readSamples(authIndex, w)
  const last = samples[samples.length - 1]
  if (last && last[1] === w.usedPercent && now - last[0] < MIN_GAP_MS) return
  samples.push([now, w.usedPercent])
  localStorage.setItem(keyOf(authIndex, w), JSON.stringify(samples.slice(-MAX_SAMPLES)))
}

// Drop history for windows that reset more than a day ago.
export function pruneSamples(now = Date.now()) {
  for (const key of Object.keys(localStorage)) {
    if (!key.startsWith(PREFIX)) continue
    const resetMinute = Number(key.split(':').pop())
    if (resetMinute * 60e3 < now - 86400e3) localStorage.removeItem(key)
  }
}
