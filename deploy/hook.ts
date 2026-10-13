// Deploy receiver: CI asks it to redeploy a TrueNAS app after publishing an image.
//
//   POST /deploy            {"app": "<name>"}  signed, returns 202 {"job": <id>}
//   GET  /deploy/jobs/:id   state of a job this receiver started
//
// Requests are signed with HMAC-SHA256 over `${timestamp}.${body}` using
// DEPLOY_SECRET, sent as X-Deploy-Timestamp and X-Deploy-Signature (hex).
// Only apps listed in DEPLOY_APPS can be redeployed. The TrueNAS key
// (DEPLOY_TRUENAS_KEY_FILE) never leaves this machine.

import { createHmac, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'

const MAX_SKEW_S = 300
const secret = required('DEPLOY_SECRET')
const apps = new Set(required('DEPLOY_APPS').split(',').map((a) => a.trim()))
const truenasKey = readFileSync(required('DEPLOY_TRUENAS_KEY_FILE'), 'utf8').trim()
const truenas = process.env.DEPLOY_TRUENAS_URL ?? 'https://127.0.0.1/api/v2.0'
const started = new Set<number>()

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

function api(path: string, init: RequestInit = {}) {
  return fetch(`${truenas}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${truenasKey}`, 'Content-Type': 'application/json' },
    tls: { rejectUnauthorized: false },
  })
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
      const res = await api('/app/redeploy', { method: 'POST', body: JSON.stringify(app) })
      if (!res.ok) return Response.json({ error: `TrueNAS HTTP ${res.status}` }, { status: 502 })
      const job = Number(await res.json())
      started.add(job)
      console.log(`[deploy] ${app}: job ${job}`)
      return Response.json({ job }, { status: 202 })
    }

    const match = url.pathname.match(/^\/deploy\/jobs\/(\d+)$/)
    if (req.method === 'GET' && match && started.has(Number(match[1]))) {
      const res = await api(`/core/get_jobs?id=${match[1]}`)
      const [job] = (await res.json()) as { state: string; error: string | null }[]
      return Response.json({ state: job.state, error: job.error })
    }

    return Response.json({ error: 'not found' }, { status: 404 })
  },
})
console.log('[deploy] listening')
