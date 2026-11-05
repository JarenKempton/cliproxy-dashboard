import { Copy, Plus, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { ProviderMark } from '../components/ProviderMark'
import { ConfirmDialog, copyText, PageHead, Switch, toast } from '../components/ui'
import { formatRelative } from '../lib/format'
import { addPeer, getSharing, peerConfig, POOLS, removePeer, setShared, type Peer, type SharingState } from '../lib/sharing'

type Networks = Record<'tailnet' | 'lan', { dashboard: string } | null>

export function SharingPage() {
  const [state, setState] = useState<SharingState | null>(null)
  const [gateway, setGateway] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [issued, setIssued] = useState<{ name: string; token: string } | null>(null)
  const [removing, setRemoving] = useState<Peer | null>(null)

  const load = useCallback(() => getSharing().then(setState).catch((err) => toast(`Couldn’t load sharing: ${err.message}`)), [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load()
    fetch('/connect/networks')
      .then((r) => r.json() as Promise<Networks>)
      .then((n) => setGateway(n.lan?.dashboard ?? n.tailnet?.dashboard ?? null))
      .catch(() => setGateway(null))
  }, [load])

  const toggle = async (pool: (typeof POOLS)[number]['id']) => {
    if (!state) return
    try {
      const { sharing } = await setShared(pool, !state.sharing[pool])
      setState({ ...state, sharing })
    } catch (err) {
      toast(`Couldn’t change sharing: ${(err as Error).message}`)
    }
  }

  const add = async () => {
    const peer = name.trim()
    if (!peer) return
    try {
      const { token } = await addPeer(peer)
      setIssued({ name: peer, token })
      setName('')
      await load()
    } catch (err) {
      toast(`Couldn’t add peer: ${(err as Error).message}`)
    }
  }

  const confirmRemove = async () => {
    const target = removing
    setRemoving(null)
    if (!target) return
    try {
      await removePeer(target.id)
      if (issued?.name === target.name) setIssued(null)
      await load()
      toast(`${target.name} removed`)
    } catch (err) {
      toast(`Couldn’t remove peer: ${(err as Error).message}`)
    }
  }

  const sharingAny = state && Object.values(state.sharing).some(Boolean)

  return (
    <div className="page">
      <PageHead title="Sharing" sub="Lend a pool to peers’ proxies when they run out. Off unless you turn it on." />

      <div className="panel klist">
        {POOLS.map((p) => (
          <div key={p.id} className="krow">
            <span className="krow-key">
              <ProviderMark of={p.id} />
              {p.label}
            </span>
            <span className="mono faint">{state?.sharing[p.id] ? 'Shared with peers' : 'Not shared'}</span>
            <Switch on={!!state?.sharing[p.id]} label={`Share ${p.label}`} disabled={!state} onChange={() => toggle(p.id)} />
          </div>
        ))}
      </div>
      <p className="mono faint">
        {sharingAny
          ? 'Peers can use a shared pool only while it has a working account here.'
          : 'Nothing is shared. Every peer request is refused before it reaches the proxy.'}
      </p>

      <section className="section">
        <div className="section-head">
          <h2>Peers</h2>
        </div>
        <div className="panel klist">
          {state?.peers.map((peer) => (
            <div key={peer.id} className="krow">
              <span>{peer.name}</span>
              <span className="mono faint">added {formatRelative(peer.createdAt)} · usage under key “Pool: {peer.name}”</span>
              <button className="btn btn-ghost btn-icon" aria-label={`Remove ${peer.name}`} onClick={() => setRemoving(peer)}>
                <Trash2 size={14} />
              </button>
            </div>
          ))}
          <div className="krow">
            <input
              className="input krow-label"
              placeholder="Peer name (e.g. Curt)"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && add()}
            />
            <span />
            <button className="btn btn-primary" onClick={add} disabled={!name.trim()}>
              <Plus size={14} /> Add peer
            </button>
          </div>
        </div>
      </section>

      {issued && (
        <section className="section">
          <div className="section-head">
            <h2>Config for {issued.name}’s proxy</h2>
            <button className="btn btn-ghost" onClick={() => copyText(peerConfig(gateway ?? '<this dashboard>', issued.token), 'Config copied')}>
              <Copy size={14} /> Copy
            </button>
          </div>
          <p className="mono faint">Shown once. Their proxy uses yours only after its own accounts are spent.</p>
          <pre className="panel mono peer-config">{peerConfig(gateway ?? '<this dashboard>', issued.token)}</pre>
        </section>
      )}

      <ConfirmDialog
        open={!!removing}
        title={`Remove ${removing?.name}?`}
        body="Their token and its proxy key stop working immediately."
        confirmLabel="Remove peer"
        danger
        onConfirm={confirmRemove}
        onCancel={() => setRemoving(null)}
      />
    </div>
  )
}
