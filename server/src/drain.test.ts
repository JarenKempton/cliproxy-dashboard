import { afterAll, beforeAll, beforeEach, expect, spyOn, test } from 'bun:test'
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
let refusePriorityName: string | null = null
let commitThenFailName: string | null = null

const proxy = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === '/v0/management/auth-files') return Response.json({ files })
    if (url.pathname === '/v0/management/auth-files/fields' && req.method === 'PATCH') {
      const patch = (await req.json()) as { name: string; priority: number }
      patches.push(patch)
      if (patch.name === refusePriorityName) { refusePriorityName = null; return new Response('unavailable', { status: 503 }) }
      files = files.map((f) => (f.name === patch.name ? { ...f, priority: patch.priority } : f))
      if (patch.name === commitThenFailName) { commitThenFailName = null; return new Response('persist failed after update', { status: 500 }) }
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
  refusePriorityName = null
  commitThenFailName = null
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

test('a successful reading with no weekly reset clears the previous rank', async () => {
  await drain.set(true)
  windows['curt-1'] = []
  await drain.apply()
  expect(files.find((f) => f.name === 'curt-1')?.priority).toBe(0)
})

test('expired reset times do not outrank future resets', async () => {
  windows['curt-1'] = weekly(-1)
  await drain.set(true)
  expect(files.find((f) => f.name === 'curt-1')?.priority ?? 0).toBe(0)
})

test('turning off during a quota read cannot leave priorities enabled', async () => {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const concurrent = new Drain(db, proxy.url.origin, 'management', async (f) => {
    entered.resolve()
    await release.promise
    return windows[f.name] ?? []
  })
  const enabling = concurrent.set(true)
  await entered.promise
  const disabling = concurrent.set(false)
  release.resolve()
  await Promise.all([enabling, disabling])
  expect(concurrent.on()).toBe(false)
  expect(files.every((f) => (f.priority ?? 0) === 0)).toBe(true)
})

test('a failed enable restores priorities already written and keeps the setting off', async () => {
  files[0].priority = 7
  refusePriorityName = 'curt-2'
  await expect(drain.set(true)).rejects.toThrow('HTTP 503')
  expect(drain.on()).toBe(false)
  expect(files.map((f) => f.priority ?? 0)).toEqual([7, 0, 0, 0, 0])
  refusePriorityName = null
  await drain.set(true)
  expect(drain.on()).toBe(true)
  expect(files[0].priority).toBe(3)
})

test('turning it off clears every priority and stops ranking', async () => {
  await drain.set(true)
  await drain.set(false)
  expect(files.every((f) => (f.priority ?? 0) === 0)).toBe(true)
  await drain.apply()
  expect(files.every((f) => (f.priority ?? 0) === 0)).toBe(true)
})


test('daily windows cannot outrank a weekly reset', async () => {
  windows['curt-1'] = [{ id: 'daily', label: 'Daily', periodMs: 24 * HOUR, resetAtMs: Date.now() + HOUR, usedPercent: 50 }]
  await drain.set(true)
  expect(files.find((f) => f.name === 'curt-1')?.priority ?? 0).toBe(0)
})

test('cached resets expiring during later quota reads are excluded before ranking', async () => {
  let clock = Date.now()
  const time = spyOn(Date, 'now').mockImplementation(() => clock)
  let refresh = false
  const cached = new Drain(db, proxy.url.origin, 'management', async (file) => {
    if (refresh && file.name === 'curt-1') throw new Error('rate limited')
    if (refresh && file.name === 'curt-2') clock += 10000
    if (file.name === 'curt-1') return [{ id: 'weekly', label: 'Weekly', usedPercent: 50, resetAtMs: clock + 1000, periodMs: 168 * HOUR }]
    return weekly(60)
  })
  try {
    await cached.set(true)
    refresh = true
    await cached.apply()
    expect(files.find((f) => f.name === 'curt-1')?.priority).toBe(0)
  } finally { time.mockRestore() }
})

test('an uncertain failed PATCH restores that account as well as preceding writes', async () => {
  files = files.slice(0, 2).map((file, i) => ({ ...file, priority: i + 7 }))
  commitThenFailName = 'curt-2'
  await expect(drain.set(true)).rejects.toThrow('HTTP 500')
  expect(drain.on()).toBe(false)
  expect(files.map((file) => file.priority)).toEqual([7, 8])
})

test('a rejected settings save restores all changed priorities and keeps the switch off', async () => {
  files = files.slice(0, 2).map((file, i) => ({ ...file, priority: i + 7 }))
  db.$client.exec("CREATE TRIGGER refuse_drain BEFORE INSERT ON settings WHEN NEW.key = 'drain-soonest' AND NEW.value = '1' BEGIN SELECT RAISE(FAIL, 'settings rejected'); END")
  try {
    await expect(drain.set(true)).rejects.toThrow()
    expect(drain.on()).toBe(false)
    expect(files.map((file) => file.priority)).toEqual([7, 8])
  } finally { db.$client.exec('DROP TRIGGER refuse_drain') }
})

test('a later valid weekly window survives an earlier reset expiring during refresh', async () => {
  files = files.slice(0, 2)
  const started = Date.now()
  let clock = started
  const time = spyOn(Date, 'now').mockImplementation(() => clock)
  const window = (seconds: number): QuotaWindow => ({ id: `weekly-${seconds}`, label: 'Weekly', periodMs: 168 * HOUR, resetAtMs: started + seconds * 1000, usedPercent: 50 })
  const multiple = new Drain(db, proxy.url.origin, 'management', async (file) => {
    if (file.name === 'curt-1') return [window(1), window(60)]
    clock = started + 10000
    return [window(120)]
  })
  try {
    await multiple.set(true)
    expect(files.map((file) => file.priority ?? 0)).toEqual([2, 1])
  } finally { time.mockRestore() }
})
