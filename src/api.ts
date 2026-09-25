// Client for the CLIProxyAPI management API.
// In dev, requests go through the Vite bridge (see vite.config.ts), which adds
// the management key and only lets a small allowlist of writes through.

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

async function request(method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(BASE + path, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let parsed: unknown = text
  try {
    parsed = JSON.parse(text)
  } catch {
    // plain-text response, keep as string
  }
  if (!res.ok) {
    const err = parsed as { error?: string; guard?: boolean }
    throw new ApiError(res.status, err?.error ?? `HTTP ${res.status}`, Boolean(err?.guard))
  }
  return parsed
}

export const get = (path: string) => request('GET', path)

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
  cooldowns?: { scope: string; reason: string; retry_at: string; model_key?: string }[]
  id_token?: { chatgpt_account_id?: string; plan_type?: string }
}

export async function listAuthFiles(): Promise<AuthFile[]> {
  const data = (await get('/auth-files')) as { files?: AuthFile[] }
  return data.files ?? []
}

export function setDisabled(name: string, disabled: boolean) {
  return request('PATCH', '/auth-files/status', { name, disabled })
}

// Sends a GET to an upstream provider using the credential's own token.
export async function upstreamGet(authIndex: string, url: string, header: Record<string, string>): Promise<unknown> {
  const res = (await request('POST', '/api-call', { authIndex, method: 'GET', url, header })) as {
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
