// history.db: closed runs from every machine, with keyword and vector indexes.
// Derived only from ${HISTORY_DIR}, so it can be deleted and rebuilt. `meta`
// records the Quench version and embedding model it was built with.

import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const SCHEMA = `
create table if not exists meta(key text primary key, value text not null);
create table if not exists runs(
  rowid integer primary key,
  id text not null unique,
  machine text not null,
  harness text not null,
  session text not null,
  root_session text not null,
  cwd text,
  repo text,
  branch text,
  started_at text,
  ended_at text,
  prompt text not null,
  outcome text not null,
  prompt_key text not null,
  record text not null,
  embedding blob
);
create index if not exists runs_root on runs(root_session);
create virtual table if not exists runs_fts using fts5(prompt, outcome, content='runs', content_rowid='rowid', tokenize='porter unicode61');
`

export type HistoryDb = Database

export function openHistoryDb(path: string): HistoryDb {
  mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path, { create: true })
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec('PRAGMA busy_timeout = 5000;')
  db.exec(SCHEMA)
  return db
}

export function readMeta(db: HistoryDb): Record<string, string> {
  return Object.fromEntries(db.query<{ key: string; value: string }, []>('select key, value from meta').all().map((r) => [r.key, r.value]))
}

export function writeMeta(db: HistoryDb, values: Record<string, string>) {
  const put = db.prepare('insert into meta(key, value) values (?, ?) on conflict(key) do update set value = excluded.value')
  for (const [k, v] of Object.entries(values)) put.run(k, v)
}

// Empties the index in place, so readers holding the file see the rebuild.
export function resetHistoryDb(db: HistoryDb) {
  db.exec('drop table if exists runs_fts; drop table if exists runs; drop table if exists meta;')
  db.exec(SCHEMA)
}
