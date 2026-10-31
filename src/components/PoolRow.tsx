import { useEffect, useMemo, useRef, useState } from 'react'
import { formatStamp } from '../lib/format'
import { poolOf, type Pool, type PoolAccount, type PoolPoint } from '../lib/pool'
import { PROVIDER_NAMES } from '../lib/quota'
import { ProviderMark } from './ProviderMark'

function useSize() {
  const ref = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const observer = new ResizeObserver(() => setSize({ width: el.clientWidth, height: el.clientHeight }))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  return [ref, size] as const
}

function paceLabel(pool: Pool, now: number) {
  if (pool.runsOutAt === null) return { tone: 'good', text: 'On pace' }
  if (pool.runsOutAt <= now) return { tone: 'warn', text: 'Empty' }
  return { tone: 'warn', text: `Runs out ${formatStamp(pool.runsOutAt, now)}` }
}

export function PoolRow({ provider, accounts, spanStart, spanEnd, now }: { provider: string; accounts: PoolAccount[]; spanStart: number; spanEnd: number; now: number }) {
  const [ref, { width, height }] = useSize()
  const pool = useMemo(() => poolOf(accounts, spanStart, spanEnd, now), [accounts, spanStart, spanEnd, now])
  if (!pool) return null
  const pace = paceLabel(pool, now)
  const nowPct = ((now - spanStart) / (spanEnd - spanStart)) * 100

  return (
    <div className="tl-row tl-pool">
      <div className="tl-label">
        <div className="tl-name">
          <ProviderMark of={provider} />
          <span>{PROVIDER_NAMES[provider]} pool</span>
        </div>
        <div className="pool-left">
          {Math.round(pool.left)}
          <span>%</span>
          <small>left across {accounts.length} accounts</small>
        </div>
        <span className={`pool-pill ${pace.tone}`}>{pace.text}</span>
        <dl className="pool-stats">
          <div>
            <dt>Your pace</dt>
            <dd>{Math.round(pool.usualPerDay)}%/workday</dd>
          </div>
          <div>
            <dt>Sustainable</dt>
            <dd>{Math.round(pool.sustainablePerDay)}%/workday</dd>
          </div>
        </dl>
      </div>
      <div className="tl-track pool-track" ref={ref}>
        {nowPct > 0 && nowPct < 100 && <div className="tl-now tl-now-lane" style={{ left: `${nowPct}%` }} />}
        {width > 0 && <PoolChart pool={pool} refill={100 / accounts.length} spanStart={spanStart} spanEnd={spanEnd} width={width} height={height} />}
      </div>
    </div>
  )
}

const TOP = 22
const BOTTOM = 8

function PoolChart({ pool, refill, spanStart, spanEnd, width, height }: { pool: Pool; refill: number; spanStart: number; spanEnd: number; width: number; height: number }) {
  const x = (t: number) => ((t - spanStart) / (spanEnd - spanStart)) * width
  const y = (v: number) => TOP + (1 - v / 100) * (height - TOP - BOTTOM)
  const points = (p: PoolPoint[]) => p.map((q) => `${x(q.t)},${y(q.pool)}`).join(' ')
  const area = (p: PoolPoint[]) => `${x(p[0].t)},${y(0)} ${points(p)} ${x(p[p.length - 1].t)},${y(0)}`
  const safeAt = (t: number) => (pool.safe.find((p) => p.t >= t) ?? pool.safe[pool.safe.length - 1]).pool
  const line = [...pool.past, ...pool.projected.slice(1)]
  const behind = line.slice(1).flatMap((b, i) => {
    const a = line[i]
    if (b.t <= a.t || (a.pool + b.pool) / 2 >= (safeAt(a.t) + safeAt(b.t)) / 2 - 0.5) return []
    return [`${x(a.t)},${y(a.pool)} ${x(b.t)},${y(b.pool)} ${x(b.t)},${y(safeAt(b.t))} ${x(a.t)},${y(safeAt(a.t))}`]
  })
  const peakAfter = (t: number) => Math.max(...line.filter((p) => p.t >= t && p.t - t <= 2 * 3600e3).map((p) => p.pool), 0)

  return (
    <svg className="pool-chart" width={width} height={height} aria-label={`Pool ${Math.round(pool.left)}% left`}>
      <defs>
        <pattern id="pool-dots" width="3" height="3" patternUnits="userSpaceOnUse">
          <circle cx="1.5" cy="1.5" r="0.75" className="pool-dot" />
        </pattern>
      </defs>
      {[100, 50].map((v) => (
        <line key={v} className="pool-grid" x1={0} x2={width} y1={y(v)} y2={y(v)} />
      ))}
      <line className="pool-base" x1={0} x2={width} y1={y(0)} y2={y(0)} />
      <polygon className="pool-area" points={area(pool.past)} />
      <polygon className="pool-area future" points={area(pool.projected)} />
      {behind.map((p, i) => (
        <polygon key={i} className="pool-behind" points={p} />
      ))}
      <polyline className="pool-safe" points={points(pool.safe)} />
      <polyline className="pool-line" points={points(pool.past)} />
      <polyline className="pool-line future" points={points(pool.projected)} />
      {pool.resets.map((t) => {
        const ry = y(peakAfter(t))
        const end = x(t) > width - 50
        return (
          <g key={t} className="pool-reset">
            <path d={`M${x(t) - 4},${ry - 6} L${x(t)},${ry - 12} L${x(t) + 4},${ry - 6} Z`} />
            <text x={end ? x(t) - 7 : x(t) + 7} y={ry - 5} textAnchor={end ? 'end' : 'start'}>
              +{Math.round(refill)}%
            </text>
          </g>
        )
      })}
      {[100, 50].map((v) => (
        <text key={v} className="pool-grid" x={4} y={y(v) - 3}>
          {v}%
        </text>
      ))}
      <circle className="pool-now" cx={x(pool.past[pool.past.length - 1].t)} cy={y(pool.left)} r={4} />
    </svg>
  )
}
