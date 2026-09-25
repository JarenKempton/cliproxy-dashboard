import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useState, type CSSProperties } from 'react'
import { formatStamp } from '../lib/format'
import { accountName, providerOf, useStore } from '../lib/store'
import { pickLaneWindow, projectLane, startOfDay, timelineSpan, type TimelineMode } from '../lib/timeline'
import { Segmented } from './ui'

const DAY_FMT = new Intl.DateTimeFormat([], { weekday: 'short' })
const pad = (n: number) => String(n).padStart(2, '0')
const isWeekend = (d: Date) => d.getDay() === 0 || d.getDay() === 6

export function Timeline() {
  const { files, quotas, now } = useStore()
  const [mode, setMode] = useState<TimelineMode>('weekly')
  const [offset, setOffset] = useState(0)
  const span = timelineSpan(mode, offset, now)
  const spanMs = span.endMs - span.startMs

  const days = Array.from({ length: span.days }, (_, i) => {
    const d = new Date(span.startMs)
    d.setDate(d.getDate() + i)
    return d
  })
  const today = startOfDay(now)
  const nowPct = ((now - span.startMs) / spanMs) * 100

  const lanes = files
    .filter((f) => !f.disabled)
    .map((f) => {
      const windows = quotas[f.auth_index]?.quota?.windows ?? []
      const w = pickLaneWindow(windows, mode)
      return { f, windows, w, bars: w ? projectLane(w, span.startMs, span.endMs, now) : [] }
    })
    .filter((l) => l.w)

  const rangeLabel = `${pad(days[0].getMonth() + 1)}/${pad(days[0].getDate())} – ${pad(days[days.length - 1].getMonth() + 1)}/${pad(days[days.length - 1].getDate())}`

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

      <div className="panel tl" style={{ '--days': span.days } as CSSProperties}>
        <div className="tl-row tl-header">
          <div className="tl-label eyebrow">Account</div>
          <div className="tl-days">
            {days.map((d) => (
              <div key={d.getTime()} className={['tl-day', d.getTime() === today && 'today', isWeekend(d) && 'weekend'].filter(Boolean).join(' ')}>
                <span className="eyebrow">{DAY_FMT.format(d)}</span>
                <span className="mono">
                  {pad(d.getMonth() + 1)}/{pad(d.getDate())}
                </span>
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

        {lanes.length === 0 && <div className="tl-empty faint">No active account has a {mode === 'weekly' ? 'weekly' : '5-hour'} window to show.</div>}

        {lanes.map(({ f, windows, w, bars }) => {
          const provider = providerOf(f)
          return (
            <div key={f.auth_index} className="tl-row">
              <div className="tl-label">
                <div className="tl-name">
                  <span className={`dot ${provider}`} />
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
                      <span className="tl-bar-label mono">
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
