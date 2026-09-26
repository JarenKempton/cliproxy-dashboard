import { AlertTriangle, RotateCw } from 'lucide-react'
import type { AuthFile } from '../lib/api'
import type { QuotaError } from '../lib/errors'
import { formatAgo, formatRelative, formatStamp } from '../lib/format'
import { paceOf } from '../lib/pace'
import { PROVIDER_NAMES, providerOf, type QuotaWindow } from '../lib/quota'
import { accountStatus } from '../lib/status'
import { accountName, useStore } from '../lib/store'
import { ActivityChart } from './ActivityChart'
import type { AccountActivity } from '../lib/usage'
import { ProviderMark } from './ProviderMark'
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
        <span className="faint">{w.resetAtMs ? `resets ${formatRelative(w.resetAtMs, now)}` : 'not started'}</span>
        {pace.kind === 'short' && (
          <span className="warn-text" title="At your current rate you'll hit this limit before it resets.">
            Runs out {formatStamp(pace.runsOutAtMs, now)}
          </span>
        )}
      </div>
    </div>
  )
}

function ErrorBlock({ error, now, stale }: { error: QuotaError; now: number; stale: boolean }) {
  const retry = error.retryAt && error.retryAt > now ? `retry ${formatRelative(error.retryAt, now)}` : null
  return (
    <div className="qerror" title={stale ? `${error.hint} Showing the last successful reading.` : error.hint}>
      <div className="qerror-title">
        <AlertTriangle size={14} />
        {error.title}
      </div>
      {error.message && <p className="qerror-msg">{error.message}</p>}
      <p className="qerror-meta mono">{[retry, error.code].filter(Boolean).join(' · ')}</p>
    </div>
  )
}

// `inUse` is set on the one account serving requests right now.
export function QuotaCard({ file, inUse }: { file: AuthFile; inUse?: AccountActivity }) {
  const { quotas, now, busy, toggle, refreshQuota } = useStore()
  const state = quotas[file.auth_index]
  const status = accountStatus(file, now)
  const provider = providerOf(file)
  const windows = state?.quota?.windows ?? []

  return (
    <article
      className={['panel qcard', file.disabled && 'off', !file.disabled && state?.error && 'has-error']
        .filter(Boolean)
        .join(' ')}
    >
      <header className="qcard-head">
        <span title={PROVIDER_NAMES[provider]}>
          <ProviderMark of={provider} />
        </span>
        <span className="qcard-name" title={accountName(file)}>
          {accountName(file)}
        </span>
        {state?.quota?.plan && (
          <span className="tag" title={provider === 'codex' ? `OpenAI plan_type: ${state.quota.plan}` : 'From the Anthropic account profile'}>
            {state.quota.plan}
          </span>
        )}
        {inUse && (
          <span
            className="tag tag-live"
            title={`Serving requests right now\n${inUse.machines.map((m) => `${m.name}: ${m.requests} in the last 5 min`).join('\n')}`}
          >
            in use
          </span>
        )}
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
        {/* Say something only when there's a problem. */}
        {status.tone === 'warn' || status.tone === 'bad' ? (
          <span className={`qcard-status ${status.tone}`} title={status.text}>
            {status.text}
          </span>
) : (
          <span className="qcard-status" />
        )}
        {state?.at && (
          <span className="mono faint" title={`Quota read at ${formatStamp(state.at)}`}>
            read {formatAgo(state.at, now)}
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
