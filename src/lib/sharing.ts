// Client for the usage server's sharing settings (server/src/http/sharing.ts).

export const POOLS = [
  { id: 'claude', label: 'Claude' },
  { id: 'codex', label: 'Codex' },
  { id: 'grok', label: 'Grok' },
  { id: 'muse', label: 'Muse' },
] as const
export type Pool = (typeof POOLS)[number]['id']

export type Peer = { id: number; name: string; createdAt: number }
export type SharingState = { sharing: Record<Pool, boolean>; peers: Peer[] }

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/pool${path}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`)
  return data as T
}

export const getSharing = () => call<SharingState>('GET', '')
export const setShared = (pool: Pool, shared: boolean) => call<Pick<SharingState, 'sharing'>>('PUT', '/sharing', { pool, shared })
export const addPeer = (name: string) => call<{ token: string }>('POST', '/peers', { name })
export const removePeer = (id: number) => call<{ ok: true }>('DELETE', `/peers/${id}`)

// The proxy config a peer adds so its proxy falls back to this one.
export function peerConfig(gateway: string, token: string) {
  return `claude-api-key:
  - api-key: ${token}
    base-url: ${gateway}/pool
    priority: -1
    disable-cooling: true
codex-api-key:
  - api-key: ${token}
    base-url: ${gateway}/pool/v1
    priority: -1
    disable-cooling: true
openai-compatibility:
  - name: pool
    base-url: ${gateway}/pool/v1
    priority: -1
    disable-cooling: true
    api-key-entries:
      - api-key: ${token}
    models: [] # the Grok and Muse models to borrow, e.g. - name: grok-4`
}
