// Bridge to the live CLIProxyAPI management API, mounted at /v0/management.
//
// - The management key stays in the server's environment (CPA_MANAGEMENT_KEY)
//   and is injected here, so it never reaches the browser bundle.
// - GETs pass through, except ones with side effects. Writes must match
//   WRITE_RULES (or CPA_ALLOW_WRITES=1): the dashboard's own actions only.
// - Every write that touches config.yaml snapshots it to .backups/ first.
// - After a single 401 the bridge stops forwarding until the server is
//   restarted: CLIProxyAPI bans an IP for ~30 min after 5 failed key attempts.

import { Hono } from 'hono'
import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { META_MINT_URL, metaQuota } from './meta-quota'

export const MANAGEMENT_PREFIX = '/v0/management'
const BACKUP_DIR = '.backups'
const MAX_BACKUPS = 50

// GETs that mutate state or start flows for providers we don't use.
const BLOCKED_GETS = [/^\/usage-queue/, /^\/(?!anthropic-auth-url|codex-auth-url|meta-auth-url)[a-z-]+-auth-url/]

// Upstream usage endpoints /api-call may reach (read-only quota lookups).
const QUOTA_URLS = new Set([
  'https://api.anthropic.com/api/oauth/usage',
  'https://api.anthropic.com/api/oauth/profile',
  'https://chatgpt.com/backend-api/wham/usage',
  'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits',
])

// The one upstream write the dashboard makes: spending a Codex reset credit.
const CODEX_RESET_URL = 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume'

function isCodexReset(v: Record<string, unknown>) {
  if (String(v.method).toUpperCase() !== 'POST' || v.url !== CODEX_RESET_URL) return false
  const data = json(String(v.data ?? ''))
  return !!data && typeof data.redeem_request_id === 'string' && Object.keys(data).length === 1
}

// Answered by the bridge itself (see meta-quota.ts), never forwarded.
const isMetaQuota = (v: Record<string, unknown>) =>
  String(v.method).toUpperCase() === 'POST' && v.url === META_MINT_URL && !v.data

// Scalar settings, set with a `{ "value": ... }` body.
const SETTINGS =
  'debug|logging-to-file|request-log|request-retry|max-retry-interval|proxy-url|routing/strategy|' +
  'quota-exceeded/switch-project|quota-exceeded/switch-preview-model|logs-max-total-size-mb|' +
  'error-logs-max-files|usage-statistics-enabled|force-model-prefix'

type Rule = {
  methods: string[]
  path: RegExp
  check: (body: string, query: URLSearchParams) => boolean
  // Whether the write persists to config.yaml (and so gets a backup first).
  touchesConfig?: boolean
}

const json = (body: string): Record<string, unknown> | null => {
  try {
    const v = JSON.parse(body)
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null
  } catch {
    return null
  }
}

const WRITE_RULES: Rule[] = [
  {
    methods: ['POST'],
    path: /^\/api-call$/,
    check: (b) => {
      const v = json(b)
      if (!v) return false
      return (String(v.method).toUpperCase() === 'GET' && QUOTA_URLS.has(String(v.url)) && !v.data) || isCodexReset(v) || isMetaQuota(v)
    },
  },
  {
    methods: ['PATCH'],
    path: /^\/auth-files\/status$/,
    check: (b) => {
      const v = json(b)
      return !!v && typeof v.name === 'string' && typeof v.disabled === 'boolean' && Object.keys(v).length === 2
    },
  },
  // Remove one account; never the delete-everything variant.
  { methods: ['DELETE'], path: /^\/auth-files$/, check: (_, q) => !!q.get('name') && !q.has('all') },
  { methods: ['DELETE'], path: /^\/oauth-session$/, check: (_, q) => !!q.get('state') },
  {
    methods: ['POST'],
    path: /^\/oauth-callback$/,
    check: (b) => {
      const v = json(b)
      return !!v && ['anthropic', 'codex'].includes(String(v.provider)) && typeof v.redirect_url === 'string'
    },
  },
  { methods: ['PUT'], path: /^\/config\.yaml$/, check: (b) => b.length > 0, touchesConfig: true },
  {
    methods: ['PUT', 'PATCH'],
    path: new RegExp(`^/(${SETTINGS})$`),
    check: (b) => {
      const v = json(b)
      return !!v && 'value' in v && Object.keys(v).length === 1
    },
    touchesConfig: true,
  },
  { methods: ['DELETE'], path: /^\/proxy-url$/, check: () => true, touchesConfig: true },
  { methods: ['PUT', 'PATCH'], path: /^\/api-keys$/, check: (b) => b.length > 0, touchesConfig: true },
  {
    methods: ['DELETE'],
    path: /^\/api-keys$/,
    check: (_, q) => q.has('value') || q.has('index'),
    touchesConfig: true,
  },
]

// Quota lookups are cached here, shared by every open tab, so reloads and
// multiple windows don't trip the upstream usage endpoints' rate limits. A
// failed refresh (e.g. 429) falls back to the last good response.
const QUOTA_TTL_MS = 90e3
// Persisted so a restart doesn't forget a provider's Retry-After.
const QUOTA_STATE_FILE = `${BACKUP_DIR}/quota-state.json`
const quotaCache = new Map<string, { at: number; body: string }>()
const quotaBlocked = new Map<string, { until: number; body: string }>()
try {
  const saved = JSON.parse(readFileSync(QUOTA_STATE_FILE, 'utf8'))
  for (const [k, v] of saved.cache ?? []) quotaCache.set(k, v)
  for (const [k, v] of saved.blocked ?? []) quotaBlocked.set(k, v)
} catch {
  // first run
}
function saveQuotaState() {
  mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o700 })
  writeFileSync(QUOTA_STATE_FILE, JSON.stringify({ cache: [...quotaCache], blocked: [...quotaBlocked] }), { mode: 0o600 })
}

