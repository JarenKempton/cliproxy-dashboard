import { RotateCw } from 'lucide-react'
import { QuotaCard } from '../components/QuotaCard'
import { Timeline } from '../components/Timeline'
import { PageHead } from '../components/ui'
import { formatAgo } from '../lib/format'
import { useStore } from '../lib/store'

export function QuotaPage() {
  const { files, quotas, now, refresh } = useStore()
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
          <QuotaCard key={f.auth_index} file={f} />
        ))}
      </div>

      <Timeline />
    </div>
  )
}
