// Usage server: collects CLIProxyAPI usage records into SQLite and serves
// them to the dashboard.

import { CliproxyCollector } from './collector/cliproxy'
import { openDb } from './db/client'
import { env } from './env'
import { createApp } from './http/app'
import { PriceBook } from './usage/pricing'

const db = openDb(env.databasePath)

const prices = new PriceBook(db, env.priceCachePath)
await prices.start()

const collector = new CliproxyCollector(db, prices, {
  host: env.proxyHost,
  port: env.proxyPort,
  managementKey: env.managementKey,
})
collector.start()

const app = createApp(db, collector, prices)
Bun.serve({ hostname: env.host, port: env.port, fetch: app.fetch })
console.log(`[server] listening on http://${env.host}:${env.port}`)
