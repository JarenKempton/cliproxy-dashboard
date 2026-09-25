// Read-only client for the CLIProxyAPI management API.
// In dev, requests go through the Vite bridge (see vite.config.ts), which adds
// the management key and enforces read-only mode.

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

export async function get(path: string): Promise<unknown> {
  const res = await fetch(BASE + path)
  const text = await res.text()
  let body: unknown = text
  try {
    body = JSON.parse(text)
  } catch {
    // plain-text response, keep as string
  }
  if (!res.ok) {
    const err = body as { error?: string; guard?: boolean }
    throw new ApiError(res.status, err?.error ?? `HTTP ${res.status}`, Boolean(err?.guard))
  }
  return body
}
