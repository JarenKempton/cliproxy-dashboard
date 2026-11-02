// The indexer container: every HISTORY_INDEX_INTERVAL_S, reads every machine
// folder under HISTORY_DIR with the pinned Quench and adds closed runs it
// hasn't seen to history.db. Secrets are removed before anything is stored
// or embedded.
//
//   bun server/src/history/indexer.ts          run forever
//   bun server/src/history/indexer.ts --once   one pass, then print stats

import { readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { openHistoryDb, readMeta, resetHistoryDb, writeMeta, type HistoryDb } from './db'
import { embedPassages, EMBEDDING_MODEL } from './embed'
import { historyEnv } from './env'
import { redact, redactDeep, type RedactionCounts } from './redact'

const EMBED_BATCH = 8
const PROMPT_CHARS = 1200
const OUTCOME_CHARS = 800

type RunRecord = {
  id: string
  machine: string
  session: string
  parentSession: string | null
  harness: string
  cwd: string | null
  branch: string | null
  startedAt: string | null
  endedAt: string | null
  open: boolean
  prompt: string | null
  steering: string[]
  outcome: string | null
  prLinks: string[]
  [field: string]: unknown
}

export type IndexStats = { seen: number; open: number; added: number; embedded: number; redactions: RedactionCounts }

async function quenchVersion() {
  const out = await new Response(Bun.spawn([historyEnv.quenchBin, '--version']).stdout).text()
  return out.trim()
}

// The repository a run worked in: from a PR link, a T3 worktree path, or the folder name.
export function repoOf(cwd: string | null, prLinks: string[]): string | null {
  const pr = prLinks[0]?.match(/github\.com\/[\w.-]+\/([\w.-]+)\/pull/)
  if (pr) return pr[1]
  if (!cwd) return null
  const worktree = cwd.match(/\/\.t3\/worktrees\/([^/]+)/)
  return worktree ? worktree[1] : (cwd.split('/').filter(Boolean).at(-1) ?? null)
}

export const promptKey = (prompt: string) => prompt.toLowerCase().replace(/\s+/g, ' ').trim()

async function* quenchRuns(dirs: string[]): AsyncGenerator<RunRecord> {
  const proc = Bun.spawn([historyEnv.quenchBin, 'runs', '--all', '--json', ...dirs.flatMap((d) => ['--history', d])], {
    stderr: 'inherit',
  })
  let buffered = ''
  const decoder = new TextDecoder()
  for await (const chunk of proc.stdout) {
    buffered += decoder.decode(chunk, { stream: true })
    const lines = buffered.split('\n')
    buffered = lines.pop() ?? ''
    for (const line of lines) if (line) yield JSON.parse(line) as RunRecord
  }
  if (buffered.trim()) yield JSON.parse(buffered) as RunRecord
  if ((await proc.exited) !== 0) throw new Error(`quench exited with ${proc.exitCode}`)
}

function machineDirs(root: string) {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => resolve(join(root, d.name)))
  } catch {
    return []
  }
}

// Rebuilds from scratch when the Quench version or model differs from the one the index was built with.
export async function prepare(db: HistoryDb) {
  const built = { quench_version: await quenchVersion(), embedding_model: EMBEDDING_MODEL }
  const meta = readMeta(db)
  if (meta.quench_version !== built.quench_version || meta.embedding_model !== built.embedding_model) {
    if (meta.quench_version) console.log(`[indexer] rebuilding: built with ${meta.quench_version} / ${meta.embedding_model}`)
    resetHistoryDb(db)
    writeMeta(db, { ...built, created_at: new Date().toISOString() })
  }
}

export async function indexOnce(db: HistoryDb, root: string): Promise<IndexStats> {
  const stats: IndexStats = { seen: 0, open: 0, added: 0, embedded: 0, redactions: {} }
  const dirs = machineDirs(root)
  if (!dirs.length) return stats

  const known = db.prepare<{ x: 1 }, [string]>('select 1 as x from runs where id = ?')
  const insert = db.prepare(
    `insert into runs(id, machine, harness, session, root_session, cwd, repo, branch, started_at, ended_at, prompt, outcome, prompt_key, record)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) returning rowid`,
  )
  const indexText = db.prepare('insert into runs_fts(rowid, prompt, outcome) values (?, ?, ?)')
  const setEmbedding = db.prepare('update runs set embedding = ? where rowid = ?')

  const passage = (prompt: string, outcome: string) => `${prompt.slice(0, PROMPT_CHARS)}\n\n${outcome.slice(0, OUTCOME_CHARS)}`.trim()
  let pending: { rowid: number; text: string }[] = []
  const flush = async () => {
    if (!pending.length) return
    const vectors = await embedPassages(pending.map((p) => p.text))
    db.transaction(() => pending.forEach((p, i) => setEmbedding.run(new Uint8Array(vectors[i].buffer), p.rowid)))()
    stats.embedded += pending.length
    pending = []
  }

  const unembedded = db
    .query<{ rowid: number; prompt: string; outcome: string }, []>(
      "select rowid, prompt, outcome from runs where embedding is null and (trim(prompt) != '' or trim(outcome) != '')",
    )
    .all()
  for (const row of unembedded) {
    pending.push({ rowid: row.rowid, text: passage(row.prompt, row.outcome) })
    if (pending.length >= EMBED_BATCH) await flush()
  }

  for await (const run of quenchRuns(dirs)) {
    stats.seen++
    if (run.open) {
      stats.open++
      continue
    }
    if (known.get(run.id)) continue
    const prompt = redact([run.prompt ?? '', ...run.steering].filter(Boolean).join('\n\n'), stats.redactions)
    const outcome = redact(run.outcome ?? '', stats.redactions)
    const { path: _path, ...rest } = run
    const record = redactDeep({ ...rest, prompt: null, steering: [], outcome: null }, stats.redactions)
    const hasText = Boolean(prompt.trim() || outcome.trim())
    const rowid = db.transaction(() => {
      const { rowid } = insert.get(
        run.id,
        run.machine,
        run.harness,
        run.session,
        run.parentSession ?? run.session,
        record.cwd,
        repoOf(run.cwd, run.prLinks),
        record.branch,
        run.startedAt,
        run.endedAt,
        prompt,
        outcome,
        promptKey(prompt),
        JSON.stringify(record),
      ) as { rowid: number }
      if (hasText) indexText.run(rowid, prompt, outcome)
      return rowid
    })()
    stats.added++
    if (!hasText) continue
    pending.push({ rowid, text: passage(prompt, outcome) })
    if (pending.length >= EMBED_BATCH) await flush()
  }
  await flush()
  writeMeta(db, { indexed_at: new Date().toISOString() })
  return stats
}

if (import.meta.main) {
  const db = openHistoryDb(historyEnv.dbPath)
  await prepare(db)
  const once = process.argv.includes('--once')
  for (;;) {
    const started = performance.now()
    try {
      const stats = await indexOnce(db, historyEnv.dir)
      const seconds = ((performance.now() - started) / 1000).toFixed(1)
      console.log(`[indexer] ${JSON.stringify({ ...stats, seconds, peakRssMb: Math.round(process.resourceUsage().maxRSS / 1024) })}`)
    } catch (err) {
      console.error(`[indexer] ${(err as Error).message}`)
      if (once) process.exit(1)
    }
    if (once) break
    await Bun.sleep(historyEnv.indexIntervalMs)
  }
}
