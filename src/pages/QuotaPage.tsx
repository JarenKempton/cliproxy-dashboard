import { RotateCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { BorrowedCard } from '../components/BorrowedCard'
import { QuotaCard } from '../components/QuotaCard'
import { Timeline } from '../components/Timeline'
import { PageHead, Switch, toast } from '../components/ui'
import { formatAgo } from '../lib/format'
import { lenderName, useSharingOverview } from '../lib/lenders'
import { PROVIDER_NAMES } from '../lib/quota'
import { getDrain, setDrain } from '../lib/sharing'
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

// Whether accounts are ranked soonest reset first, and a switch for it.
function useDrain() {
  const [on, setOn] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    getDrain()
      .then((d) => setOn(d.on))
      .catch(() => {}) // the switch stays hidden
  }, [])
  const toggle = () => {
    setBusy(true)
    setDrain(!on)
      .then((d) => setOn(d.on))
      .catch((e: Error) => toast(`Couldn’t change account order: ${e.message}`))
      .finally(() => setBusy(false))
  }
  return { on, busy, toggle }
}

export function QuotaPage() {
  const { files, quotas, now, refresh } = useStore()
  const activity = useActivity()
  const drain = useDrain()
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
        {drain.on !== null && (
          <span className="drain faint" title="Use the account whose weekly quota resets soonest first, so less quota expires unused. Sets each account’s priority in the proxy; turning it off clears them.">
            Soonest reset first
            <Switch on={drain.on} label="Use the account that resets soonest first" disabled={drain.busy} onChange={drain.toggle} />
          </span>
        )}
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
