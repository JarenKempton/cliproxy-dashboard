import { RotateCw } from 'lucide-react'
import type { AuthFile } from '../lib/api'
import { formatAgo, formatRelative, formatStamp } from '../lib/format'
import { paceOf } from '../lib/pace'
import { PROVIDER_NAMES, providerOf, type QuotaWindow } from '../lib/quota'
import { accountStatus } from '../lib/status'
import { accountName, useStore } from '../lib/store'
import { Switch } from './ui'

function level(remaining: number) {
  return remaining < 10 ? 'bad' : remaining < 30 ? 'warn' : 'ok'
}

function PaceNote({ w, now }: { w: QuotaWindow; now: number }) {
  const pace = paceOf(w, now)
  if (pace.kind === 'short') return <span className="pace short">runs out {formatStamp(pace.runsOutAtMs)}</span>
  if (pace.kind === 'ok') return <span className="pace">on pace · ~{Math.round(100 - pace.projected)}% left at reset</span>
  return null
}

function WindowRow({ w, now }: { w: QuotaWindow; now: number }) {
  const remaining = Math.max(0, Math.min(100, 100 - w.usedPercent))
  return (
    <div className="qrow">
      <div className="qrow-head">
        <span>{w.label}</span>
        <span className={`mono qrow-value ${level(remaining)}`}>{Math.round(remaining)}%</span>
      </div>
      <div className="qbar" role="meter" aria-label={`${w.label} remaining`} aria-valuenow={Math.round(remaining)} aria-valuemin={0} aria-valuemax={100}>
        <div className={`qbar-fill ${level(remaining)}`} style={{ width: `${remaining}%` }} />
      </div>
      <div className="qrow-meta mono">
        {w.resetAtMs ? (
          <>
            <span>resets {formatStamp(w.resetAtMs)}</span>
            <span className="faint">{formatRelative(w.resetAtMs, now)}</span>
          </>
        ) : (
          <span className="faint">not started</span>
        )}
        <PaceNote w={w} now={now} />
      </div>
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
    <article className={file.disabled ? 'panel qcard off' : 'panel qcard'}>
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
          <p className="faint small-note">Off — turn on to check quota</p>
        ) : state?.error && !windows.length ? (
          <p className="error-text small-note">Couldn’t load quota · {state.error}</p>
        ) : !windows.length ? (
          <p className="faint small-note">{state?.loading ? 'Loading…' : 'No quota data'}</p>
        ) : (
          windows.map((w) => <WindowRow key={w.id} w={w} now={now} />)
        )}
      </div>

      <footer className="qcard-foot">
        <span className={`dot ${status.tone}`} />
        <span className="qcard-status" title={status.text}>
          {status.text}
        </span>
        {state?.error && windows.length > 0 && state.at && (
          <span className="mono faint" title={`Refresh failed: ${state.error}`}>
            as of {formatAgo(state.at, now)}
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
