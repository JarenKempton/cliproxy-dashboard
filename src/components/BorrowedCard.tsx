// An account a peer lends this proxy: its quota, and how long it is yours.
// The switch pauses the whole lender: this proxy can't pick among its accounts.

import { formatRelative, formatStamp } from '../lib/format'
import { PROVIDER_NAMES } from '../lib/quota'
import { describeFloors, type LentAccount, type LentPool } from '../lib/sharing'
import { ProviderMark } from './ProviderMark'
import { WindowRow } from './QuotaCard'
import { Switch } from './ui'

const shortStamp = (t: number, now: number) => formatStamp(t, now).replace(/^Today /, '')

type Props = {
  owner: string
  pool: LentPool
  account: LentAccount
  name: string
  now: number
  paused: boolean
  busy: boolean
  onPause: (paused: boolean) => void
}

export function BorrowedCard({ owner, pool, account, name, now, paused, busy, onPause }: Props) {
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
        <Switch
          on={!paused}
          label={`${paused ? 'Resume' : 'Pause'} borrowing from ${owner}, every account they lend`}
          disabled={busy}
          onChange={() => onPause(!paused)}
        />
      </header>
      <div className="qcard-body">
        {account.windows.map((w) => (
          <WindowRow key={w.id} w={w} now={now} floor={pool.floors[w.label] ?? 0} refills />
        ))}
      </div>
      <footer className="qcard-foot">
        <span className="qcard-status faint">
          {paused ? `paused · nothing goes to ${owner}` : left}
          {!paused && describeFloors(pool.floors) && ` · hatched = what ${owner} keeps`}
        </span>
      </footer>
    </article>
  )
}
