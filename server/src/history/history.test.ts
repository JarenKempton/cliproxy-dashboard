import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../db/client'
import { historyPushApp } from '../http/history'
import { nameIdentity } from '../machines'
import type { ProxyKeys } from '../proxy-keys'
import { hashKey } from '../usage/cliproxy-record'
import { openHistoryDb } from './db'
import { promptKey } from './indexer'
import type { Reranker } from './jev'
import { redact } from './redact'
import { fuse, HistorySearch } from './search'
import { validPath } from './store'

const KEY = 'sk-proxy-key-for-sb2'
const keys = { has: async (k: string) => k === KEY } as ProxyKeys

function pushApp() {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'usage-')), 'usage.db'))
  nameIdentity(db, 'key', hashKey(KEY), 'sb2')
  const root = mkdtempSync(join(tmpdir(), 'history-'))
  const app = historyPushApp(db, keys, root)
  const push = (files: unknown[], key = KEY) =>
    app.request('/push', { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: JSON.stringify({ files }) })
  return { root, push }
}

const b64 = (s: string) => Buffer.from(s).toString('base64')
const PATH = '.claude/projects/-home-me-repo/abc.jsonl'

describe('history push', () => {
  test('re-sending the same bytes changes nothing, and new bytes append', async () => {
    const { root, push } = pushApp()
    const first = await push([{ path: PATH, offset: 0, data: b64('{"a":1}\n') }])
    expect(await first.json()).toEqual({ machine: 'sb2', files: [{ path: PATH, size: 8 }] })
    await push([{ path: PATH, offset: 0, data: b64('{"a":1}\n') }])
    await push([{ path: PATH, offset: 0, data: b64('{"a":1}\n{"b":2}\n') }])
    await push([{ path: PATH, offset: 8, data: b64('{"b":2}\n') }])
    expect(readFileSync(join(root, 'sb2', PATH), 'utf8')).toBe('{"a":1}\n{"b":2}\n')
  })

  test('refuses a gap and reports where to resume', async () => {
    const { push } = pushApp()
    const res = await push([{ path: PATH, offset: 100, data: b64('late') }])
    expect(((await res.json()) as { files: unknown }).files).toEqual([{ path: PATH, size: 0 }])
  })

  test('needs a proxy key dedicated to a machine', async () => {
    const { push } = pushApp()
    expect((await push([], 'wrong')).status).toBe(401)
  })

  test('only accepts harness transcript paths', async () => {
    for (const path of ['.claude/projects/../../etc/passwd.jsonl', '/etc/x.jsonl', '.ssh/id.jsonl', '.claude/projects/a.txt', '.codex/sessions//a.jsonl'])
      expect(validPath(path)).toBe(false)
    expect(validPath('.codex/sessions/2026/11/02/rollout.jsonl')).toBe(true)
    const { push } = pushApp()
    expect((await push([{ path: '../escape.jsonl', offset: 0, data: '' }])).status).toBe(400)
  })
})

describe('redaction', () => {
  test('removes secrets and counts them by kind', () => {
    const counts = {}
    const text = redact(
      'key sk-ant-api03-abcdefghijklmnopqrstuvwxyz and ghp_abcdefghijklmnopqrstuvwxyz0123456789\nOPENAI_API_KEY=abc123\nAuthorization: Bearer abcdefghijklmnopqrstuvwxyz',
      counts,
    )
    expect(text).toBe(
      'key [REDACTED:api-key] and [REDACTED:github-token]\nOPENAI_API_KEY=[REDACTED:env]\nAuthorization: Bearer [REDACTED:bearer]',
    )
    expect(counts).toEqual({ 'api-key': 1, 'github-token': 1, env: 1, bearer: 1 })
  })

  test('removes values assigned to secret-named variables in shell, env, JSON and YAML', () => {
    const counts = {}
    const text = redact(
      'export TYPESAFE_API_KEY=abc123def456\nPASSWORD=hunter22\n{"apiKey": "abcdef123456", "type": "message"}\nsecret-key: s3cr3tvalue\nmonkey: banana12 and TOKEN=$GITHUB_TOKEN',
      counts,
    )
    expect(text).toBe(
      'export TYPESAFE_API_KEY=[REDACTED:env]\nPASSWORD=[REDACTED:env]\n{"apiKey": "[REDACTED:env]", "type": "message"}\nsecret-key: [REDACTED:env]\nmonkey: banana12 and TOKEN=$GITHUB_TOKEN',
    )
    expect(counts).toEqual({ env: 4 })
  })

  test('removes short and quoted secret values whole, including JSON-escaped ones', () => {
    const counts = {}
    const text = redact(
      'PASSWORD=abc12\nPASSWORD="correct horse battery staple"\nDB_PASS=\'two words\'\n{\\"apiKey\\": \\"ab cd\\"}',
      counts,
    )
    expect(text).toBe(
      'PASSWORD=[REDACTED:env]\nPASSWORD="[REDACTED:env]"\nDB_PASS=\'[REDACTED:env]\'\n{\\"apiKey\\": \\"[REDACTED:env]\\"}',
    )
    expect(counts).toEqual({ env: 4 })
  })

  test('leaves words that merely contain a token prefix', () => {
    const counts = {}
    const text = '/home/me/.t3/worktrees/repo/task-mcp-native-approval-clients and disk-usage-report-for-every-volume'
    expect(redact(text, counts)).toBe(text)
    expect(counts).toEqual({})
  })
})

