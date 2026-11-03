import { useEffect, useMemo, useRef, useState } from 'react'
import { formatStamp } from '../lib/format'
import { PLAN_SLACK, poolOf, type Pool, type PoolAccount, type PoolPoint } from '../lib/pool'
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

const aroundHour = (t: number, now: number) => formatStamp(Math.round(t / 3600e3) * 3600e3, now)

function planStatus(pool: Pool, now: number) {
  const gap = Math.round(pool.planNow) - Math.round(pool.left)
  if (pool.belowPlan === null) return { tone: 'good', text: 'On plan' }
  if (pool.belowPlan.from <= now) return { tone: 'bad', text: `${gap} pts below plan` }
  return { tone: 'warn', text: 'Drops below plan' }
}

export function PoolRow({
  provider,
  accounts,
  spanStart,
  spanEnd,
  now,
}: {
  provider: string
  accounts: PoolAccount[]
  spanStart: number
  spanEnd: number
  now: number
}) {
  const [ref, { width, height }] = useSize()
  const pool = useMemo(() => poolOf(accounts, spanStart, spanEnd, now), [accounts, spanStart, spanEnd, now])
  const pooled = accounts.length > 1
  if (!pool) return null
  const status = planStatus(pool, now)
  const nextRefill = Math.min(...accounts.map((a) => a.window.resetAtMs).filter((t) => t > now))
  const nowPct = ((now - spanStart) / (spanEnd - spanStart)) * 100
  const facts: { term: string; value: string; tone?: string }[] = []
  if (pool.belowPlan && pool.belowPlan.from > now)
    facts.push({
      term: 'Below plan',
      value: aroundHour(pool.belowPlan.from, now),
      tone: 'warn',
    })
  if (pool.runsOutAt !== null)
    facts.push({
      term: 'Runs out',
      value: pool.runsOutAt <= now ? 'Now' : aroundHour(pool.runsOutAt, now),
      tone: 'bad',
    })
  if (pool.belowPlan?.until && pool.belowPlan.until < nextRefill)
    facts.push({
      term: 'Back on plan',
      value: aroundHour(pool.belowPlan.until, now),
    })
  if (nextRefill < Infinity) facts.push({ term: 'Next refill', value: formatStamp(nextRefill, now) })
  facts.push({
    term: 'Your pace',
    value: `${Math.round(pool.usualPerDay)}%/workday`,
    tone: pool.usualPerDay > pool.safePerDay ? 'warn' : undefined,
  })
  if (pool.runsOutAt === null || pool.runsOutAt > now)
    facts.push({
      term: 'Safe pace',
      value: `≤ ${Math.floor(pool.safePerDay)}%/workday`,
    })

  return (
    <div className="tl-row tl-pool">
      <div className="tl-label">
        <div className="tl-name">
          <ProviderMark of={provider} />
          <span>{pooled ? `${PROVIDER_NAMES[provider]} pool` : PROVIDER_NAMES[provider]}</span>
        </div>
        <div className="pool-left">
          {Math.round(pool.left)}
          <span>%</span>
          <small>
            {pooled ? `left of ${accounts.length} accounts` : 'left this week'} · plan {Math.round(pool.planNow)}%
          </small>
        </div>
        <span className={`pool-pill ${status.tone}`}>{status.text}</span>
        <dl className="pool-facts">
          {facts.map(({ term, value, tone }) => (
            <div key={term} className={tone}>
              <dt>{term}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      </div>
      <div className="tl-track pool-track" ref={ref}>
        {nowPct > 0 && nowPct < 100 && <div className="tl-now tl-now-lane" style={{ left: `${nowPct}%` }} />}
        {width > 0 && <PoolChart pool={pool} now={now} spanStart={spanStart} spanEnd={spanEnd} width={width} height={height} />}
        <div className="pool-key mono" aria-hidden="true">
          <span>
            <KeyLine className="pool-line" /> left
          </span>
          <span>
            <KeyLine className="pool-line future" /> at your pace
          </span>
          <span>
            <KeyLine className="pool-plan" /> plan
          </span>
          <span>
            <svg width="20" height="10">
              <rect className="pool-under" y="1" width="20" height="8" />
            </svg>{' '}
            below plan
          </span>
        </div>
      </div>
    </div>
  )
}

function KeyLine({ className }: { className: string }) {
  return (
    <svg width="20" height="10">
      <line className={className} x1="0" x2="20" y1="5" y2="5" />
    </svg>
  )
}

const TOP = 22
const BOTTOM = 8

function PoolChart({
  pool,
  now,
  spanStart,
  spanEnd,
  width,
  height,
}: {
  pool: Pool
  now: number
  spanStart: number
  spanEnd: number
  width: number
  height: number
}) {
  const x = (t: number) => ((t - spanStart) / (spanEnd - spanStart)) * width
  const y = (v: number) => TOP + (1 - v / 100) * (height - TOP - BOTTOM)
  const points = (p: PoolPoint[]) => p.map((q) => `${x(q.t)},${y(q.pool)}`).join(' ')
  const area = (p: PoolPoint[]) => `${x(p[0].t)},${y(0)} ${points(p)} ${x(p[p.length - 1].t)},${y(0)}`
  const line = [...pool.past, ...pool.projected.slice(1)]
  const stretches: number[][] = []
  line.forEach((p, i) => {
    if (p.t < now || p.pool >= pool.plan[i].pool - PLAN_SLACK) return
    const last = stretches.at(-1)
    if (last && last.at(-1) === i - 1) last.push(i)
    else stretches.push([i])
  })
  const under = stretches.map((run) => points([...run.map((i) => line[i]), ...run.toReversed().map((i) => pool.plan[i])]))
  const drop = pool.belowPlan && pool.belowPlan.from > now ? line.find((p) => p.t === pool.belowPlan!.from) : undefined

  return (
    <svg className="pool-chart" width={width} height={height} aria-label={`Pool ${Math.round(pool.left)}% left, plan ${Math.round(pool.planNow)}%`}>
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
      {under.map((u, i) => (
        <polygon key={i} className="pool-under" points={u} />
      ))}
      <polyline className="pool-plan" points={points(pool.plan)} />
      <polyline className="pool-line" points={points(pool.past)} />
      <polyline className="pool-line future" points={points(pool.projected)} />
      {[100, 50].map((v) => (
        <text key={v} className="pool-grid" x={4} y={y(v) - 3}>
          {v}%
        </text>
      ))}
      {drop && <circle className="pool-drop" cx={x(drop.t)} cy={y(drop.pool)} r={4} />}
      <circle className="pool-now" cx={x(pool.past[pool.past.length - 1].t)} cy={y(pool.left)} r={4} />
    </svg>
  )
}
