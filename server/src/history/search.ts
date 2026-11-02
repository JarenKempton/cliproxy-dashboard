// Searching history.db: keyword (FTS5/BM25) and vector top 30 each, merged
// with reciprocal rank fusion at equal weight, duplicate prompts collapsed,
// the caller's session left out, grouped by session, then a Jev rerank of
// the top 25 sessions within 350 ms. Without Jev, or when it fails or runs
// late, the merged order stands.
//
// The fusion loop is copied from ResponsiBid/responsi-brain@1f17ff4
// src/search/v2/v2-search.ts, with the text:vector weight changed from 2:1 to
// 1:1 and Brain's lifecycle multiplier and search traces dropped.

import { TypeSafeClient } from '@typesafe-ai/sdk'
import { existsSync } from 'node:fs'
import { openHistoryDb, readMeta, type HistoryDb } from './db'
import { DIMS, embedQuery } from './embed'
import { JEV_MODEL, JevReranker, type Reranker } from './jev'
import { RERANK_POOL, rerankRows } from './rerank'

const FUSION_POOL = 30
const RRF_K = 60
const TEXT_WEIGHT = 1
const VECTOR_WEIGHT = 1
const RUNS_PER_SESSION = 3
const EXCERPT_CHARS = 700
const PASSAGE_PROMPT_CHARS = 1500
const PASSAGE_OUTCOME_CHARS = 2000

export type SearchArgs = { q: string; repo?: string; machine?: string; since?: string; limit?: number; session?: string }

type RunRow = {
  rowid: number
  id: string
  machine: string
  harness: string
  session: string
  root_session: string
  cwd: string | null
  repo: string | null
  branch: string | null
  started_at: string | null
  prompt: string
  outcome: string
  prompt_key: string
}

export type SessionHit = {
  session: string
  machine: string
  harness: string
  repo: string | null
  cwd: string | null
  branch: string | null
  startedAt: string | null
  score: number
  runs: { id: string; startedAt: string | null; prompt: string; outcome: string }[]
}

export type SearchResult = {
  mode: 'hybrid' | 'text' | 'vector'
  reranker: string | null
  warning?: { code: string; errorName?: string }
  timingsMs: Record<string, number>
  results: SessionHit[]
}

const excerpt = (text: string) => (text.length > EXCERPT_CHARS ? `${text.slice(0, EXCERPT_CHARS)}…` : text)

export function ftsQuery(q: string) {
  const words = [...new Set(q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])].filter((w) => w.length > 2)
  return words.map((w) => `"${w}"`).join(' OR ')
}

// Reciprocal rank fusion of ranked rowid lists.
export function fuse(lists: { ids: number[]; weight: number }[]): { id: number; score: number }[] {
  const fused = new Map<number, number>()
  for (const { ids, weight } of lists) {
    for (const [index, id] of ids.entries()) fused.set(id, (fused.get(id) ?? 0) + weight / (RRF_K + index + 1))
  }
  return [...fused.entries()].map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score || a.id - b.id)
}

export function jevFromEnv(apiKey: string | null): Reranker | null {
  return apiKey ? new JevReranker(new TypeSafeClient({ apiKey, defaultModel: JEV_MODEL })) : null
}

export class HistorySearch {
  private db: HistoryDb | null = null
  private vectors = { built: '', lastRowid: 0, ids: [] as number[], matrix: new Float32Array(0) }

  constructor(
    private dbPath: string,
    private reranker: Reranker | null,
  ) {}

  ready() {
    if (!this.db && existsSync(this.dbPath)) this.db = openHistoryDb(this.dbPath)
    return this.db
  }

  private filters(args: SearchArgs) {
    const clauses: [string, string[]][] = []
    if (args.machine) clauses.push(['r.machine = ?', [args.machine]])
    if (args.repo) clauses.push(["(r.repo = ? collate nocase or r.cwd like '%' || ? || '%')", [args.repo, args.repo]])
    if (args.since) clauses.push(['r.started_at >= ?', [args.since]])
    if (args.session) clauses.push(['r.session != ? and r.root_session != ?', [args.session, args.session]])
    return { sql: clauses.map(([sql]) => ` and ${sql}`).join(''), params: clauses.flatMap(([, params]) => params) }
  }

