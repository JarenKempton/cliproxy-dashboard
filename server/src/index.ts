// Usage server: collects CLIProxyAPI usage records into SQLite and serves
// them to the dashboard.

import { CliproxyCollector } from './collector/cliproxy'
import { openDb } from './db/client'
import { env } from './env'
import { createApp } from './http/app'
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

const app = createApp(db, collector, prices, tailnet)
Bun.serve({ hostname: env.host, port: env.port, fetch: app.fetch })
console.log(`[server] listening on http://${env.host}:${env.port}`)
