// Usage server: collects CLIProxyAPI usage records into SQLite and serves
// them to the dashboard.

import { CliproxyCollector } from './collector/cliproxy'
import { openDb } from './db/client'
import { env } from './env'
import { Hono } from 'hono'
import { serveStatic } from 'hono/bun'
import { existsSync } from 'node:fs'
import { createApp } from './http/app'
import { historyEnv } from './history/env'
import { HistorySearch, jevFromEnv } from './history/search'
import { historyPushApp, historySearchApp } from './http/history'
import { connectApp } from './http/connect'
import { MANAGEMENT_PREFIX, managementApp } from './http/management'
import { startLanListener } from './http/lan'
import { museRelay } from './http/muse-relay'
import { poolGateway, poolSettings } from './http/sharing'
import { SharingStore } from './sharing'
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
const pool = new SharingStore(db, env.proxyUrl, env.managementKey)
const connect = {
  db,
  keys,
  canMint: true,
  proxyPort: env.proxyPort,
  lanPort: env.lanPort,
  tailnetDashboardPort: env.tailnetDashboardPort,
  tailnetDashboardUrl: env.tailnetDashboardUrl,
  tailnetProxyUrl: env.tailnetProxyUrl,
}

// The dashboard, its /api and /connect, and the management bridge.
const app = new Hono()
app.route('/', createApp(db, collector, prices, tailnet))
app.route('/', poolSettings(pool, [env.tailnetDashboardUrl, env.tailnetProxyUrl].filter((u): u is string => !!u).map((u) => new URL(u).hostname)))
app.route('/', poolGateway(env.proxyUrl, pool))
app.route('/connect', connectApp(connect))
app.route('/history', historyPushApp(db, keys))
app.route('/history', historySearchApp(new HistorySearch(historyEnv.dbPath, jevFromEnv(historyEnv.typesafeApiKey))))
app.route(MANAGEMENT_PREFIX, managementApp(env.proxyUrl, env.managementKey, env.allowWrites))
app.route('/', museRelay(env.proxyUrl, env.managementKey, keys))
if (existsSync(env.staticDir)) {
  app.use('*', serveStatic({ root: env.staticDir }))
  app.get('*', serveStatic({ path: `${env.staticDir}/index.html` }))
}
Bun.serve({ hostname: env.host, port: env.port, fetch: app.fetch })
console.log(`[server] listening on http://${env.host}:${env.port}`)

if (env.lanPort) startLanListener(db, prices, keys, connect, env.proxyUrl, env.managementKey, pool)
