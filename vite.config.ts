import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv, type Plugin } from 'vite'

// Dev-only bridge to the live CLIProxyAPI management API.
//
// - The management key lives in .env.local (CPA_MANAGEMENT_KEY, no VITE_ prefix)
//   and is injected here, server-side, so it never reaches the browser bundle.
// - Only GET requests are forwarded unless CPA_ALLOW_WRITES=1, with two narrow
//   exceptions the dashboard needs (see ALLOWED_WRITES).
// - Endpoints with side effects on GET are always blocked.
// - After a single 401 the bridge stops forwarding until the dev server is
//   restarted: CLIProxyAPI bans an IP for ~30 min after 5 failed key attempts.

const MANAGEMENT_PREFIX = '/v0/management'

// GETs that mutate state or start flows on the proxy.
const BLOCKED_PATHS = [/^\/v0\/management\/usage-queue/, /-auth-url(\?|$)/]

// Upstream usage endpoints /api-call may reach (read-only quota lookups).
const QUOTA_URLS = new Set([
  'https://api.anthropic.com/api/oauth/usage',
  'https://api.anthropic.com/api/oauth/profile',
  'https://chatgpt.com/backend-api/wham/usage',
])

type Body = Record<string, unknown>

// Writes allowed even in read-only mode, each validated by its body.
const ALLOWED_WRITES: { method: string; path: string; check: (body: Body) => boolean }[] = [
  {
    method: 'POST',
    path: '/api-call',
    check: (b) => String(b.method).toUpperCase() === 'GET' && QUOTA_URLS.has(String(b.url)) && !b.data,
  },
  {
    method: 'PATCH',
    path: '/auth-files/status',
    check: (b) => typeof b.name === 'string' && typeof b.disabled === 'boolean' && Object.keys(b).length === 2,
  },
]

function readBody(req: import('node:http').IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => (data += chunk))
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

function managementGuard(env: Record<string, string>, target: string, state: { locked: boolean }): Plugin {
  const allowWrites = env.CPA_ALLOW_WRITES === '1'
  return {
    name: 'cpa-management-guard',
    configureServer(server) {
      server.middlewares.use(MANAGEMENT_PREFIX, async (req, res, next) => {
        const path = req.url ?? ''
        const url = MANAGEMENT_PREFIX + path
        const reply = (status: number, body: string) => {
          res.statusCode = status
          res.setHeader('Content-Type', 'application/json')
          res.end(body)
        }
        const deny = (status: number, error: string) => reply(status, JSON.stringify({ error, guard: true }))
        if (!env.CPA_MANAGEMENT_KEY) return deny(503, 'CPA_MANAGEMENT_KEY is not set in .env.local')
        if (state.locked) return deny(423, 'Bridge locked after a 401. Fix the key in .env.local and restart the dev server.')
        if (BLOCKED_PATHS.some((re) => re.test(url))) return deny(403, 'Blocked by dev guard: this endpoint has side effects')
        if (req.method === 'GET' || allowWrites) return next()

        const rule = ALLOWED_WRITES.find((r) => r.method === req.method && r.path === path)
        if (!rule) return deny(403, 'Blocked by dev guard: read-only mode (set CPA_ALLOW_WRITES=1 to allow)')
        let body: Body
        try {
          body = JSON.parse(await readBody(req))
        } catch {
          return deny(400, 'Blocked by dev guard: invalid JSON body')
        }
        if (!rule.check(body)) return deny(403, `Blocked by dev guard: request to ${path} is outside the allowlist`)

        // The body stream is consumed, so forward this one ourselves.
        try {
          const upstream = await fetch(target + url, {
            method: req.method,
            headers: { Authorization: `Bearer ${env.CPA_MANAGEMENT_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          })
          if (upstream.status === 401) state.locked = true
          reply(upstream.status, await upstream.text())
        } catch (err) {
          deny(502, `Proxy unreachable: ${(err as Error).message}`)
        }
      })
    },
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'CPA_')
  const target = env.CPA_TARGET || 'http://localhost:8317'
  const state = { locked: false }

  return {
    plugins: [react(), managementGuard(env, target, state)],
    server: {
      // Loopback only: the bridge carries the management key, so it must never
      // be reachable from the network.
      host: '127.0.0.1',
      port: 5173,
      strictPort: true,
      // Extra hostnames a loopback reverse proxy may forward under,
      // e.g. a `tailscale serve` name (tailnet-only).
      allowedHosts: (env.CPA_ALLOWED_HOSTS ?? '').split(',').map((h) => h.trim()).filter(Boolean),
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
