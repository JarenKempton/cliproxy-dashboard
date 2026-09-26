import { RotateCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { QuotaCard } from '../components/QuotaCard'
import { Timeline } from '../components/Timeline'
import { PageHead } from '../components/ui'
import { formatAgo } from '../lib/format'
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
  const active = files.filter((f) => !f.disabled).length
  const loading = Object.values(quotas).some((q) => q.loading)
  const lastAt = Math.max(0, ...Object.values(quotas).map((q) => q.at ?? 0))

  return (
    <div className="page">
      <PageHead title="Quota" sub={`${files.length} accounts · ${active} on${lastAt ? ` · updated ${formatAgo(lastAt, now)}` : ''}`}>
        <button className="btn" onClick={refresh} disabled={loading}>
          <RotateCw size={14} className={loading ? 'spin' : undefined} />
          Refresh
        </button>
      </PageHead>

      <div className="qgrid">
        {files.map((f) => (
          <QuotaCard key={f.auth_index} file={f} activity={activity.get(f.auth_index)} />
        ))}
      </div>

      <Timeline />
    </div>
  )
}