  private lexical(db: HistoryDb, args: SearchArgs): number[] {
    const match = ftsQuery(args.q)
    if (!match) return []
    const f = this.filters(args)
    return db
      .query<{ rowid: number }, (string | number)[]>(
        `select r.rowid from runs_fts join runs r on r.rowid = runs_fts.rowid
         where runs_fts match ?${f.sql} order by bm25(runs_fts, 3.0, 1.0) limit ?`,
      )
      .all(match, ...f.params, FUSION_POOL)
      .map((r) => r.rowid)
  }

  // Embeddings are loaded once and topped up as the indexer adds runs.
  private loadVectors(db: HistoryDb) {
    const built = readMeta(db).created_at ?? ''
    if (built !== this.vectors.built) this.vectors = { built, lastRowid: 0, ids: [], matrix: new Float32Array(0) }
    const rows = db
      .query<{ rowid: number; embedding: Uint8Array }, [number]>(
        'select rowid, embedding from runs where rowid > ? and embedding is not null order by rowid',
      )
      .all(this.vectors.lastRowid)
    if (!rows.length) return this.vectors
    const matrix = new Float32Array((this.vectors.ids.length + rows.length) * DIMS)
    matrix.set(this.vectors.matrix)
    rows.forEach((r, i) => {
      matrix.set(new Float32Array(r.embedding.buffer, r.embedding.byteOffset, DIMS), (this.vectors.ids.length + i) * DIMS)
    })
    this.vectors = {
      built,
      lastRowid: rows.at(-1)!.rowid,
      ids: [...this.vectors.ids, ...rows.map((r) => r.rowid)],
      matrix,
    }
    return this.vectors
  }

  private async vector(db: HistoryDb, args: SearchArgs): Promise<number[]> {
    const { ids, matrix } = this.loadVectors(db)
    if (!ids.length) return []
    const query = await embedQuery(args.q)
    const f = this.filters(args)
    const allowed = f.sql
      ? new Set(db.query<{ rowid: number }, string[]>(`select r.rowid from runs r where 1${f.sql}`).all(...f.params).map((r) => r.rowid))
      : null
    const top: { id: number; score: number }[] = []
    for (let i = 0; i < ids.length; i++) {
      if (allowed && !allowed.has(ids[i])) continue
      let score = 0
      for (let d = 0, o = i * DIMS; d < DIMS; d++) score += matrix[o + d] * query[d]
      if (top.length < FUSION_POOL || score > top[top.length - 1].score) {
        top.push({ id: ids[i], score })
        top.sort((a, b) => b.score - a.score)
        if (top.length > FUSION_POOL) top.pop()
      }
    }
    return top.map((t) => t.id)
  }

