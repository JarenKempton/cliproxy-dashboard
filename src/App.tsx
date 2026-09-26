import { ChartColumn, Gauge, KeyRound, Menu, Settings2, Users } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { Logo } from './components/Logo'
import { Toaster } from './components/ui'
import { proxyVersion } from './lib/api'
import { useStore } from './lib/store'
import { AccountsPage } from './pages/AccountsPage'
import { ConfigPage } from './pages/ConfigPage'
import { KeysPage } from './pages/KeysPage'
import { QuotaPage } from './pages/QuotaPage'
import { UsagePage } from './pages/UsagePage'

const ROUTES = {
  quota: { label: 'Quota', icon: Gauge, page: QuotaPage },
  usage: { label: 'Usage', icon: ChartColumn, page: UsagePage },
  accounts: { label: 'Accounts', icon: Users, page: AccountsPage },
  keys: { label: 'API keys', icon: KeyRound, page: KeysPage },
  config: { label: 'Config', icon: Settings2, page: ConfigPage },
} as const
type Route = keyof typeof ROUTES

const NAV: { section: string; routes: Route[] }[] = [
  { section: 'Monitor', routes: ['quota', 'usage'] },
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

function Sidebar({ route, open, onClose }: { route: Route; open: boolean; onClose: () => void }) {
  const { files, fatal, loaded } = useStore()
  const on = files.filter((f) => !f.disabled).length
  const counts: Partial<Record<Route, ReactNode>> = { accounts: loaded ? `${on}/${files.length}` : null }
  const online = loaded && !fatal
  return (
    <aside className={open ? 'sidebar open' : 'sidebar'}>
      <div className="brand">
        <Logo />
        CLIProxy
      </div>
      {NAV.map((group) => (
        <nav key={group.section} aria-label={group.section}>
          <div className="nav-section eyebrow">{group.section}</div>
          {group.routes.map((r) => {
            const { label, icon: Icon } = ROUTES[r]
            return (
              <a key={r} href={`#/${r}`} className="nav-link" aria-current={route === r ? 'page' : undefined} onClick={onClose}>
                <Icon size={15} strokeWidth={1.75} />
                {label}
                {counts[r] && <span className="nav-count">{counts[r]}</span>}
              </a>
            )
          })}
        </nav>
      ))}
      {/* Quiet unless something is wrong. */}
      <div className="sidebar-foot mono faint">
        {loaded && !online ? <span className="error-text">Can’t reach the proxy</span> : proxyVersion && `CLIProxyAPI ${proxyVersion}`}
      </div>
    </aside>
  )
}

// On phones the sidebar is a slide-out menu, opened from the top bar.
function useMenu() {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])
  return [open, setOpen] as const
}

export default function App() {
  const route = useRoute()
  const { fatal } = useStore()
  const [menuOpen, setMenuOpen] = useMenu()
  const Page = ROUTES[route].page
  return (
    <div className="shell">
      <header className="topbar">
        <button className="btn btn-ghost btn-icon" aria-label="Open menu" aria-expanded={menuOpen} onClick={() => setMenuOpen(true)}>
          <Menu size={18} />
        </button>
        <Logo size={20} />
        <span className="topbar-title">{ROUTES[route].label}</span>
      </header>
      {menuOpen && <div className="scrim" onClick={() => setMenuOpen(false)} />}
      <Sidebar route={route} open={menuOpen} onClose={() => setMenuOpen(false)} />
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