// config.yaml holds secrets: backups are owner-only and git-ignored.
function saveBackup(yaml: string) {
  mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o700 })
  const file = `${BACKUP_DIR}/config-${new Date().toISOString().replace(/[:.]/g, '-')}.yaml`
  writeFileSync(file, yaml, { mode: 0o600 })
  chmodSync(file, 0o600)
  const all = readdirSync(BACKUP_DIR).filter((f) => f.startsWith('config-')).sort()
  for (const old of all.slice(0, Math.max(all.length - MAX_BACKUPS, 0))) rmSync(`${BACKUP_DIR}/${old}`)
}

export function managementApp(target: string, managementKey: string, allowWrites: boolean) {
  const auth = { Authorization: `Bearer ${managementKey}` }
  const state = { locked: false }
  const managementGet = async (path: string) => {
    const res = await fetch(`${target}${MANAGEMENT_PREFIX}${path}`, { headers: auth })
    if (res.status === 401) state.locked = true
    return res
  }
  const app = new Hono()

  app.all('*', async (c) => {
    const url = new URL(c.req.url)
    const pathname = url.pathname.slice(MANAGEMENT_PREFIX.length) || '/'
    const method = c.req.method
    const reply = (status: number, body: string, type = 'application/json') =>
      new Response(body, { status, headers: { 'Content-Type': type } })
    const deny = (status: number, error: string) => reply(status, JSON.stringify({ error, guard: true }))
    if (state.locked) return deny(423, 'Bridge locked after a 401. Fix CPA_MANAGEMENT_KEY and restart the server.')

    const forward = async (body?: string) => {
      const upstream = await fetch(`${target}${MANAGEMENT_PREFIX}${pathname}${url.search}`, {
        method,
        headers: { ...auth, 'Content-Type': c.req.header('content-type') ?? 'application/json' },
        body: body || undefined,
      })
      if (upstream.status === 401) state.locked = true
      return upstream
    }

    try {
      if (method === 'GET') {
        if (BLOCKED_GETS.some((re) => re.test(pathname))) return deny(403, 'Blocked by guard: this endpoint has side effects')
        const upstream = await forward()
        return reply(upstream.status, await upstream.text(), upstream.headers.get('content-type') ?? 'application/json')
      }

      const body = await c.req.text()
      const rule = WRITE_RULES.find((r) => r.methods.includes(method) && r.path.test(pathname))
      if (!allowWrites && !rule) return deny(403, `Blocked by guard: ${method} ${pathname} is not allowlisted`)
      if (!allowWrites && !rule!.check(body, url.searchParams)) return deny(403, `Blocked by guard: request to ${pathname} is outside the allowlist`)

      let cacheKey: string | null = null
      const apiCall = pathname === '/api-call' ? json(body)! : null
      // A reset changes that account's quota: forget its cached readings.
      if (apiCall && isCodexReset(apiCall)) {
        for (const k of [...quotaCache.keys(), ...quotaBlocked.keys()]) {
          if (k.startsWith(`${apiCall.authIndex ?? apiCall.auth_index}|`)) {
            quotaCache.delete(k)
            quotaBlocked.delete(k)
          }
        }
      } else if (apiCall) {
        cacheKey = `${apiCall.authIndex ?? apiCall.auth_index}|${apiCall.url}`
        const hit = quotaCache.get(cacheKey)
        if (hit && Date.now() - hit.at < QUOTA_TTL_MS) return reply(200, hit.body)
        const blocked = quotaBlocked.get(cacheKey)
        if (blocked && blocked.until > Date.now()) {
          // Replay the 429 with the time actually left, not the original wait.
          const replay = json(blocked.body) ?? {}
          const left = String(Math.ceil((blocked.until - Date.now()) / 1000))
          const header = Object.fromEntries(
            Object.entries((replay.header ?? {}) as Record<string, string[]>).filter(([k]) => k.toLowerCase() !== 'retry-after'),
          )
          return reply(200, JSON.stringify({ ...replay, header: { ...header, 'Retry-After': [left] } }))
        }
      }

      if (rule?.touchesConfig || allowWrites) {
        const current = await managementGet('/config.yaml')
        if (!current.ok) return deny(502, `Couldn't back up config.yaml before writing (HTTP ${current.status})`)
        saveBackup(await current.text())
      }
      const upstream = apiCall && isMetaQuota(apiCall)
        ? new Response(await metaQuota(managementGet, String(apiCall.authIndex ?? apiCall.auth_index)), { headers: { 'Content-Type': 'application/json' } })
        : await forward(body)
      const text = await upstream.text()
      if (cacheKey && upstream.ok) {
        const status = (json(text)?.status_code as number) ?? 0
        if (status >= 200 && status < 300) quotaCache.set(cacheKey, { at: Date.now(), body: text })
        else {
          const headers = (json(text)?.header ?? {}) as Record<string, string[]>
          const retry = Number(Object.entries(headers).find(([k]) => k.toLowerCase() === 'retry-after')?.[1]?.[0])
          // Without Retry-After, back off 10 minutes anyway.
          if (status === 429) quotaBlocked.set(cacheKey, { until: Date.now() + (Number.isFinite(retry) ? retry : 600) * 1000, body: text })
        }
        saveQuotaState()
      }
      return reply(upstream.status, text, upstream.headers.get('content-type') ?? 'application/json')
    } catch (err) {
      return deny(502, `Proxy unreachable: ${(err as Error).message}`)
    }
  })

  return app
}
