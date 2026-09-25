// Client for the CLIProxyAPI management API.
// In dev, requests go through the Vite bridge (see vite.config.ts), which adds
// the management key and only lets the dashboard's own writes through.

const BASE = '/v0/management'

export class ApiError extends Error {
  status: number
  guard: boolean
  constructor(status: number, message: string, guard: boolean) {
    super(message)
    this.status = status
    this.guard = guard
  }
}

// Last proxy version seen in a response header.
export let proxyVersion: string | null = null

type Options = { body?: unknown; raw?: string; contentType?: string }

async function request(method: string, path: string, opts: Options = {}): Promise<unknown> {
  const body = opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body))
  const res = await fetch(BASE + path, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': opts.contentType ?? 'application/json' },
    body,
  })
  proxyVersion = res.headers.get('x-cpa-version') ?? proxyVersion
  const text = await res.text()
  let parsed: unknown = text
  try {
    parsed = JSON.parse(text)
  } catch {
    // plain-text response, keep as string
  }
  if (!res.ok) {
    const err = parsed as { error?: string; message?: string; guard?: boolean }
    throw new ApiError(res.status, err?.error ?? err?.message ?? `HTTP ${res.status}`, Boolean(err?.guard))
  }
  return parsed
}

const q = (params: Record<string, string>) => `?${new URLSearchParams(params)}`

// --- Accounts ---------------------------------------------------------------

// Mirrors the fields of GET /auth-files the dashboard uses.
// Never display `account`: for API-key credentials it is the key itself.
export type AuthFile = {
  name: string
  auth_index: string
  provider?: string
  type?: string
  email?: string
  label?: string
  disabled?: boolean
  unavailable?: boolean
  status?: string
  status_message?: string
  created_at?: string
  last_refresh?: string
  success?: number
  failed?: number
  cooldowns?: { scope: string; reason: string; retry_at: string; model_key?: string }[]
  id_token?: { chatgpt_account_id?: string; plan_type?: string }
}

export async function listAuthFiles(): Promise<AuthFile[]> {
  const data = (await request('GET', '/auth-files')) as { files?: AuthFile[] }
  return data.files ?? []
}

export const setDisabled = (name: string, disabled: boolean) =>
  request('PATCH', '/auth-files/status', { body: { name, disabled } })

export const deleteAuthFile = (name: string) => request('DELETE', `/auth-files${q({ name })}`)

// Sends a GET to an upstream provider using the credential's own token.
export async function upstreamGet(authIndex: string, url: string, header: Record<string, string>): Promise<unknown> {
  const res = (await request('POST', '/api-call', { body: { authIndex, method: 'GET', url, header } })) as {
    status_code: number
    body: unknown
  }
  let body = res.body
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body)
    } catch {
      // keep as string
    }
  }
  if (res.status_code < 200 || res.status_code >= 300) {
    throw new ApiError(res.status_code, `Upstream returned ${res.status_code}`, false)
  }
  return body
}

// --- Login (OAuth) -----------------------------------------------------------

export type LoginProvider = 'anthropic' | 'codex'

export async function startLogin(provider: LoginProvider): Promise<{ url: string; state: string }> {
  return (await request('GET', `/${provider}-auth-url${q({ is_webui: 'true' })}`)) as { url: string; state: string }
}

export async function loginStatus(state: string): Promise<{ status: 'ok' | 'wait' | 'error'; error?: string }> {
  return (await request('GET', `/get-auth-status${q({ state })}`)) as { status: 'ok' | 'wait' | 'error'; error?: string }
}

export const cancelLogin = (state: string) => request('DELETE', `/oauth-session${q({ state })}`)

export const submitLoginCallback = (provider: LoginProvider, redirectUrl: string) =>
  request('POST', '/oauth-callback', { body: { provider, redirect_url: redirectUrl } })

// --- Config ------------------------------------------------------------------

export async function getConfigYaml(): Promise<string> {
  return String(await request('GET', '/config.yaml'))
}

export const putConfigYaml = (yaml: string) =>
  request('PUT', '/config.yaml', { raw: yaml, contentType: 'application/yaml' })

// --- Proxy API keys ----------------------------------------------------------

export async function listApiKeys(): Promise<string[]> {
  const data = (await request('GET', '/api-keys')) as { 'api-keys'?: string[] }
  return data['api-keys'] ?? []
}

export const putApiKeys = (keys: string[]) => request('PUT', '/api-keys', { body: keys })
