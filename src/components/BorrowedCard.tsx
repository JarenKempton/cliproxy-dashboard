// An account a peer lends this proxy: its quota, and how long it is yours.

import { formatRelative, formatStamp } from '../lib/format'
import { PROVIDER_NAMES } from '../lib/quota'
import { describeFloors, type LentAccount, type LentPool } from '../lib/sharing'
import { ProviderMark } from './ProviderMark'
import { WindowRow } from './QuotaCard'

const shortStamp = (t: number, now: number) => formatStamp(t, now).replace(/^Today /, '')

type Props = {
  owner: string
  pool: LentPool
  account: LentAccount
  name: string
  now: number
  paused: boolean
}

export function BorrowedCard({ owner, pool, account, name, now, paused }: Props) {
  const left = pool.until === null ? `until ${owner} stops sharing` : `${formatRelative(pool.until, now).replace(/^in /, '').replace(/ 0m$/, '')} left`
  return (
    <article className={paused ? 'panel qcard off' : 'panel qcard'}>
      <header className="qcard-head">
        <span title={PROVIDER_NAMES[pool.provider]}>
          <ProviderMark of={pool.provider} />
        </span>
        <span className="qcard-name">{name}</span>
        <span className="tag mono" title={`Borrowed from ${owner}; used only after your own accounts`}>
          {pool.until === null ? 'borrowed' : `until ${shortStamp(pool.until, now)}`}
        </span>
      </header>
      <div className="qcard-body">
        {account.windows.map((w) => (
          <WindowRow key={w.id} w={w} now={now} floor={pool.floors[w.label] ?? 0} refills />
        ))}
      </div>
      <footer className="qcard-foot">
        <span className="qcard-status faint">
          {paused ? `paused · resume on the Sharing page` : left}
          {!paused && describeFloors(pool.floors) && ` · hatched = what ${owner} keeps`}
        </span>
      </footer>
    </article>
  )
}
