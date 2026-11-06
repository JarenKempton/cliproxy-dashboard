// An account a peer lends this proxy: its quota and when sharing ends.

import { formatRelative, formatStamp } from '../lib/format'
import { PROVIDER_NAMES } from '../lib/quota'
import type { LentAccount, LentPool } from '../lib/sharing'
import { ProviderMark } from './ProviderMark'
import { WindowRow } from './QuotaCard'

export function BorrowedCard({ owner, pool, account, name, now }: { owner: string; pool: LentPool; account: LentAccount; name: string; now: number }) {
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
        {account.windows.map((w) => (
          <WindowRow key={w.id} w={w} now={now} />
        ))}
      </div>
      <footer className="qcard-foot">
        <span className="qcard-status mono faint">
          {pool.until === null ? `Shared by ${owner} until they stop` : `Shared until ${formatStamp(pool.until, now)} · ${formatRelative(pool.until, now).replace('in ', '')} left`}
        </span>
      </footer>
    </article>
  )
}
