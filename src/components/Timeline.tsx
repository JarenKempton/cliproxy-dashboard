import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useEffect, useState, type CSSProperties } from 'react'
import { formatStamp } from '../lib/format'
import { accountName, providerOf, useStore } from '../lib/store'
import type { PoolAccount } from '../lib/pool'
import { pickLaneWindow, projectLane, startOfDay, timelineSpan, type TimelineMode } from '../lib/timeline'
import { getAccountHours, type AccountHour } from '../lib/usage'
import { PoolRow } from './PoolRow'
import { ProviderMark } from './ProviderMark'
import { Segmented } from './ui'

const DAY_FMT = new Intl.DateTimeFormat([], { weekday: 'short' })
const HOUR_FMT = new Intl.DateTimeFormat([], { hour: 'numeric' })
const HOURS_PER_TICK = 3
const pad = (n: number) => String(n).padStart(2, '0')
const isWeekend = (d: Date) => d.getDay() === 0 || d.getDay() === 6

// Matches the phone breakpoint in mobile.css.
function useCompact() {
  const query = '(max-width: 760px)'
  const [compact, setCompact] = useState(() => matchMedia(query).matches)
  useEffect(() => {
    const mq = matchMedia(query)
    const onChange = () => setCompact(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return compact
}

// Proxy cost per account and hour, for the pool rows; refreshed every 5 minutes.
const HISTORY_DAYS = 21
function useAccountHours() {
  const [hours, setHours] = useState<AccountHour[]>([])
  useEffect(() => {
    const load = () => getAccountHours(HISTORY_DAYS).then(setHours).catch(() => {}) // the lanes still work without it
    load()
    const timer = setInterval(load, 300e3)
    return () => clearInterval(timer)
  }, [])
  return hours
}

export function Timeline() {
  const { files, quotas, now } = useStore()
  const [mode, setMode] = useState<TimelineMode>('weekly')
  const [offset, setOffset] = useState(0)
  const compact = useCompact()
  const span = timelineSpan(mode, offset, now, compact)
  const spanMs = span.endMs - span.startMs

  const days = Array.from({ length: span.days }, (_, i) => {
    const d = new Date(span.startMs)
    d.setDate(d.getDate() + i)
    return d
  })
  const today = startOfDay(now)
  const session = mode === 'session'
  const ticks = session
    ? Array.from({ length: 24 / HOURS_PER_TICK }, (_, i) => {
        const d = new Date(span.startMs)
        d.setHours(i * HOURS_PER_TICK)
        return d
      })
    : days
  const nowPct = ((now - span.startMs) / spanMs) * 100

  const lanes = files
    .filter((f) => !f.disabled)
    .map((f) => {
      const windows = quotas[f.auth_index]?.quota?.windows ?? []
      const w = pickLaneWindow(windows, mode)
      return { f, windows, w, bars: w ? projectLane(w, span.startMs, span.endMs, now) : [] }
    })
    .filter((l) => l.w)

  const hours = useAccountHours()
  const pools = new Map<string, PoolAccount[]>()
  if (!session) {
    for (const f of files.filter((file) => !file.disabled)) {
      const weekly = quotas[f.auth_index]?.quota?.windows.find((w) => w.id === 'weekly')
      if (!weekly?.resetAtMs) continue
      const provider = providerOf(f)
      const label = f.email ?? accountName(f)
      const cost = new Map(hours.filter((h) => h.provider === provider && h.account === label).map((h) => [h.hour, h.costMicros]))
      pools.set(provider, [...(pools.get(provider) ?? []), { cost, window: { ...weekly, resetAtMs: weekly.resetAtMs } }])
    }
  }

  const dateLabel = (d: Date) => `${pad(d.getMonth() + 1)}/${pad(d.getDate())}`
  const rangeLabel = session ? `${DAY_FMT.format(days[0])} ${dateLabel(days[0])}` : `${dateLabel(days[0])} – ${dateLabel(days[days.length - 1])}`

  return (
    <section className="section">
      <div className="section-head">
        <h2>Quota windows</h2>
        <span className="mono faint">{rangeLabel}</span>
        <div className="page-actions">
          <div className="seg">
            <button aria-label="Previous" onClick={() => setOffset(offset - 1)}>
              <ChevronLeft size={14} />
            </button>
            <button aria-pressed={offset === 0} onClick={() => setOffset(0)}>
              Today
            </button>
            <button aria-label="Next" onClick={() => setOffset(offset + 1)}>
              <ChevronRight size={14} />
            </button>
          </div>
          <Segmented
            value={mode}
            onChange={(m) => {
              setMode(m)
              setOffset(0)
            }}
            options={[
              ['weekly', 'Weekly'],
              ['session', '5-hour'],
            ]}
          />
        </div>
      </div>

      <div className={session ? 'panel tl tl-session' : 'panel tl'} style={{ '--days': ticks.length } as CSSProperties}>
        <div className="tl-row tl-header">
          <div className="tl-label eyebrow">Account</div>
          <div className="tl-days">
            {session
              ? ticks.map((t) => (
                  <div key={t.getTime()} className="tl-day tl-hour">
                    <span className="mono">{HOUR_FMT.format(t)}</span>
                  </div>
                ))
              : days.map((d) => (
                  <div key={d.getTime()} className={['tl-day', d.getTime() === today && 'today', isWeekend(d) && 'weekend'].filter(Boolean).join(' ')}>
                    <span className="eyebrow">{DAY_FMT.format(d)}</span>
                    <span className="mono">{dateLabel(d)}</span>
                  </div>
                ))}
          </div>
        </div>

        {/* Weekend shading behind every lane. */}
        <div className="tl-weekends" aria-hidden="true">
          {days.map((d, i) =>
            isWeekend(d) ? <div key={i} style={{ left: `${(i / span.days) * 100}%`, width: `${100 / span.days}%` }} /> : null,
          )}
        </div>

        {[...pools].map(([provider, accounts]) =>
          accounts.length > 1 ? <PoolRow key={provider} provider={provider} accounts={accounts} spanStart={span.startMs} spanEnd={span.endMs} now={now} /> : null,
        )}

        {lanes.length === 0 && <div className="tl-empty faint">No active account has a {mode === 'weekly' ? 'weekly' : '5-hour'} window to show.</div>}

        {lanes.map(({ f, windows, w, bars }) => {
          const provider = providerOf(f)
          return (
            <div key={f.auth_index} className="tl-row">
              <div className="tl-label">
                <div className="tl-name">
                  <ProviderMark of={provider} />
                  <span title={accountName(f)}>{accountName(f)}</span>
                </div>
                <div className="tl-limits mono">
                  {windows.map((w) => (
                    <span key={w.id}>
                      {w.label} <b>{Math.round(Math.max(0, 100 - w.usedPercent))}%</b>
                    </span>
                  ))}
                </div>
              </div>
              <div className="tl-track">
                {/* Phones draw "now" per lane (labels sit between lanes there). */}
                {nowPct > 0 && nowPct < 100 && <div className="tl-now tl-now-lane" style={{ left: `${nowPct}%` }} />}
                {bars.map((b) => {
                  const remaining = b.used === null ? null : Math.max(0, 100 - b.used)
                  // Same color language as the quota bars: fine, low, nearly out.
                  const level = remaining === null ? '' : remaining < 10 ? 'bad' : remaining < 30 ? 'warn' : 'ok'
                  return (
                    <div
                      key={b.startMs}
                      className={`tl-bar ${b.state} ${level}`}
                      style={{ left: `${b.left}%`, width: `${b.width}%` }}
                      title={`${formatStamp(b.startMs)} → ${formatStamp(b.endMs)}`}
                    >
                      {b.used !== null && <div className="tl-bar-used" style={{ width: `${Math.min(100, b.used)}%` }} />}
                      <span className={b.state === 'live' ? 'tl-bar-label mono' : 'tl-bar-label tl-bar-label-quiet mono'}>
                        {remaining !== null
                          ? `${Math.round(remaining)}%${w!.label.startsWith('Weekly') || w!.label === '5-hour' ? '' : ` ${w!.label}`} · ${formatStamp(b.endMs)}`
                          : b.state === 'next'
                            ? formatStamp(b.endMs)
                            : formatStamp(b.startMs)}
                      </span>
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })}

        {nowPct > 0 && nowPct < 100 && lanes.length > 0 && (
          <div className="tl-now-layer" aria-hidden="true">
            <div className="tl-now" style={{ left: `${nowPct}%` }} />
          </div>
        )}
      </div>

      <div className="tl-legend mono faint">
        <span>
          <i className="lg live" /> current window · fill = used
        </span>
        <span>
          <i className="lg next" /> upcoming
        </span>
        <span>
          <i className="lg past" /> elapsed
        </span>
        <span>
          <i className="lg now" /> now
        </span>
      </div>
    </section>
  )
}
