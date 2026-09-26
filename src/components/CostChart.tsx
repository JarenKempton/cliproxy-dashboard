// Dot-matrix column chart of cost per time bucket, with a hover readout.

import { useEffect, useRef, useState } from 'react'
import { formatUsd, type Overview } from '../lib/usage'

const HEIGHT = 180
const PAD = { top: 8, right: 0, bottom: 22, left: 48 }
const GAP = 3

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

// Every bucket from the range start to now, including empty ones, aligned to
// local time the same way the server buckets them.
function buckets(overview: Overview, now: number) {
  const offset = -new Date().getTimezoneOffset() * 60e3
  const align = (ms: number) => Math.floor((ms + offset) / overview.bucketMs) * overview.bucketMs - offset
  const byAt = new Map(overview.series.map((s) => [s.at, s]))
  const out: { at: number; costMicros: number; requests: number }[] = []
  for (let at = align(overview.from); at <= now; at += overview.bucketMs) {
    out.push(byAt.get(at) ?? { at, costMicros: 0, requests: 0 })
  }
  return out
}

// A "nice" axis maximum: 1, 2 or 5 times a power of ten.
function niceMax(value: number) {
  if (value <= 0) return 1
  const magnitude = 10 ** Math.floor(Math.log10(value))
  return [1, 2, 5, 10].map((m) => m * magnitude).find((m) => m >= value)!
}

const hourFmt = new Intl.DateTimeFormat([], { hour: 'numeric' })
const dayFmt = new Intl.DateTimeFormat([], { month: 'short', day: 'numeric' })
const fullFmt = new Intl.DateTimeFormat([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

export function CostChart({ overview, now }: { overview: Overview; now: number }) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)
  const data = buckets(overview, now)
  const hourly = overview.bucketMs < 86400e3
  const max = niceMax(Math.max(...data.map((d) => d.costMicros)))

  const plotW = Math.max(width - PAD.left - PAD.right, 0)
  const plotH = HEIGHT - PAD.top - PAD.bottom
  const barW = data.length ? (plotW - GAP * (data.length - 1)) / data.length : 0
  const x = (i: number) => PAD.left + i * (barW + GAP)
  const y = (micros: number) => PAD.top + plotH - (micros / max) * plotH
  const labelEvery = Math.ceil(data.length / Math.max(1, Math.floor(plotW / 64)))
  const hovered = hover === null ? null : data[hover]

  return (
    <div className="costchart" ref={ref}>
      {width > 0 && (
        <svg width={width} height={HEIGHT} onPointerLeave={() => setHover(null)} role="img" aria-label="Cost over time">
          <defs>
            <pattern id="cost-dots" width="3" height="3" patternUnits="userSpaceOnUse">
              <circle cx="1.5" cy="1.5" r="0.45" className="dotfill-ok" />
            </pattern>
          </defs>
          {[0, 0.5, 1].map((f) => (
            <g key={f}>
              <line className="grid" x1={PAD.left} x2={width} y1={y(max * f)} y2={y(max * f)} />
              <text className="tick" x={PAD.left - 8} y={y(max * f)} dy="0.32em" textAnchor="end">
                {formatUsd(max * f)}
              </text>
            </g>
          ))}
          {data.map((d, i) => {
            const top = y(d.costMicros)
            return (
              <g key={d.at} onPointerEnter={() => setHover(i)}>
                {/* Full-height hit area, wider than the mark. */}
                <rect x={x(i) - GAP / 2} y={PAD.top} width={barW + GAP} height={plotH} fill="transparent" />
                {d.costMicros > 0 && (
                  <>
                    <rect x={x(i)} y={top} width={barW} height={PAD.top + plotH - top} fill="url(#cost-dots)" />
                    <rect x={x(i)} y={top} width={barW} height={1} className={hover === i ? 'cap-hover' : 'cap-ok'} />
                  </>
                )}
                {i % labelEvery === 0 && (
                  <text className="tick" x={x(i) + barW / 2} y={HEIGHT - 6} textAnchor="middle">
                    {(hourly ? hourFmt : dayFmt).format(d.at)}
                  </text>
                )}
              </g>
            )
          })}
        </svg>
      )}
      {hovered && hover !== null && (
        <div className="tooltip" style={{ left: Math.min(x(hover) + barW + 8, width - 180) }}>
          <div className="tooltip-title">{hourly ? fullFmt.format(hovered.at) : dayFmt.format(hovered.at)}</div>
          <div className="tooltip-row">
            <strong>{formatUsd(hovered.costMicros)}</strong>
            <span>{hovered.requests} requests</span>
          </div>
        </div>
      )}
    </div>
  )
}
