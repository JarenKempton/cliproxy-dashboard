// An account a peer lends this proxy: when sharing ends, first, then its quota.

import { formatRelative, formatStamp } from '../lib/format'
import { PROVIDER_NAMES } from '../lib/quota'
import type { LentAccount, LentPool } from '../lib/sharing'
import { ProviderMark } from './ProviderMark'
import { WindowRow } from './QuotaCard'

const span = (from: number, to: number) => formatRelative(to, from).replace(/^in /, '').replace(/ ago$/, '')

function versusReset(account: LentAccount, until: number) {
  const reset = account.windows.find((w) => w.id === 'session')?.resetAtMs
  if (!reset) return null
  return until < reset
    ? { tone: 'warn', text: `Ends ${span(until, reset)} before this 5-hour window resets` }
    : { tone: 'faint', text: `Still shared ${span(reset, until)} after this 5-hour window resets` }
}

export function BorrowedCard({ owner, pool, account, name, now }: { owner: string; pool: LentPool; account: LentAccount; name: string; now: number }) {
  const relation = pool.until === null ? null : versusReset(account, pool.until)
  return (
    <article className="panel qcard">
      <header className="qcard-head">
        <span title={PROVIDER_NAMES[pool.provider]}>
          <ProviderMark of={pool.provider} />
        </span>
        <span className="qcard-name">{name}</span>
        <span className="tag" title={`Lent by ${owner}; used only after your own accounts`}>
          borrowed
        </span>
      </header>
      <div className="qcard-body">
        <div className="lent-until">
          {pool.until === null ? (
            <>
              <b>No end set</b>
              <span className="faint">shared until {owner} stops it</span>
            </>
          ) : (
            <>
              <b>{formatStamp(pool.until, now)}</b>
              <span className="faint">available until · {span(now, pool.until)} left</span>
            </>
          )}
        </div>
        {relation && <p className={`lent-relation ${relation.tone}`}>{relation.text}</p>}
        {account.windows.map((w) => (
          <WindowRow key={w.id} w={w} now={now} />
        ))}
      </div>
    </article>
  )
}
