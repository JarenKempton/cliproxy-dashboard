// Usage database schema.
//
// Conventions (carried over from burn):
// - Money is integer micro-dollars (1 USD = 1_000_000), never floats.
// - Unknown values are NULL, never invented as 0.
// - Each request is stored once; re-delivery is ignored via its primary key.

import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'

// One row per model request, from any source.
export const requests = sqliteTable(
  'requests',
  {
    // Stable per source, e.g. "cliproxy:<request_id>:<timestamp>".
    id: text('id').primaryKey(),
    // Where the record came from: 'cliproxy' today; 'openrouter', 'lmstudio' later.
    source: text('source').notNull(),
    occurredAt: integer('occurred_at', { mode: 'timestamp_ms' }).notNull(),
    receivedAt: integer('received_at', { mode: 'timestamp_ms' }).notNull(),

    // What was used.
    provider: text('provider').notNull(), // 'claude', 'codex', ...
    model: text('model').notNull(), // model that actually served the request
    requestedModel: text('requested_model'), // what the client asked for

    // Which upstream account served it (CLIProxyAPI auth file).
    accountRef: text('account_ref'),
    accountLabel: text('account_label'),

    // Who sent it. Machines are resolved from these via machine_identities.
    clientKeyHash: text('client_key_hash'), // sha256 prefix of the proxy key used
    clientIp: text('client_ip'), // original client IP (tailnet IP when forwarded)
    userAgent: text('user_agent'),
    tool: text('tool'), // 'claude-code', 'codex', or the user agent's product name
    sessionId: text('session_id'),
    endpoint: text('endpoint'),

    // Outcome and timing.
    failed: integer('failed', { mode: 'boolean' }).notNull(),
    statusCode: integer('status_code'),
    latencyMs: integer('latency_ms'),
    timeToFirstTokenMs: integer('ttft_ms'),

    // Tokens, split the way providers price them (no overlaps).
    inputTokens: integer('input_tokens'), // uncached input
    cacheReadTokens: integer('cache_read_tokens'),
    cacheWriteTokens: integer('cache_write_tokens'),
    outputTokens: integer('output_tokens'), // includes reasoning
    reasoningTokens: integer('reasoning_tokens'),

    // API-equivalent cost; NULL when the model has no price.
    costMicros: integer('cost_micros'),
    // What cache reads saved versus paying the full input rate.
    cacheSavingsMicros: integer('cache_savings_micros'),
    pricedAs: text('priced_as'), // price-table entry used, for auditing
  },
  (t) => [
    index('requests_occurred_at').on(t.occurredAt),
    index('requests_model').on(t.model, t.occurredAt),
    index('requests_client_key').on(t.clientKeyHash),
    index('requests_client_ip').on(t.clientIp),
  ],
)

// Named machines ("laptop", "desktop").
export const machines = sqliteTable('machines', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull().unique(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
})

// How a request is recognized as coming from a machine: the proxy key it
// used, or its client IP. A key match wins over an IP match.
export const machineIdentities = sqliteTable(
  'machine_identities',
  {
    kind: text('kind', { enum: ['key', 'ip'] }).notNull(),
    value: text('value').notNull(),
    machineId: integer('machine_id')
      .notNull()
      .references(() => machines.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.kind, t.value] })],
)

// What each proxy key is for ("Primary", "CI"). Display only: unlike a
// machine identity, a label never affects which machine requests belong to,
// so a key shared by several machines can still be labeled.
export const keyLabels = sqliteTable('key_labels', {
  keyHash: text('key_hash').primaryKey(),
  label: text('label').notNull(),
})

// Devices on the tailnet, synced from `tailscale status`, keyed by IP.
// This machine is also listed under its loopback addresses, so requests
// made locally get its name too.
export const tailnetDevices = sqliteTable('tailnet_devices', {
  ip: text('ip').primaryKey(),
  name: text('name').notNull(), // first label of the MagicDNS name
  dnsName: text('dns_name'),
  os: text('os'),
  isSelf: integer('is_self', { mode: 'boolean' }).notNull(),
  online: integer('online', { mode: 'boolean' }),
  syncedAt: integer('synced_at', { mode: 'timestamp_ms' }).notNull(),
})

// Manual prices for models the public price table lacks or gets wrong.
// Rates are micro-dollars per million tokens.
export const priceOverrides = sqliteTable('price_overrides', {
  model: text('model').primaryKey(),
  inputPerMTok: integer('input_per_mtok').notNull(),
  outputPerMTok: integer('output_per_mtok').notNull(),
  cacheReadPerMTok: integer('cache_read_per_mtok'),
  cacheWritePerMTok: integer('cache_write_per_mtok'),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
})
