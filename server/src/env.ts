// Server configuration, read once from the environment.
// Bun loads .env.local from the working directory (the repo root).

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set (add it to .env.local)`)
  return value
}

const proxyUrl = process.env.CPA_TARGET ?? 'http://127.0.0.1:8317'
const proxy = new URL(proxyUrl)

export const env = {
  // CLIProxyAPI management key: authenticates the usage-queue subscription.
  managementKey: required('CPA_MANAGEMENT_KEY'),
  proxyUrl,
  proxyHost: proxy.hostname,
  proxyPort: Number(proxy.port || 8317),

  // Dashboard listener.
  host: process.env.USAGE_SERVER_HOST ?? '127.0.0.1',
  port: Number(process.env.USAGE_SERVER_PORT ?? 5174),

  // Built dashboard (`npm run build`); served when present.
  staticDir: process.env.DASHBOARD_DIST ?? 'dist',

  databasePath: process.env.USAGE_DB_PATH ?? 'data/usage.db',
  priceCachePath: process.env.PRICE_CACHE_PATH ?? 'data/litellm-prices.json',
}
