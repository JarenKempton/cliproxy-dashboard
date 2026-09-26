// Names machines from Tailscale: every tailnet IP maps to its device's
// MagicDNS name (e.g. 100.118.213.21 → "goliath-omarchy").

import { existsSync } from 'node:fs'
import { hostname } from 'node:os'
import type { Db } from './db/client'
import { tailnetDevices } from './db/schema'

const REFRESH_EVERY_MS = 5 * 60e3
const LOOPBACK = ['127.0.0.1', '::1']

// launchd starts us with a minimal PATH, so look in the usual install spots.
const CLI_CANDIDATES = [
  process.env.TAILSCALE_BIN,
  '/opt/homebrew/bin/tailscale',
  '/usr/local/bin/tailscale',
  '/usr/bin/tailscale',
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
].filter(Boolean) as string[]

type StatusNode = { DNSName?: string; HostName?: string; OS?: string; TailscaleIPs?: string[]; Online?: boolean }
type Status = { Self?: StatusNode; Peer?: Record<string, StatusNode> }

export class Tailnet {
  syncedAt: number | null = null
  lastError: string | null = null

  constructor(private db: Db) {}

  start() {
    void this.sync()
    setInterval(() => this.sync(), REFRESH_EVERY_MS)
  }

  async sync() {
    const status = await readStatus().catch((err: Error) => {
      this.lastError = err.message
      return null
    })
    const now = new Date()
    const rows: (typeof tailnetDevices.$inferInsert)[] = []

    const add = (node: StatusNode, isSelf: boolean) => {
      const name = nameOf(node)
      for (const ip of node.TailscaleIPs ?? []) {
        rows.push({ ip, name, dnsName: node.DNSName ?? null, os: node.OS ?? null, isSelf, online: node.Online ?? null, syncedAt: now })
      }
    }
    if (status?.Self) add(status.Self, true)
    for (const peer of Object.values(status?.Peer ?? {})) add(peer, false)

    // Local requests get this machine's name even without Tailscale.
    const selfName = status?.Self ? nameOf(status.Self) : hostname().split('.')[0]
    for (const ip of LOOPBACK) rows.push({ ip, name: selfName, dnsName: null, os: null, isSelf: true, online: true, syncedAt: now })

    this.db.transaction((tx) => {
      tx.delete(tailnetDevices).run()
      if (rows.length) tx.insert(tailnetDevices).values(rows).run()
    })
    if (status) {
      this.syncedAt = now.getTime()
      this.lastError = null
    }
  }
}

// iOS devices report HostName "localhost", so prefer the MagicDNS label.
function nameOf(node: StatusNode) {
  return node.DNSName?.split('.')[0] || node.HostName || 'unknown'
}

async function readStatus(): Promise<Status> {
  const cli = CLI_CANDIDATES.find((path) => existsSync(path))
  if (!cli) throw new Error('tailscale CLI not found')
  const proc = Bun.spawn([cli, 'status', '--json'], { stdout: 'pipe', stderr: 'ignore' })
  const text = await new Response(proc.stdout).text()
  if ((await proc.exited) !== 0) throw new Error('tailscale status failed')
  return JSON.parse(text)
}
