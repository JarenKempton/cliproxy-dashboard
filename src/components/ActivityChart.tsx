// Dot-matrix column chart of an account's requests in 10-minute buckets
// (the proxy keeps the last 20, about 3 hours).

import { useEffect, useRef, useState } from 'react'

type Bucket = { time: string; success: number; failed: number }

const HEIGHT = 34
const GAP = 2

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

export function ActivityChart({ buckets, id }: { buckets: Bucket[]; id: string }) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const max = Math.max(1, ...buckets.map((b) => b.success + b.failed))
  const total = buckets.reduce((n, b) => n + b.success, 0)
  const failed = buckets.reduce((n, b) => n + b.failed, 0)
  const barW = buckets.length ? (width - GAP * (buckets.length - 1)) / buckets.length : 0
  const y = (v: number) => (v / max) * (HEIGHT - 2)

  return (
    <div className="activity">
      <div className="activity-plot" ref={ref}>
        {width > 0 && (
          <svg width={width} height={HEIGHT} role="img" aria-label={`${total} requests, ${failed} failed, in the last 3 hours`}>
            <defs>
              <pattern id={`ok-${id}`} width="4" height="4" patternUnits="userSpaceOnUse">
                <circle cx="2" cy="2" r="0.9" className="dotfill-ok" />
              </pattern>
              <pattern id={`bad-${id}`} width="4" height="4" patternUnits="userSpaceOnUse">
                <circle cx="2" cy="2" r="0.9" className="dotfill-bad" />
              </pattern>
            </defs>
            <line x1={0} x2={width} y1={HEIGHT - 0.5} y2={HEIGHT - 0.5} className="activity-base" />
            {buckets.map((b, i) => {
              const x = i * (barW + GAP)
              const okH = y(b.success)
              const badH = y(b.failed)
              return (
                <g key={b.time}>
                  <title>{`${b.time.replace('-', '–')} · ${b.success} ok${b.failed ? ` · ${b.failed} failed` : ''}`}</title>
                  {/* Transparent hit area taller than the mark. */}
                  <rect x={x} y={0} width={barW} height={HEIGHT} fill="transparent" />
                  {okH > 0 && (
                    <>
                      <rect x={x} y={HEIGHT - okH} width={barW} height={okH} fill={`url(#ok-${id})`} />
                      <rect x={x} y={HEIGHT - okH} width={barW} height={1.5} className="cap-ok" />
                    </>
                  )}
                  {badH > 0 && (
                    <>
                      <rect x={x} y={HEIGHT - okH - badH} width={barW} height={badH} fill={`url(#bad-${id})`} />
                      <rect x={x} y={HEIGHT - okH - badH} width={barW} height={1.5} className="cap-bad" />
                    </>
                  )}
                </g>
              )
            })}
          </svg>
        )}
      </div>
      <div className="activity-legend mono">
        <span className="activity-total">{total}</span>
        <span className="faint">req · 3h</span>
        {failed > 0 && <span className="activity-failed">{failed} failed</span>}
      </div>
    </div>
  )
}
