// The proxy's own API key list, cached briefly. Used to check keys handed to
// or presented by other machines.

const TTL_MS = 60e3

export class ProxyKeys {
  private cached: { list: string[]; at: number } | null = null

  constructor(
    private proxyUrl: string,
    private managementKey: string,
  ) {}

  async has(key: string): Promise<boolean> {
    if (!this.cached || Date.now() - this.cached.at > TTL_MS) {
      const res = await fetch(`${this.proxyUrl}/v0/management/api-keys`, {
        headers: { Authorization: `Bearer ${this.managementKey}` },
      })
      if (!res.ok) return false
      const body = (await res.json()) as { 'api-keys'?: string[] }
      this.cached = { list: body['api-keys'] ?? [], at: Date.now() }
    }
    return this.cached.list.includes(key)
  }

  // New keys should be accepted immediately after the dashboard adds them.
  invalidate() {
    this.cached = null
  }
}
