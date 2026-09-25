import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv, type Plugin } from 'vite'

// Dev-only bridge to the live CLIProxyAPI management API.
//
// - The management key lives in .env.local (CPA_MANAGEMENT_KEY, no VITE_ prefix)
//   and is injected here, server-side, so it never reaches the browser bundle.
// - Only GET requests are forwarded unless CPA_ALLOW_WRITES=1.
// - Endpoints with side effects on GET are always blocked.
// - After a single 401 the bridge stops forwarding until the dev server is
//   restarted: CLIProxyAPI bans an IP for ~30 min after 5 failed key attempts.

const MANAGEMENT_PREFIX = '/v0/management'

// GETs that mutate state or start flows on the proxy.
const BLOCKED_PATHS = [/^\/v0\/management\/usage-queue/, /-auth-url(\?|$)/]

function managementGuard(env: Record<string, string>, state: { locked: boolean }): Plugin {
  const allowWrites = env.CPA_ALLOW_WRITES === '1'
  return {
    name: 'cpa-management-guard',
    configureServer(server) {
      server.middlewares.use(MANAGEMENT_PREFIX, (req, res, next) => {
        const url = MANAGEMENT_PREFIX + (req.url ?? '')
        const deny = (status: number, error: string) => {
          res.statusCode = status
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ error, guard: true }))
        }
        if (!env.CPA_MANAGEMENT_KEY) return deny(503, 'CPA_MANAGEMENT_KEY is not set in .env.local')
        if (state.locked) return deny(423, 'Bridge locked after a 401. Fix the key in .env.local and restart the dev server.')
        if (BLOCKED_PATHS.some((re) => re.test(url))) return deny(403, 'Blocked by dev guard: this endpoint has side effects')
        if (req.method !== 'GET' && !allowWrites) return deny(403, 'Blocked by dev guard: read-only mode (set CPA_ALLOW_WRITES=1 to allow)')
        next()
      })
    },
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'CPA_')
  const target = env.CPA_TARGET || 'http://localhost:8317'
  const state = { locked: false }

  return {
    plugins: [react(), managementGuard(env, state)],
    server: {
      proxy: {
        [MANAGEMENT_PREFIX]: {
          target,
          changeOrigin: true,
          headers: { Authorization: `Bearer ${env.CPA_MANAGEMENT_KEY ?? ''}` },
          configure(proxy) {
            proxy.on('proxyRes', (res) => {
              if (res.statusCode === 401) state.locked = true
            })
          },
        },
      },
    },
  }
})
