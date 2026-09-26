// Usage server: collects CLIProxyAPI usage records into SQLite and serves
// them to the dashboard.

import { CliproxyCollector } from './collector/cliproxy'
import { openDb } from './db/client'
import { env } from './env'
import { Hono } from 'hono'
import { createApp } from './http/app'
import { connectApp } from './http/connect'
import { startLanListener } from './http/lan'
import { ProxyKeys } from './proxy-keys'
import { Tailnet } from './tailnet'
import { PriceBook } from './usage/pricing'
import { repriceMissing } from './usage/reprice'

const db = openDb(env.databasePath)

const prices = new PriceBook(db, env.priceCachePath)
await prices.start()
repriceMissing(db, prices)
prices.onRefresh = () => repriceMissing(db, prices)

const collector = new CliproxyCollector(db, prices, {
  host: env.proxyHost,
  port: env.proxyPort,
  managementKey: env.managementKey,
})
collector.start()

const tailnet = new Tailnet(db)
tailnet.start()

const keys = new ProxyKeys(env.proxyUrl, env.managementKey)
const connect = {
  db,
  keys,
  canMint: true,
  proxyPort: env.proxyPort,
  lanPort: env.lanPort,
  tailnetDashboardPort: env.tailnetDashboardPort,
}

// Loopback: the dashboard's /api and /connect (proxied by the dev server).
const app = new Hono()
app.route('/', createApp(db, collector, prices, tailnet))
app.route('/connect', connectApp(connect))
Bun.serve({ hostname: env.host, port: env.port, fetch: app.fetch })
console.log(`[server] listening on http://${env.host}:${env.port}`)

if (env.lanPort) startLanListener(db, prices, keys, connect)
