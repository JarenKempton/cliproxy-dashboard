import { expect, test } from 'bun:test'
import { museRelay } from './muse-relay'
import type { ProxyKeys } from '../proxy-keys'

test('relays a response across a reasoning pause longer than Bun’s default idle timeout', async () => {
  const encoder = new TextEncoder()
  const summary = 'event: response.reasoning_summary_part.done\ndata: {"type":"response.reasoning_summary_part.done"}\n\n'
  const completed = 'event: response.completed\ndata: {"type":"response.completed"}\n\n'
  let timer: ReturnType<typeof setTimeout> | undefined
  const upstream = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    idleTimeout: 0,
    fetch() {
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(summary))
          timer = setTimeout(() => {
            controller.enqueue(encoder.encode(completed))
            controller.close()
          }, 12_000)
        },
        cancel() { clearTimeout(timer) },
      }), { headers: { 'Content-Type': 'text/event-stream' } })
    },
  })
  const app = museRelay(upstream.url.origin, '', {} as ProxyKeys)
  const relay = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: app.fetch })

  try {
    const response = await fetch(`${relay.url.origin}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'muse-wonder-full-1.0', input: 'Think carefully.', stream: true }),
      signal: AbortSignal.timeout(20_000),
    })
    expect(response.status).toBe(200)
    expect(await response.text()).toBe(summary + completed)
  } finally {
    clearTimeout(timer)
    relay.stop(true)
    upstream.stop(true)
  }
}, 25_000)
