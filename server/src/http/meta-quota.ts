// Muse Code (Meta) quota. Meta has no usage endpoint: the allowance comes back
// from the API-key mint, which only accepts the account's login (dca:) token.
// The proxy's /api-call substitutes the minted API key instead, so the bridge
// reads the token from the auth file and calls Meta itself. Minting returns
// the account's existing key; only the plan and usage leave this file.

export const META_MINT_URL = 'https://api.meta.ai/muse-code/key'

type ManagementGet = (path: string) => Promise<Response>

const reply = (status_code: number, body: unknown, header: Record<string, string[]> = {}) =>
  JSON.stringify({ status_code, header, body })

function loginToken(file: Record<string, unknown>) {
  const token = [file.dca_token, file.access_token].find((t) => typeof t === 'string' && t.startsWith('dca:'))
  return token as string | undefined
}

export async function metaQuota(get: ManagementGet, authIndex: string): Promise<string> {
  const list = (await (await get('/auth-files')).json()) as { files?: { name: string; auth_index: string }[] }
  const name = list.files?.find((f) => f.auth_index === authIndex)?.name
  if (!name) return reply(404, { error: 'Meta account not found' })

  const download = await get(`/auth-files/download?${new URLSearchParams({ name })}`)
  if (!download.ok) return reply(download.status, { error: `Couldn't read the Meta auth file (HTTP ${download.status})` })
  const token = loginToken((await download.json()) as Record<string, unknown>)
  if (!token) return reply(400, { error: 'This Meta account has no login token; log in with -meta-login' })

  const res = await fetch(META_MINT_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'muse-code/1.4.13' },
    body: JSON.stringify({ dca_token: token }),
  })
  const retryAfter = res.headers.get('retry-after')
  const header: Record<string, string[]> = retryAfter ? { 'Retry-After': [retryAfter] } : {}
  const body = (await res.json().catch(() => null)) as { subs_tier_name?: string; subs_usage?: unknown; detail?: string } | null
  if (!res.ok) return reply(res.status, { detail: body?.detail ?? `Meta returned ${res.status}` }, header)
  return reply(res.status, { subs_tier_name: body?.subs_tier_name, subs_usage: body?.subs_usage }, header)
}
