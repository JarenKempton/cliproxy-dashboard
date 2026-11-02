// Cross-machine history.
//
//   POST /history/push          {files: [{path, offset, data (base64)}]}, proxy key required;
//                               returns {machine, files: [{path, size}]}
//   POST /history/search        {q, repo?, machine?, since?, limit?, session?}; `session` is the
//                               caller's own, left out of results
//   GET  /history/sessions/:id  ?machine=…; a session's runs with tool activity cut down
//
// Push is also mounted on the local-network listener; search is not.

import { Hono } from 'hono'
import type { Db } from '../db/client'
import { historyEnv } from '../history/env'
import { sessionRuns, type HistorySearch } from '../history/search'
import { appendAt, machineFolder, validPath, type PushedFile } from '../history/store'
import { machineOfKey } from '../machines'
import type { ProxyKeys } from '../proxy-keys'

const MAX_FAILURES_PER_MINUTE = 10
const NOT_BUILT = { error: 'the history index has not been built yet' }

export function historyPushApp(db: Db, keys: ProxyKeys, root = historyEnv.dir) {
  const failures: number[] = []
  const app = new Hono()

  app.post('/push', async (c) => {
    const now = Date.now()
    while (failures.length && failures[0] < now - 60e3) failures.shift()
    if (failures.length >= MAX_FAILURES_PER_MINUTE) return c.json({ error: 'too many attempts' }, 429)

    const key = c.req.header('authorization')?.replace(/^Bearer\s+/i, '') ?? ''
    const known = key ? await keys.has(key).catch(() => null) : false
    if (known === null) return c.json({ error: "can't reach the proxy to check the key" }, 503)
    if (!known) {
      failures.push(now)
      return c.json({ error: 'a proxy API key is required' }, 401)
    }
    const name = machineOfKey(db, key)
    const machine = name && machineFolder(name)
    if (!machine) return c.json({ error: 'this key is not dedicated to a machine; connect the machine from the dashboard' }, 403)

    const { files } = await c.req.json<{ files?: PushedFile[] }>()
    if (!Array.isArray(files)) return c.json({ error: 'files is required' }, 400)
    const valid = files.filter(
      (f) => validPath(f?.path) && Number.isSafeInteger(f.offset) && f.offset >= 0 && typeof f.data === 'string',
    )
    if (valid.length !== files.length) return c.json({ error: 'each file needs a harness path, an offset and base64 data' }, 400)
    return c.json({ machine, files: valid.map((f) => ({ path: f.path, size: appendAt(root, machine, f) })) })
  })

  return app
}

export function historySearchApp(search: HistorySearch) {
  const app = new Hono()

  app.post('/search', async (c) => {
    const body = await c.req.json<{ q?: unknown; repo?: unknown; machine?: unknown; since?: unknown; limit?: unknown; session?: unknown }>()
    if (typeof body.q !== 'string' || !body.q.trim()) return c.json({ error: 'q is required' }, 400)
    const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
    const result = await search.search({
      q: body.q.trim(),
      repo: text(body.repo),
      machine: text(body.machine),
      since: text(body.since),
      session: text(body.session),
      limit: typeof body.limit === 'number' ? body.limit : undefined,
    })
    return result ? c.json(result) : c.json(NOT_BUILT, 503)
  })

  app.get('/sessions/:id', (c) => {
    const db = search.ready()
    if (!db) return c.json(NOT_BUILT, 503)
    const runs = sessionRuns(db, c.req.param('id'), c.req.query('machine'))
    return runs.length ? c.json({ session: c.req.param('id'), runs }) : c.json({ error: 'no such session' }, 404)
  })

  return app
}
