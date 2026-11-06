// Becoming a peer with one link instead of hand-edited proxy config.
//
// The lender mints a one-time code for a new peer's pool token; the link is
// <lender dashboard>/pool/invite/<code>. The borrower's dashboard claims it
// once and adds the lender's gateway to its own proxy as low-priority
// upstreams, so the token never passes through chat or shell history.

import { randomInt } from 'node:crypto'

const CODE_TTL_MS = 15 * 60e3
const ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789'
const INVITE = /^(.*)\/pool\/invite\/([A-Z0-9-]+)\/?$/i

export type InviteClaim = { owner: string; token: string; models: string[] }
type Management = (path: string, init?: { method: string; body?: unknown }) => Promise<Response>

export class Invites {
  private codes = new Map<string, { token: string; expires: number }>()

  mint(token: string, now = Date.now()) {
    const part = () => Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('')
    const code = `${part()}-${part()}`
    this.codes.set(code, { token, expires: now + CODE_TTL_MS })
    return { code, expires: now + CODE_TTL_MS }
  }

  // The token, once; null for an unknown, used or expired code.
  claim(code: string, now = Date.now()) {
    const entry = this.codes.get(code.toUpperCase())
    this.codes.delete(code.toUpperCase())
    return entry && entry.expires > now ? entry.token : null
  }
}

type Entry = Record<string, unknown> & { 'api-key'?: string; 'base-url'?: string }

// Claims an invite link and adds the lender's gateway to this proxy's config
// as fallback upstreams for Claude, Codex and (when the lender has any) Grok
// and Muse models. Entries already present are left alone.
export async function joinPeer(link: string, management: Management, backup: () => Promise<void>) {
  const match = link.trim().match(INVITE)
  if (!match) throw new Error('That isn’t an invite link')
  const gateway = new URL(match[1]).origin
  const res = await fetch(link.trim(), { signal: AbortSignal.timeout(15e3) })
  if (!res.ok) throw new Error(res.status === 404 ? 'That invite was already used or has expired' : `The lender refused the invite (HTTP ${res.status})`)
  const { owner, token, models } = (await res.json()) as InviteClaim

  const fallback = { priority: -1, 'disable-cooling': true }
  const additions: [string, Entry][] = [
    ['claude-api-key', { 'api-key': token, 'base-url': `${gateway}/pool`, ...fallback }],
    ['codex-api-key', { 'api-key': token, 'base-url': `${gateway}/pool/v1`, ...fallback }],
  ]
  if (models.length)
    additions.push([
      'openai-compatibility',
      {
        name: `pool-${(owner || new URL(gateway).hostname).toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
        'base-url': `${gateway}/pool/v1`,
        'api-key-entries': [{ 'api-key': token }],
        models: models.map((name) => ({ name, alias: name })),
        ...fallback,
      },
    ])

  await backup()
  for (const [list, entry] of additions) {
    const current = await management(`/${list}`)
    if (!current.ok) throw new Error(`The proxy refused to list ${list} (HTTP ${current.status})`)
    const entries = (((await current.json()) as Record<string, Entry[] | null>)[list] ?? []) as Entry[]
    if (entries.some((e) => e['base-url'] === entry['base-url'])) continue
    const put = await management(`/${list}`, { method: 'PUT', body: [...entries, entry] })
    if (!put.ok) throw new Error(`The proxy refused the new ${list} entry (HTTP ${put.status})`)
  }
  return { owner, gateway }
}
