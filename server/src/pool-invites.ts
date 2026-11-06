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
    for (const [code, entry] of this.codes) if (entry.expires <= now) this.codes.delete(code)
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
// and Muse models. An entry already pointing at this gateway gets the new
// token (and model list), so re-joining after a re-invite repairs it. The
// config is read before the one-time invite is spent.
export async function joinPeer(link: string, management: Management, backup: () => Promise<void>) {
  const match = link.trim().match(INVITE)
  if (!match) throw new Error('That isn’t an invite link')
  const gateway = new URL(match[1]).origin
  const lists = new Map<string, Entry[]>()
  for (const list of ['claude-api-key', 'codex-api-key', 'openai-compatibility']) {
    const current = await management(`/${list}`)
    if (!current.ok) throw new Error(`The proxy refused to list ${list} (HTTP ${current.status})`)
    lists.set(list, (((await current.json()) as Record<string, Entry[] | null>)[list] ?? []) as Entry[])
  }
  await backup()

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

  const written: string[] = []
  for (const [list, entry] of additions) {
    const entries = lists.get(list)!
    const at = entries.findIndex((e) => e['base-url'] === entry['base-url'])
    const next = at < 0 ? [...entries, entry] : entries.map((e, i) => (i === at ? { ...e, ...entry, priority: e.priority ?? entry.priority } : e))
    const put = await management(`/${list}`, { method: 'PUT', body: next })
    if (!put.ok) {
      const done = written.length ? ` after updating ${written.join(' and ')}` : ''
      throw new Error(`The proxy refused the ${list} entry (HTTP ${put.status})${done}. Ask for a new invite.`)
    }
    written.push(list)
  }
  return { owner, gateway }
}
