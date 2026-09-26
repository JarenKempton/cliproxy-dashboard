import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'sqlite',
  schema: './server/src/db/schema.ts',
  out: './server/drizzle',
  dbCredentials: { url: process.env.USAGE_DB_PATH ?? 'data/usage.db' },
})