  async search(args: SearchArgs): Promise<SearchResult | null> {
    const db = this.ready()
    if (!db) return null
    const limit = Math.min(Math.max(Math.trunc(args.limit ?? 10), 1), 25)
    const timings: Record<string, number> = {}
    const timed = async <T>(name: string, work: () => T | Promise<T>) => {
      const start = performance.now()
      try {
        return await work()
      } finally {
        timings[name] = Math.round(performance.now() - start)
      }
    }

    const textIds = await timed('lexical', () => this.lexical(db, args))
    const vectorIds = await timed('vector', () => this.vector(db, args))
    const mode = textIds.length && vectorIds.length ? 'hybrid' : vectorIds.length ? 'vector' : 'text'
    const order = fuse([
      { ids: textIds, weight: TEXT_WEIGHT },
      { ids: vectorIds, weight: VECTOR_WEIGHT },
    ])

    const byId = new Map(
      db
        .query<RunRow, number[]>(
          `select rowid, id, machine, harness, session, root_session, cwd, repo, branch, started_at, prompt, outcome, prompt_key
           from runs where rowid in (${order.map(() => '?').join(',') || 'null'})`,
        )
        .all(...order.map((o) => o.id))
        .map((r) => [r.rowid, r]),
    )

    const seenPrompts = new Set<string>()
    const groups = new Map<string, { rows: RunRow[]; score: number }>()
    for (const { id, score } of order) {
      const row = byId.get(id)
      if (!row) continue
      if (row.prompt_key && seenPrompts.has(row.prompt_key)) continue
      seenPrompts.add(row.prompt_key)
      const key = `${row.machine}:${row.root_session}`
      const group = groups.get(key) ?? { rows: [], score }
      if (group.rows.length < RUNS_PER_SESSION) group.rows.push(row)
      groups.set(key, group)
    }

    const ranked = [...groups.values()]
    const pool = ranked.slice(0, RERANK_POOL)
    const rerank = await timed('rerank', () =>
      rerankRows(
        this.reranker,
        args.q,
        pool.map(({ rows: [first, ...rest] }) => ({
          id: first.id,
          source: `${first.machine} ${first.harness}`,
          title: [first.repo, first.branch, first.started_at?.slice(0, 10)].filter(Boolean).join(' · '),
          heading: null,
          text: [first, ...rest]
            .map((r) => `${r.prompt.slice(0, PASSAGE_PROMPT_CHARS)}\n\n${r.outcome.slice(0, PASSAGE_OUTCOME_CHARS)}`)
            .join('\n\n---\n\n'),
        })),
      ),
    )
    const ordered = [
      ...rerank.order.map((position) => ({ ...pool[position], score: rerank.scores?.[position] ?? pool[position].score })),
      ...ranked.slice(RERANK_POOL),
    ]

    return {
      mode,
      reranker: rerank.warning ? null : (this.reranker?.name ?? null),
      ...(rerank.warning ? { warning: rerank.warning } : {}),
      timingsMs: timings,
      results: ordered.slice(0, limit).map(({ rows, score }) => ({
        session: rows[0].root_session,
        machine: rows[0].machine,
        harness: rows[0].harness,
        repo: rows[0].repo,
        cwd: rows[0].cwd,
        branch: rows[0].branch,
        startedAt: rows[0].started_at,
        score: Math.round(score * 10000) / 10000,
        runs: rows.map((r) => ({ id: r.id, startedAt: r.started_at, prompt: excerpt(r.prompt), outcome: excerpt(r.outcome) })),
      })),
    }
  }
}

const CUT = { commands: 20, failures: 10, filesRead: 20, chars: 300 }
const cut = (text: string | null) => (text && text.length > CUT.chars ? `${text.slice(0, CUT.chars)}…` : text)

type StoredRecord = {
  toolCalls: number
  toolErrors: number
  commands: { command: string | null; workdir: string | null }[]
  failures: { tool: string; kind: string; what: string | null }[]
  filesRead: string[]
  prLinks: string[]
  [field: string]: unknown
}

// One session and its subagents, run by run, with tool activity cut down.
export function sessionRuns(db: HistoryDb, id: string, machine?: string) {
  const rows = db
    .query<RunRow & { ended_at: string | null; record: string }, string[]>(
      `select * from runs where (session = ? or root_session = ?)${machine ? ' and machine = ?' : ''} order by started_at, rowid`,
    )
    .all(id, id, ...(machine ? [machine] : []))
  return rows.map((r) => {
    const record = JSON.parse(r.record) as StoredRecord
    return {
      id: r.id,
      machine: r.machine,
      harness: r.harness,
      session: r.session,
      cwd: r.cwd,
      branch: r.branch,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      prompt: r.prompt,
      outcome: r.outcome,
      model: record.model ?? null,
      toolCalls: record.toolCalls,
      toolErrors: record.toolErrors,
      commands: record.commands.slice(0, CUT.commands).map((c) => cut(c.command)),
      commandsOmitted: Math.max(record.commands.length - CUT.commands, 0),
      failures: record.failures.slice(0, CUT.failures).map((f) => ({ tool: f.tool, kind: f.kind, what: cut(f.what) })),
      filesRead: record.filesRead.slice(0, CUT.filesRead),
      prLinks: record.prLinks,
    }
  })
}
