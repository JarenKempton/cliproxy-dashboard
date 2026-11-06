import { RotateCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { BorrowedCard } from '../components/BorrowedCard'
import { QuotaCard } from '../components/QuotaCard'
import { Timeline } from '../components/Timeline'
import { PageHead } from '../components/ui'
import { formatAgo } from '../lib/format'
import { lenderName, useSharingOverview } from '../lib/lenders'
import { PROVIDER_NAMES } from '../lib/quota'
import { accountStatus } from '../lib/status'
import { useStore } from '../lib/store'
import { getActivity, type AccountActivity } from '../lib/usage'

// An account counts as in use if it served a request in this window.
const ACTIVE_MINUTES = 5

// Which accounts are serving requests right now, refreshed every 15s.
function useActivity() {
  const [byAccount, setByAccount] = useState<Map<string, AccountActivity>>(new Map())
  useEffect(() => {
    const load = () =>
      getActivity(ACTIVE_MINUTES)
        .then((a) => setByAccount(new Map(a.accounts.map((x) => [x.accountRef, x]))))
        .catch(() => {}) // the cards still work without it
    load()
    const timer = setInterval(load, 15e3)
    return () => clearInterval(timer)
  }, [])
  return byAccount
}

export function QuotaPage() {
  const { files, quotas, now, refresh } = useStore()
  const activity = useActivity()
  const sharing = useSharingOverview()
  const borrowed = sharing.lenders.flatMap((l) =>
    l.pools
      .filter((p) => p.until === null || p.until > now)
      .flatMap((p) =>
        p.accounts.map((a, i) => ({
          key: `${l.gateway}|${p.pool}|${i}`,
          owner: lenderName(l),
          pool: p,
          account: a,
          name: `${lenderName(l)}’s ${PROVIDER_NAMES[p.provider]}${p.accounts.length > 1 ? ` ${i + 1}` : ''}`,
        })),
      ),
  )
  const on = files.filter((f) => !f.disabled)

  // The account serving right now: the one with the most recent request,
  // among accounts that are on and not cooling down or at a limit.
  const current = on
    .filter((f) => activity.has(f.auth_index) && accountStatus(f, now).tone === 'good')
    .sort((a, b) => activity.get(b.auth_index)!.lastAt - activity.get(a.auth_index)!.lastAt)[0]
  const loading = Object.values(quotas).some((q) => q.loading)
  const lastAt = Math.max(0, ...Object.values(quotas).map((q) => q.at ?? 0))

  return (
    <div className="page">
      <PageHead title="Quota" sub={`${on.length} accounts on${lastAt ? ` · updated ${formatAgo(lastAt, now)}` : ''}`}>
        <button className="btn" onClick={refresh} disabled={loading}>
          <RotateCw size={14} className={loading ? 'spin' : undefined} />
          Refresh
        </button>
      </PageHead>

      <div className="qgrid">
        {on.map((f) => (
          <QuotaCard key={f.auth_index} file={f} inUse={f === current ? activity.get(f.auth_index) : undefined} />
        ))}
        {borrowed.map((b) => (
          <BorrowedCard key={b.key} owner={b.owner} pool={b.pool} account={b.account} name={b.name} now={now} />
        ))}
      </div>

      <Timeline sharing={sharing} />
    </div>
  )
}
