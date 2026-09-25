import type { AuthFile } from '../api'
import { readSamples } from '../history'
import type { Quota, QuotaWindow } from '../quota'
import { BurnChart } from './BurnChart'
import { Meter } from './Meter'
import { accountStatus } from '../status'
import { StatusIcon } from './StatusIcon'

export type QuotaState = { quota?: Quota; error?: string; loading: boolean }

// Weekly-or-longer windows that reset together share one chart.
function chartGroups(windows: QuotaWindow[]): QuotaWindow[][] {
  const groups: QuotaWindow[][] = []
  for (const w of windows) {
    if (w.resetAtMs === null || w.periodMs < 86400e3) continue
    const group = groups.find(
      (g) => g[0].periodMs === w.periodMs && Math.abs(g[0].resetAtMs! - w.resetAtMs!) < 60e3 && g.length < 3,
    )
    if (group) group.push(w)
    else groups.push([w])
  }
  return groups
}

type Props = {
  file: AuthFile
  quota: QuotaState | undefined
  now: number
  busy: boolean
  onToggle: (file: AuthFile) => void
}

export function AccountCard({ file, quota, now, busy, onToggle }: Props) {
  const status = accountStatus(file, now)
  const on = !file.disabled
  const windows = quota?.quota?.windows ?? []
  const name = file.email || file.label || file.name

  return (
    <article className={on ? 'card' : 'card off'} aria-busy={quota?.loading}>
      <header className="card-head">
        <div className="card-title">
          <span className="card-name">{name}</span>
          {quota?.quota?.plan && <span className="badge">{quota.quota.plan}</span>}
        </div>
        <span className="card-status" title={status.text}>
          <StatusIcon status={status.status} />
          <span className="card-status-text">{status.text}</span>
        </span>
        <button
          className="switch"
          role="switch"
          aria-checked={on}
          aria-label={`${on ? 'Turn off' : 'Turn on'} ${name}`}
          disabled={busy}
          onClick={() => onToggle(file)}
        >
          <span className="switch-thumb" />
        </button>
      </header>

      <div className={quota?.loading && windows.length ? 'card-body refreshing' : 'card-body'}>
        {quota?.error && <p className="muted small">Couldn’t load quota: {quota.error}</p>}
        {!quota?.error && !windows.length && (
          <p className="muted small">{!on ? 'Turn on to check quota' : quota?.loading ? 'Loading quota…' : 'No quota data'}</p>
        )}
        {windows.length > 0 && (
          <div className="meters">
            {windows.map((w) => (
              <Meter key={w.id} window={w} now={now} />
            ))}
          </div>
        )}
        {chartGroups(windows).map((group) => (
          <BurnChart
            key={group.map((w) => w.id).join()}
            now={now}
            series={group.map((w) => ({ window: w, samples: readSamples(file.auth_index, w) }))}
          />
        ))}
      </div>
    </article>
  )
}
