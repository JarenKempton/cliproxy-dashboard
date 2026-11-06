import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sendManagementVia, type AuthFile } from '../../src/lib/api'
import type { QuotaWindow } from '../../src/lib/quota'
import { openDb } from './db/client'
import { Drain } from './drain'

const HOUR = 3600e3
const weekly = (resetInHours: number): QuotaWindow[] => [
  { id: 'session', label: '5-hour', usedPercent: 10, resetAtMs: Date.now() + HOUR, periodMs: 5 * HOUR },
  { id: 'weekly', label: 'Weekly', usedPercent: 40, resetAtMs: Date.now() + resetInHours * HOUR, periodMs: 168 * HOUR },
]

let files: AuthFile[] = []
let patches: { name: string; priority: number }[] = []
let windows: Record<string, QuotaWindow[] | null> = {}

const proxy = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === '/v0/management/auth-files') return Response.json({ files })
    if (url.pathname === '/v0/management/auth-files/fields' && req.method === 'PATCH') {
      const patch = (await req.json()) as { name: string; priority: number }
      patches.push(patch)
      files = files.map((f) => (f.name === patch.name ? { ...f, priority: patch.priority } : f))
      return Response.json({ status: 'ok' })
    }
    return new Response('nope', { status: 404 })
  },
})
beforeAll(() => sendManagementVia((path, init) => fetch(`${proxy.url.origin}${path}`, init)))
afterAll(() => {
  sendManagementVia((path, init) => fetch(path, init))
  proxy.stop(true)
})

const db = openDb(join(mkdtempSync(join(tmpdir(), 'drain-')), 'usage.db'))
const drain = new Drain(db, proxy.url.origin, 'management', async (f) => {
  const w = windows[f.name]
  if (!w) throw new Error('rate limited')
  return w
})

beforeEach(async () => {
  files = ['curt-1', 'curt-2', 'curt-3', 'fresh', 'off'].map((name) => ({ name, auth_index: name, provider: 'claude', disabled: name === 'off' }))
  windows = { 'curt-1': weekly(4), 'curt-2': weekly(60), 'curt-3': weekly(130), fresh: [], off: weekly(1) }
  await drain.set(false)
  patches = []
})

test('ranks the account whose weekly quota resets soonest highest, and an unstarted one last', async () => {
  await drain.set(true)
  const priority = Object.fromEntries(files.map((f) => [f.name, f.priority ?? 0]))
  expect(priority).toEqual({ 'curt-1': 3, 'curt-2': 2, 'curt-3': 1, fresh: 0, off: 0 })
})

test('writes only priorities that changed', async () => {
  await drain.set(true)
  patches = []
  await drain.apply()
  expect(patches).toEqual([])
})

test('a quota read that fails keeps the account where it was', async () => {
  await drain.set(true)
  windows['curt-1'] = null
  await drain.apply()
  expect(files.find((f) => f.name === 'curt-1')?.priority).toBe(3)
})

test('turning it off clears every priority and stops ranking', async () => {
  await drain.set(true)
  await drain.set(false)
  expect(files.every((f) => (f.priority ?? 0) === 0)).toBe(true)
  await drain.apply()
  expect(files.every((f) => (f.priority ?? 0) === 0)).toBe(true)
})
