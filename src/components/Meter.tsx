import { formatWhen } from '../format'
import { paceOf } from '../pace'
import type { QuotaWindow } from '../quota'
import { StatusIcon } from './StatusIcon'

function paceNote(w: QuotaWindow, now: number) {
  const pace = paceOf(w, now)
  const reset = w.resetAtMs ? `resets ${formatWhen(w.resetAtMs, now)}` : null
  switch (pace.state) {
    case 'idle':
      return { status: 'neutral' as const, text: 'Not started' }
    case 'maxed':
      return { status: 'critical' as const, text: ['Limit reached', reset].filter(Boolean).join(' · ') }
    case 'over':
      return { status: 'warning' as const, text: `Runs out ${formatWhen(pace.runsOutAtMs!, now)} · ${reset}` }
    case 'ok':
      return {
        status: 'good' as const,
        text: [pace.projectedPercent !== null ? `On track · ~${Math.round(pace.projectedPercent)}% by reset` : 'On track', reset]
          .filter(Boolean)
          .join(' · '),
      }
  }
}

export function Meter({ window: w, now }: { window: QuotaWindow; now: number }) {
  const pace = paceOf(w, now)
  const note = paceNote(w, now)
  const used = Math.min(Math.max(w.usedPercent, 0), 100)
  return (
    <div className="meter">
      <div className="meter-head">
        <span className="meter-label">{w.label}</span>
        <span className="meter-value">{Math.round(w.usedPercent)}% used</span>
      </div>
      <div
        className={`meter-track fill-${pace.state}`}
        role="meter"
        aria-label={`${w.label} usage`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(used)}
      >
        {used > 0 && <div className="meter-fill" style={{ width: `${used}%` }} />}
        {pace.pacePercent !== null && pace.state !== 'maxed' && (
          <div className="meter-pace" style={{ left: `${pace.pacePercent}%` }} title={`Even pace: ${Math.round(pace.pacePercent)}%`} />
        )}
      </div>
      <div className="meter-note">
        <StatusIcon status={note.status} />
        {note.text}
      </div>
    </div>
  )
}
