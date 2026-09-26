// Cost (or tokens) over time, one overlapping area per tool, as in T3 Code's
// usage view: smooth monotone curves that never overshoot the data, larger
// series painted first, a shared y-scale topped by the largest single value.
// Fills use the dot-matrix pattern; strokes stay solid.

import { useEffect, useRef, useState } from 'react'
import { byToolOrder, formatTokens, formatUsd, toolColor, toolLabel, type UsageSummary } from '../lib/usage'

const HEIGHT = 224
const AXIS_W = 64 // y-axis label column
const PAD_TOP = 8
const PAD_BOTTOM = 8 // room for the "0" label below the baseline

type Metric = 'cost' | 'tokens'
type Point = [x: number, y: number]

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    if (!ref.current) return
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width))
    ro.observe(ref.current)
    return () => ro.disconnect()
  }, [])
  return [ref, width] as const
}

// Step of 1, 2 or 5 × 10ⁿ giving about `ticks` intervals up to `max`.
function niceScale(max: number, ticks: number) {
  if (max <= 0) return { top: ticks, step: 1 }
  const raw = max / ticks
  const magnitude = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 5, 10].map((m) => m * magnitude).find((s) => s >= raw)!
  return { top: Math.ceil(max / step) * step, step }
}

// Monotone cubic interpolation (Fritsch–Carlson) as an SVG path.
function monotonePath(points: Point[]): string {
  const n = points.length
  if (n === 0) return ''
  if (n === 1) return `M${points[0][0]},${points[0][1]}`
  const dx = points.slice(1).map((p, i) => p[0] - points[i][0])
  const slope = points.slice(1).map((p, i) => (p[1] - points[i][1]) / dx[i])
  const tangent = points.map((_, i) => {
    if (i === 0) return slope[0]
    if (i === n - 1) return slope[n - 2]
    // Flat at local extrema, so the curve never overshoots.
    if (slope[i - 1] * slope[i] <= 0) return 0
    return (3 * (dx[i - 1] + dx[i])) / ((2 * dx[i] + dx[i - 1]) / slope[i - 1] + (dx[i] + 2 * dx[i - 1]) / slope[i])
  })
  let d = `M${points[0][0]},${points[0][1]}`
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = points[i]
    const [x1, y1] = points[i + 1]
    const h = dx[i] / 3
    d += `C${x0 + h},${y0 + h * tangent[i]} ${x1 - h},${y1 - h * tangent[i + 1]} ${x1},${y1}`
  }
  return d
}

// Day keys are already local dates ("YYYY-MM-DD"), so format them as-is (UTC);
// hour keys are instants, shown in local time.
const dayKeyFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
const hourFmt = new Intl.DateTimeFormat('en-US', { hour: 'numeric' })
const hourLongFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric' })

export function bucketLabel(key: number | string, long = false) {
  if (typeof key === 'string') return dayKeyFmt.format(new Date(`${key}T00:00:00Z`))
  return (long ? hourLongFmt : hourFmt).format(key)
}

export function UsageChart({ summary, metric }: { summary: UsageSummary; metric: Metric }) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)

  const valueOf = (p?: { costMicros: number; tokens: number }) => (p ? (metric === 'cost' ? p.costMicros : p.tokens) : 0)
  const format = (v: number) => (metric === 'cost' ? formatUsd(v) : formatTokens(v))

  const tools = summary.tools.map((t) => t.tool).sort(byToolOrder)
  const series = tools.map((tool) => ({ tool, values: summary.series.map((b) => valueOf(b.tools[tool])) }))
  const peak = Math.max(0, ...series.flatMap((s) => s.values))
  const { top, step } = niceScale(peak, 4)

  const plotW = Math.max(width - AXIS_W, 0)
  const plotH = HEIGHT - PAD_TOP - PAD_BOTTOM
  const count = summary.series.length
  const x = (i: number) => AXIS_W + (count > 1 ? (i / (count - 1)) * plotW : plotW / 2)
  const y = (v: number) => PAD_TOP + plotH - (v / top) * plotH

  // Larger series first, so smaller ones stay visible on top.
  const painted = [...series].sort((a, b) => b.values.reduce((n, v) => n + v, 0) - a.values.reduce((n, v) => n + v, 0))

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const left = e.clientX - e.currentTarget.getBoundingClientRect().left - AXIS_W
    const i = Math.round((left / plotW) * (count - 1))
    setHover(i >= 0 && i < count ? i : null)
  }

  const labels = count ? [0, Math.floor((count - 1) / 2), count - 1] : []
  const hovered = hover === null ? null : summary.series[hover]

  return (
    <div className="uchart">
      <div className="uchart-plot" ref={ref}>
        {width > 0 && (
          <svg width={width} height={HEIGHT} onPointerMove={onMove} onPointerLeave={() => setHover(null)} role="img" aria-label={`${metric === 'cost' ? 'Cost' : 'Tokens'} over time by tool`}>
            <defs>
              {tools.map((tool) => (
                <pattern key={tool} id={`dots-${tool}`} width="3" height="3" patternUnits="userSpaceOnUse">
                  <circle cx="1.5" cy="1.5" r="0.45" fill={toolColor(tool)} opacity="0.55" />
                </pattern>
              ))}
            </defs>

            {Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step).map((v) => (
              <g key={v}>
                <line className="grid" x1={AXIS_W} x2={width} y1={y(v)} y2={y(v)} />
                <text className="tick" x={AXIS_W - 10} y={y(v)} dy="0.32em" textAnchor="end">
                  {v === 0 ? '0' : format(v)}
                </text>
              </g>
            ))}

            {painted.map(({ tool, values }) => {
              const line = monotonePath(values.map((v, i) => [x(i), y(v)]))
              return (
                <path key={`fill-${tool}`} d={`${line}L${x(count - 1)},${y(0)}L${x(0)},${y(0)}Z`} fill={`url(#dots-${tool})`} />
              )
            })}
            {painted.map(({ tool, values }) => (
              <path
                key={`line-${tool}`}
                d={monotonePath(values.map((v, i) => [x(i), y(v)]))}
                fill="none"
                stroke={toolColor(tool)}
                strokeWidth={1.5}
                strokeLinejoin="round"
              />
            ))}

            {hover !== null && <line className="crosshair" x1={x(hover)} x2={x(hover)} y1={PAD_TOP} y2={y(0)} />}
          </svg>
        )}
        {hovered && hover !== null && (
          <div className="tooltip" style={{ left: Math.min(x(hover) + 12, width - 190) }}>
            <div className="tooltip-title">{bucketLabel(hovered.key, true)}</div>
            {tools.map((tool) => (
              <div key={tool} className="tooltip-row">
                <span className="tooltip-key" style={{ background: toolColor(tool) }} />
                <span>{toolLabel(tool)}</span>
                <strong>{format(valueOf(hovered.tools[tool]))}</strong>
              </div>
            ))}
            <div className="tooltip-row tooltip-total">
              <span>Total</span>
              <strong>{format(tools.reduce((n, t) => n + valueOf(hovered.tools[t]), 0))}</strong>
            </div>
          </div>
        )}
      </div>
      <div className="uchart-x mono">
        {labels.map((i) => (
          <span key={i}>{bucketLabel(summary.series[i].key)}</span>
        ))}
      </div>
    </div>
  )
}
