import { AlertTriangle, RotateCw } from 'lucide-react'
import type { AuthFile } from '../lib/api'
import type { QuotaError } from '../lib/errors'
import { formatAgo, formatRelative, formatStamp } from '../lib/format'
import { paceOf } from '../lib/pace'
import { PROVIDER_NAMES, providerOf, type QuotaWindow } from '../lib/quota'
import { accountStatus } from '../lib/status'
import { accountName, useStore } from '../lib/store'
import { ActivityChart } from './ActivityChart'
import { Switch } from './ui'

function level(remaining: number) {
  return remaining < 10 ? 'bad' : remaining < 30 ? 'warn' : 'ok'
}

function WindowRow({ w, now }: { w: QuotaWindow; now: number }) {
  const remaining = Math.max(0, Math.min(100, 100 - w.usedPercent))
  const pace = paceOf(w, now)
  // Where "remaining" would sit on an even burn; ahead of it means headroom.
  const paceMark = w.resetAtMs ? 100 - Math.min(100, Math.max(0, ((now - (w.resetAtMs - w.periodMs)) / w.periodMs) * 100)) : null
  const title = w.resetAtMs
    ? `Resets ${formatStamp(w.resetAtMs)}${pace.kind === 'ok' ? ` · on pace, ~${Math.round(100 - pace.projected)}% left at reset` : ''}`
    : 'Window not started'

  return (
    <div className="qrow" title={title}>
      <div className="qrow-head">
        <span>{w.label}</span>
        <span className={`mono qrow-value ${level(remaining)}`}>{Math.round(remaining)}%</span>
      </div>
      <div className={`dbar ${level(remaining)}`} role="meter" aria-label={`${w.label} remaining`} aria-valuenow={Math.round(remaining)} aria-valuemin={0} aria-valuemax={100}>
        {remaining > 0 && <div className="dbar-fill" style={{ width: `${remaining}%` }} />}
        {paceMark !== null && pace.kind !== 'maxed' && <div className="dbar-pace" style={{ left: `${paceMark}%` }} />}
      </div>
      <div className="qrow-meta mono">
        <span className="faint">{w.resetAtMs ? `↻ ${formatRelative(w.resetAtMs, now).replace('in ', '')}` : 'idle'}</span>
        {pace.kind === 'short' && <span className="warn-text">out {formatStamp(pace.runsOutAtMs)}</span>}
      </div>
    </div>
  )
}

function ErrorBlock({ error, now, stale }: { error: QuotaError; now: number; stale: boolean }) {
  return (
    <div className="qerror">
      <div className="qerror-title">
        <AlertTriangle size={15} />
        {error.title}
        {error.retryAt && error.retryAt > now && <span className="mono qerror-retry">retry {formatRelative(error.retryAt, now)}</span>}
      </div>
      {error.message && <p className="qerror-msg">{error.message}</p>}
      <details>
        <summary className="mono faint">{error.code}</summary>
        <p className="muted">{error.hint}</p>
        {stale && <p className="faint">Showing the last successful reading below.</p>}
      </details>
    </div>
  )
}

export function QuotaCard({ file }: { file: AuthFile }) {
  const { quotas, now, busy, toggle, refreshQuota } = useStore()
  const state = quotas[file.auth_index]
  const status = accountStatus(file, now)
  const provider = providerOf(file)
  const windows = state?.quota?.windows ?? []

  return (
    <article className={['panel qcard', file.disabled && 'off', !file.disabled && state?.error && 'has-error'].filter(Boolean).join(' ')}>
      <header className="qcard-head">
        <span className={`dot ${provider}`} title={PROVIDER_NAMES[provider]} />
        <span className="qcard-name" title={accountName(file)}>
          {accountName(file)}
        </span>
        {state?.quota?.plan && <span className="tag">{state.quota.plan}</span>}
        <Switch
          on={!file.disabled}
          label={`${file.disabled ? 'Turn on' : 'Turn off'} ${accountName(file)}`}
          disabled={busy.has(file.auth_index)}
          onChange={() => toggle(file)}
        />
      </header>

      <div className={state?.loading && windows.length ? 'qcard-body loading' : 'qcard-body'}>
        {file.disabled ? (
          <p className="faint small-note">Off</p>
        ) : (
          <>
            {state?.error && <ErrorBlock error={state.error} now={now} stale={windows.length > 0} />}
            {!state?.error && !windows.length && <p className="faint small-note">{state?.loading ? 'Loading…' : 'No quota data'}</p>}
            {windows.map((w) => (
              <WindowRow key={w.id} w={w} now={now} />
            ))}
          </>
        )}
      </div>

      {!file.disabled && file.recent_requests && <ActivityChart buckets={file.recent_requests} id={file.auth_index} />}

      <footer className="qcard-foot">
        <span className={`dot ${status.tone}`} />
        <span className="qcard-status" title={status.text}>
          {status.text}
        </span>
        {state?.at && (
          <span className="mono faint" title={`Quota read at ${formatStamp(state.at)}`}>
            {formatAgo(state.at, now)}
          </span>
        )}
        {!file.disabled && (
          <button className="btn btn-ghost btn-icon" aria-label="Refresh quota" title="Refresh quota" onClick={() => refreshQuota(file)}>
            <RotateCw size={14} className={state?.loading ? 'spin' : undefined} />
          </button>
        )}
      </footer>
    </article>
  )
}
