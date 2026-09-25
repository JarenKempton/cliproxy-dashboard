// Burn-up chart for one weekly window: actual usage (from stored samples) vs.
// an even-pace line, with the current rate projected to reset.

import { useEffect, useRef, useState } from 'react'
import { formatWhen } from '../format'
import type { Sample } from '../history'
import { paceOf } from '../pace'
import type { QuotaWindow } from '../quota'

export type Series = { window: QuotaWindow; samples: Sample[] }

const HEIGHT = 150
const PAD = { top: 12, right: 12, bottom: 22, left: 36 }

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    if (!ref.current) return
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width))
    ro.observe(ref.current)
    return () => ro.disconnect()
  }, [])
  return [ref, width] as const
}

// Points of the actual burn: window start at 0%, stored samples, then now.
function actualPoints(s: Series, startMs: number, now: number): Sample[] {
  const inWindow = s.samples.filter(([t]) => t > startMs && t < now).sort((a, b) => a[0] - b[0])
  return [[startMs, 0], ...inWindow, [now, s.window.usedPercent]]
}

function valueAt(points: Sample[], t: number): number | null {
  for (let i = 1; i < points.length; i++) {
    const [t0, v0] = points[i - 1]
    const [t1, v1] = points[i]
    if (t >= t0 && t <= t1) return t1 === t0 ? v1 : v0 + ((v1 - v0) * (t - t0)) / (t1 - t0)
  }
  return null
}

function dayBoundaries(startMs: number, endMs: number): number[] {
  const d = new Date(startMs)
  d.setHours(24, 0, 0, 0)
  const out: number[] = []
  for (let t = d.getTime(); t < endMs; t += 86400e3) out.push(t)
  return out
}

export function BurnChart({ series, now }: { series: Series[]; now: number }) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const [hoverT, setHoverT] = useState<number | null>(null)

  const { resetAtMs, periodMs } = series[0].window
  if (resetAtMs === null) return null
  const startMs = resetAtMs - periodMs
  const plotW = Math.max(width - PAD.left - PAD.right, 0)
  const plotH = HEIGHT - PAD.top - PAD.bottom
  const x = (t: number) => PAD.left + ((t - startMs) / periodMs) * plotW
  const y = (p: number) => PAD.top + (1 - Math.min(p, 100) / 100) * plotH
  const path = (pts: Sample[]) => pts.map(([t, v], i) => `${i ? 'L' : 'M'}${x(t).toFixed(1)},${y(v).toFixed(1)}`).join('')

  const lines = series.map((s, i) => {
    const pace = paceOf(s.window, now)
    const actual = actualPoints(s, startMs, now)
    const endT = pace.runsOutAtMs ?? resetAtMs
    const endV = pace.runsOutAtMs ? 100 : (pace.projectedPercent ?? s.window.usedPercent)
    const projection: Sample[] = s.window.usedPercent >= 100 ? [] : [[now, s.window.usedPercent], [endT, endV]]
    return { s, i, pace, actual, projection }
  })

  const days = dayBoundaries(startMs, resetAtMs)
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const t = startMs + ((e.clientX - rect.left - PAD.left) / plotW) * periodMs
    setHoverT(t >= startMs && t <= resetAtMs ? t : null)
  }

  return (
    <figure className="burn">
      <figcaption className="legend">
          {series.map((s, i) => (
            <span key={s.window.id} className="legend-item">
              <span className={`legend-key series-${i + 1}`} />
              {s.window.label}
            </span>
          ))}
          <span className="legend-item">
            <span className="legend-key pace" />
            Even pace
          </span>
      </figcaption>
      <div ref={ref} className="burn-plot">
        {width > 0 && (
          <svg width={width} height={HEIGHT} onPointerMove={onMove} onPointerLeave={() => setHoverT(null)} role="img"
            aria-label={`Usage this week: ${series.map((s) => `${s.window.label} ${Math.round(s.window.usedPercent)}%`).join(', ')}`}>
            {[0, 50, 100].map((p) => (
              <g key={p}>
                <line className="grid" x1={PAD.left} x2={PAD.left + plotW} y1={y(p)} y2={y(p)} />
                <text className="tick" x={PAD.left - 6} y={y(p)} dy="0.32em" textAnchor="end">{p}%</text>
              </g>
            ))}
            {days.map((t) => (
              <line key={t} className="grid" x1={x(t)} x2={x(t)} y1={PAD.top} y2={PAD.top + plotH} />
            ))}
            {[startMs, ...days].map((t, i, all) => {
              const next = all[i + 1] ?? resetAtMs
              if (x(next) - x(t) < 28) return null
              return (
                <text key={t} className="tick" x={(x(t) + x(next)) / 2} y={HEIGHT - 6} textAnchor="middle">
                  {new Date(t + 3600e3).toLocaleDateString([], { weekday: 'short' })}
                </text>
              )
            })}
            <line className="pace-line" x1={x(startMs)} y1={y(0)} x2={x(resetAtMs)} y2={y(100)} />
            <line className="now-line" x1={x(now)} x2={x(now)} y1={PAD.top} y2={PAD.top + plotH} />
            {lines.map(({ s, i, actual, projection }) => (
              <g key={s.window.id} className={`series-${i + 1}`}>
                {series.length === 1 && <path className="area" d={`${path(actual)}L${x(now)},${y(0)}Z`} />}
                <path className="line" d={path(actual)} />
                {projection.length > 0 && <path className="line projection" d={path(projection)} />}
              </g>
            ))}
            {lines.map(({ s, i, pace }) =>
              pace.runsOutAtMs ? (
                <g key={`out-${s.window.id}`} className={`series-${i + 1}`}>
                  <circle className="dot" cx={x(pace.runsOutAtMs)} cy={y(100)} r={4} />
                </g>
              ) : null,
            )}
            {lines.map(({ s, i }) => (
              <g key={`now-${s.window.id}`} className={`series-${i + 1}`}>
                <circle className="dot" cx={x(now)} cy={y(s.window.usedPercent)} r={4} />
              </g>
            ))}
            {hoverT !== null && <line className="crosshair" x1={x(hoverT)} x2={x(hoverT)} y1={PAD.top} y2={PAD.top + plotH} />}
          </svg>
        )}
        {hoverT !== null && (
          <div className="tooltip" style={{ left: Math.min(x(hoverT) + 10, width - 170) }}>
            <div className="tooltip-title">{formatWhen(hoverT, now)}</div>
            {lines.map(({ s, i, actual, projection }) => {
              const v = hoverT <= now ? valueAt(actual, hoverT) : valueAt(projection, hoverT)
              return (
                <div key={s.window.id} className="tooltip-row">
                  <span className={`tooltip-key series-${i + 1}`} />
                  <strong>{v === null ? (hoverT > now ? '100%' : '—') : `${Math.round(v)}%`}</strong>
                  <span>{s.window.label}{hoverT > now ? ' (projected)' : ''}</span>
                </div>
              )
            })}
            <div className="tooltip-row">
              <span className="tooltip-key pace" />
              <strong>{Math.round(((hoverT - startMs) / periodMs) * 100)}%</strong>
              <span>Even pace</span>
            </div>
          </div>
        )}
      </div>
    </figure>
  )
}
