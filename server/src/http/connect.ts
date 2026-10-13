// Connecting other machines with one command:
//   curl -fsSL <origin>/connect | sh -s -- CODE
//
// The dashboard mints a one-time code for a proxy key, tools and network
// (Tailscale or local network). The script trades the code for the proxy
// address and key, so the key never appears in the command or shell history.
// Codes work once and expire after 15 minutes; claims are rate-limited.
//
// Mounted on the loopback server (reached through the dashboard) with
// minting enabled, and on the local-network listener without it.

import { eq } from 'drizzle-orm'
import { randomInt } from 'node:crypto'
import { networkInterfaces } from 'node:os'
import { Hono, type Context } from 'hono'
import { connectScript, importScript, undoScript } from '../../../src/lib/connect'
import type { Db } from '../db/client'
import { tailnetDevices } from '../db/schema'
import type { ProxyKeys } from '../proxy-keys'

const CODE_TTL_MS = 15 * 60e3
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789'
const MAX_CLAIM_FAILURES_PER_MINUTE = 20

type Tool = 'claude' | 'codex'
type Network = 'tailnet' | 'lan'

// Shared by every listener in this process, so a code minted through the
// dashboard can be claimed over the local network.
const codes = new Map<string, { url: string; key: string; tools: Tool[]; expires: number }>()
const claimFailures: number[] = []

function newCode() {
  const pick = () => Array.from({ length: 4 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('')
  return `${pick()}-${pick()}`
}

// This machine's first non-internal IPv4 address on the local network.
function lanAddress(): string | null {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('100.')) return a.address
  }
  return null
}

export type ConnectOptions = {
  db: Db
  keys: ProxyKeys
  canMint: boolean
  proxyPort: number
  lanPort: number
  tailnetDashboardPort: number
  tailnetDashboardUrl?: string
  tailnetProxyUrl?: string
}

// Where machines reach the dashboard (for the script) and the proxy (for
// their config) on each network.
export function networks(o: ConnectOptions): Record<Network, { dashboard: string; proxy: string } | null> {
  const self = o.db.select().from(tailnetDevices).where(eq(tailnetDevices.isSelf, true)).all().find((d) => d.dnsName)
  const host = self?.dnsName?.replace(/\.$/, '')
  const ip = lanAddress()
  return {
    // `tailscale serve` maps https://<host> to the proxy and :<port> to the dashboard.
    tailnet: host
      ? {
          dashboard: o.tailnetDashboardUrl ?? `https://${host}:${o.tailnetDashboardPort}`,
          proxy: o.tailnetProxyUrl ?? `https://${host}`,
        }
      : null,
    lan: ip && o.lanPort ? { dashboard: `http://${ip}:${o.lanPort}`, proxy: `http://${ip}:${o.proxyPort}` } : null,
  }
}

// The origin a request came in on, so scripts call back the same way.
function originOf(c: Context) {
  const url = new URL(c.req.url)
  const host = c.req.header('x-forwarded-host') ?? c.req.header('host') ?? url.host
  const proto = c.req.header('x-forwarded-proto') ?? (host.includes('.ts.net') ? 'https' : url.protocol.replace(':', ''))
  return `${proto}://${host}`
}

export function connectApp(o: ConnectOptions) {
  const app = new Hono()
  const script = (c: Context, body: string) => c.text(body, 200, { 'Cache-Control': 'no-store' })

  app.get('/', (c) => script(c, connectScript(originOf(c))))
  app.get('/undo', (c) => script(c, undoScript()))
  app.get('/import', (c) => script(c, importScript(originOf(c))))

  app.get('/claim/:code', (c) => {
    const now = Date.now()
    while (claimFailures.length && claimFailures[0] < now - 60e3) claimFailures.shift()
    if (claimFailures.length >= MAX_CLAIM_FAILURES_PER_MINUTE) return c.text('too many attempts\n', 429)

    const code = c.req.param('code').toUpperCase()
    const entry = codes.get(code)
    if (!entry || entry.expires < now) {
      claimFailures.push(now)
      return c.text('invalid or expired code\n', 404)
    }
    codes.delete(code)
    return c.text(`url=${entry.url}\nkey=${entry.key}\ntools=${entry.tools.join(' ')}\n`)
  })

  if (!o.canMint) return app

  app.get('/networks', (c) => c.json(networks(o)))

  // Body: { key, tools: ['claude' | 'codex'], network: 'tailnet' | 'lan' }
  app.post('/codes', async (c) => {
    const body = await c.req.json<{ key?: string; tools?: string[]; network?: string }>()
    const tools = (body.tools ?? []).filter((t): t is Tool => t === 'claude' || t === 'codex')
    const target = networks(o)[body.network as Network]
    if (!body.key || !tools.length || !target) return c.json({ error: 'key, tools and an available network are required' }, 400)

    // Only keys the proxy actually accepts can be handed out.
    o.keys.invalidate()
    if (!(await o.keys.has(body.key))) return c.json({ error: 'unknown key' }, 400)

    const now = Date.now()
    for (const [k, v] of codes) if (v.expires < now) codes.delete(k)
    const code = newCode()
    const expires = now + CODE_TTL_MS
    codes.set(code, { url: target.proxy, key: body.key, tools, expires })
    return c.json({
      code,
      expires,
      command: `curl -fsSL ${target.dashboard}/connect | sh -s -- ${code}`,
      undo: `curl -fsSL ${target.dashboard}/connect/undo | sh`,
    })
  })

  return app
}
