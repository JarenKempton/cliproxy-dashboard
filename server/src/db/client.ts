import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import * as schema from './schema'

export type Db = ReturnType<typeof openDb>

// Opens (creating if needed) the SQLite database and applies pending migrations.
export function openDb(path: string) {
  mkdirSync(dirname(path), { recursive: true })
  const sqlite = new Database(path, { create: true })
  sqlite.exec('PRAGMA journal_mode = WAL;')
  sqlite.exec('PRAGMA foreign_keys = ON;')

  const db = drizzle(sqlite, { schema })
  migrate(db, { migrationsFolder: new URL('../../drizzle', import.meta.url).pathname })
  return db
}
