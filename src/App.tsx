import { Gauge, KeyRound, Settings2, Users, Zap } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { Toaster } from './components/ui'
import { proxyVersion } from './lib/api'
import { useStore } from './lib/store'
import { AccountsPage } from './pages/AccountsPage'
import { ConfigPage } from './pages/ConfigPage'
import { KeysPage } from './pages/KeysPage'
import { QuotaPage } from './pages/QuotaPage'

const ROUTES = {
  quota: { label: 'Quota', icon: Gauge, page: QuotaPage },
  accounts: { label: 'Accounts', icon: Users, page: AccountsPage },
  keys: { label: 'API keys', icon: KeyRound, page: KeysPage },
  config: { label: 'Config', icon: Settings2, page: ConfigPage },
} as const
type Route = keyof typeof ROUTES

const NAV: { section: string; routes: Route[] }[] = [
  { section: 'Monitor', routes: ['quota'] },
  { section: 'Manage', routes: ['accounts', 'keys', 'config'] },
]

const routeFromHash = (): Route => {
  const r = location.hash.replace(/^#\/?/, '')
  return r in ROUTES ? (r as Route) : 'quota'
}

function useRoute(): Route {
  const [route, setRoute] = useState(routeFromHash)
  useEffect(() => {
    const onHash = () => setRoute(routeFromHash())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  return route
}

function Sidebar({ route }: { route: Route }) {
  const { files, fatal, loaded } = useStore()
  const on = files.filter((f) => !f.disabled).length
  const counts: Partial<Record<Route, ReactNode>> = { accounts: loaded ? `${on}/${files.length}` : null }
  const online = loaded && !fatal
  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-mark">
          <Zap size={13} strokeWidth={2.5} />
        </span>
        CLIProxy
      </div>
      {NAV.map((group) => (
        <nav key={group.section} aria-label={group.section}>
          <div className="nav-section eyebrow">{group.section}</div>
          {group.routes.map((r) => {
            const { label, icon: Icon } = ROUTES[r]
            return (
              <a key={r} href={`#/${r}`} className="nav-link" aria-current={route === r ? 'page' : undefined}>
                <Icon size={15} strokeWidth={1.75} />
                {label}
                {counts[r] && <span className="nav-count">{counts[r]}</span>}
              </a>
            )
          })}
        </nav>
      ))}
      <div className="sidebar-foot mono faint">
        <span className={`dot ${online ? 'good' : loaded ? 'bad' : ''}`} />
        {online ? 'proxy online' : loaded ? 'proxy unreachable' : 'connecting…'}
        {proxyVersion && <span style={{ marginLeft: 'auto' }}>v{proxyVersion}</span>}
      </div>
    </aside>
  )
}

export default function App() {
  const route = useRoute()
  const { fatal } = useStore()
  const Page = ROUTES[route].page
  return (
    <div className="shell">
      <Sidebar route={route} />
      <main className="content">
        {fatal ? (
          <div className="page">
            <div className="empty">
              <div className="error-text">Can’t reach the proxy</div>
              <div className="mono">{fatal.message}</div>
            </div>
          </div>
        ) : (
          <Page />
        )}
      </main>
      <Toaster />
    </div>
  )
}
