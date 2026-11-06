// An account a peer lends this proxy: how long you can use it, then its quota.

import { formatStamp } from '../lib/format'
import { PROVIDER_NAMES } from '../lib/quota'
import { untilNote, type LentAccount, type LentPool } from '../lib/sharing'
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
        {pool.until === null ? (
          <p className="lent-until">You can use this until {owner} stops sharing</p>
        ) : (
          <>
            <p className="lent-until">
              You can use this until <b>{formatStamp(pool.until, now)}</b>
            </p>
            <p className="lent-note faint">{untilNote(account, pool.until, now)}</p>
          </>
        )}
        {account.windows.map((w) => (
          <WindowRow key={w.id} w={w} now={now} refills />
        ))}
      </div>
    </article>
  )
}