describe('search', () => {
  test('fuses keyword and vector ranks at equal weight', () => {
    const fused = fuse([
      { ids: [1, 2], weight: 1 },
      { ids: [3, 2], weight: 1 },
    ])
    expect(fused.map((f) => f.id)).toEqual([2, 1, 3])
    expect(fused[1].score).toBe(fused[2].score)
  })

  function seeded() {
    const path = join(mkdtempSync(join(tmpdir(), 'hdb-')), 'history.db')
    const db = openHistoryDb(path)
    const add = (id: string, session: string, root: string, prompt: string) => {
      const { rowid } = db
        .query(
          `insert into runs(id, machine, harness, session, root_session, prompt, outcome, prompt_key, record)
           values (?, 'goliath', 'claude-code', ?, ?, ?, 'made ci faster', ?, '{}') returning rowid`,
        )
        .get(id, session, root, prompt, promptKey(prompt)) as { rowid: number }
      db.query('insert into runs_fts(rowid, prompt, outcome) values (?, ?, ?)').run(rowid, prompt, 'made ci faster')
    }
    add('goliath:claude-code:s1:1', 's1', 's1', 'speed up the CI harness')
    add('goliath:claude-code:s1:2', 's1', 's1', 'CI harness still slow')
    add('goliath:claude-code:s2:1', 's2', 's2', 'Speed up the  CI harness')
    add('goliath:claude-code:s3:1', 's3', 's3', 'CI harness cache warmup')
    add('goliath:claude-code:sub:1', 'sub', 's4', 'CI harness profiling in a subagent')
    return path
  }

  test('collapses duplicate prompts, groups by session and leaves out the caller', async () => {
    const result = await new HistorySearch(seeded(), null).search({ q: 'CI harness', session: 's3' })
    const sessions = result!.results.map((r) => r.session)
    expect(sessions).not.toContain('s3')
    expect(sessions).not.toContain('s2')
    expect(new Set(sessions).size).toBe(sessions.length)
    expect(sessions).toContain('s4')
    expect(result!.results.find((r) => r.session === 's1')!.runs.length).toBe(2)
    expect(result!.warning).toEqual({ code: 'rerank_unavailable' })
  })

  test('keeps the merged order when Jev runs past the deadline', async () => {
    const slow: Reranker = { name: 'jev', rerank: () => Bun.sleep(1000).then(() => ({ order: [], scores: [] })) }
    const path = seeded()
    const merged = await new HistorySearch(path, null).search({ q: 'CI harness' })
    const started = performance.now()
    const late = await new HistorySearch(path, slow).search({ q: 'CI harness' })
    expect(performance.now() - started).toBeLessThan(800)
    expect(late!.warning).toEqual({ code: 'rerank_timeout' })
    expect(late!.results.map((r) => r.session)).toEqual(merged!.results.map((r) => r.session))
  })

  test('follows Jev when it answers in time', async () => {
    const reverse: Reranker = {
      name: 'jev',
      rerank: async (_q, candidates) => ({ order: candidates.map((_, i) => candidates.length - 1 - i), scores: candidates.map((_, i) => i) }),
    }
    const path = seeded()
    const merged = await new HistorySearch(path, null).search({ q: 'CI harness' })
    const reranked = await new HistorySearch(path, reverse).search({ q: 'CI harness' })
    expect(reranked!.reranker).toBe('jev')
    expect(reranked!.results.map((r) => r.session)).toEqual(merged!.results.map((r) => r.session).reverse())
  })
})
