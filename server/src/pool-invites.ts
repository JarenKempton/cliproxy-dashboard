import { randomInt } from 'node:crypto'
import type { BorrowedUpstreams } from './borrowed-upstreams'

const CODE_TTL_MS = 15 * 60e3
const ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789'
const INVITE = /^(.*)\/pool\/invite\/([A-Z0-9-]+)\/?$/i

export type InviteClaim = { owner: string; token: string; models: string[] }

export class Invites {
  private codes = new Map<string, { token: string; expires: number }>()

  mint(token: string, now = Date.now()) {
    for (const [code, entry] of this.codes) if (entry.expires <= now) this.codes.delete(code)
    const part = () => Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('')
    const code = `${part()}-${part()}`
    this.codes.set(code, { token, expires: now + CODE_TTL_MS })
    return { code, expires: now + CODE_TTL_MS }
  }

  claim(code: string, now = Date.now()) {
    const entry = this.codes.get(code.toUpperCase())
    this.codes.delete(code.toUpperCase())
    return entry && entry.expires > now ? entry.token : null
  }
}

export async function joinPeer(link: string, upstreams: BorrowedUpstreams) {
  const match = link.trim().match(INVITE)
  if (!match) throw new Error('That isn’t an invite link')
  const gateway = new URL(match[1]).origin
  return upstreams.join(gateway, async () => {
    const response = await fetch(link.trim(), { signal: AbortSignal.timeout(15e3) })
    if (!response.ok) throw new Error(response.status === 404 ? 'That invite was already used or has expired' : `The lender refused the invite (HTTP ${response.status})`)
    return await response.json() as InviteClaim
  })
}
