// Deploy receiver: CI asks it to redeploy a TrueNAS app after publishing an image.
//
//   POST /deploy            {"app": "<name>"}  signed, returns 202 {"job": <id>}
//   GET  /deploy/jobs/:id   state of a job this receiver started
//
// Requests are signed with HMAC-SHA256 over `${timestamp}.${body}` using
// DEPLOY_SECRET, sent as X-Deploy-Timestamp and X-Deploy-Signature (hex).
// Only apps listed in DEPLOY_APPS can be redeployed. The TrueNAS key
// (DEPLOY_TRUENAS_KEY_FILE) never leaves this machine.
//
// TrueNAS is driven over its JSON-RPC websocket on loopback: on 25.10 the REST API
// answers 403 to a role-scoped API key that JSON-RPC accepts.

import { createHmac, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'

const MAX_SKEW_S = 300
const secret = required('DEPLOY_SECRET')
const apps = new Set(required('DEPLOY_APPS').split(',').map((a) => a.trim()))
const truenasKey = readFileSync(required('DEPLOY_TRUENAS_KEY_FILE'), 'utf8').trim()
const truenas = process.env.DEPLOY_TRUENAS_URL ?? 'ws://127.0.0.1/api/current'

function required(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set`)
  return value
}

function signed(timestamp: string, signature: string, body: string) {
  const age = Math.abs(Date.now() / 1000 - Number(timestamp))
  if (!Number.isFinite(age) || age > MAX_SKEW_S) return false
  const expected = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest()
  const given = Buffer.from(signature, 'hex')
  return given.length === expected.length && timingSafeEqual(given, expected)
}

// A logged-in JSON-RPC session. TrueNAS only shows a job to the session that
// started it, so the session that starts a redeploy also waits for it.
async function session() {
  const ws = new WebSocket(truenas)
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  let nextId = 1
  ws.onmessage = (e) => {
    const msg = JSON.parse(String(e.data)) as { id?: number; result?: unknown; error?: { message?: string; data?: { reason?: string } } }
    const waiter = msg.id === undefined ? undefined : pending.get(msg.id)
    if (!waiter) return
    pending.delete(msg.id!)
    if (msg.error) waiter.reject(new Error(msg.error.data?.reason ?? msg.error.message ?? 'TrueNAS error'))
    else waiter.resolve(msg.result)
  }
  ws.onclose = () => {
    for (const w of pending.values()) w.reject(new Error('TrueNAS connection closed'))
    pending.clear()
  }
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve()
    ws.onerror = () => reject(new Error('Cannot reach TrueNAS'))
  })
  const call = (method: string, params: unknown[]) =>
    new Promise<unknown>((resolve, reject) => {
      const id = nextId++
      pending.set(id, { resolve, reject })
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    })
  if ((await call('auth.login_with_api_key', [truenasKey])) !== true) {
    ws.close()
    throw new Error('TrueNAS rejected the API key')
  }
  return { call, close: () => ws.close() }
}

type JobState = { state: 'RUNNING' | 'SUCCESS' | 'FAILED'; error: string | null }
const jobs = new Map<number, JobState>()

async function redeploy(app: string) {
  const s = await session()
  try {
    const job = Number(await s.call('app.redeploy', [app]))
    jobs.set(job, { state: 'RUNNING', error: null })
    s.call('core.job_wait', [job])
      .then(() => jobs.set(job, { state: 'SUCCESS', error: null }))
      .catch((err: Error) => jobs.set(job, { state: 'FAILED', error: err.message }))
      .finally(s.close)
    return job
  } catch (err) {
    s.close()
    throw err
  }
}

Bun.serve({
  hostname: '127.0.0.1',
  port: Number(process.env.DEPLOY_PORT ?? 30091),
  async fetch(req) {
    const url = new URL(req.url)

    if (req.method === 'POST' && url.pathname === '/deploy') {
      const body = await req.text()
      if (!signed(req.headers.get('x-deploy-timestamp') ?? '', req.headers.get('x-deploy-signature') ?? '', body)) {
        return Response.json({ error: 'bad signature' }, { status: 401 })
      }
      const app = JSON.parse(body).app
      if (!apps.has(app)) return Response.json({ error: `${app} is not deployable` }, { status: 403 })
      let job: number
      try {
        job = await redeploy(app)
      } catch (err) {
        console.warn(`[deploy] ${app}: ${(err as Error).message}`)
        return Response.json({ error: (err as Error).message }, { status: 502 })
      }
      console.log(`[deploy] ${app}: job ${job}`)
      return Response.json({ job }, { status: 202 })
    }

    const match = url.pathname.match(/^\/deploy\/jobs\/(\d+)$/)
    const job = match && jobs.get(Number(match[1]))
    if (req.method === 'GET' && job) return Response.json(job)

    return Response.json({ error: 'not found' }, { status: 404 })
  },
})
console.log('[deploy] listening')
