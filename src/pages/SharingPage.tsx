import { Copy, Plus, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { ProviderMark } from '../components/ProviderMark'
import { ConfirmDialog, copyText, PageHead, Switch, toast } from '../components/ui'
import { formatRelative, formatStamp } from '../lib/format'
import { providerOf } from '../lib/quota'
import { addPeer, getSharing, peerConfig, POOLS, removePeer, setFloor, setOwner, setSharing, sharingChoices, type Peer, type Pool, type SharingState } from '../lib/sharing'
import { useStore } from '../lib/store'

const FLOORS = [0, 10, 20, 30, 40, 50, 60, 70]

type Networks = Record<'tailnet' | 'lan', { dashboard: string } | null>

export function SharingPage() {
  const [state, setState] = useState<SharingState | null>(null)
  const [gateway, setGateway] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [issued, setIssued] = useState<{ name: string; token: string } | null>(null)
  const [removing, setRemoving] = useState<Peer | null>(null)
  const [owner, setOwnerName] = useState('')
  const [picked, setPicked] = useState<Partial<Record<Pool, string>>>({})
  const { files, quotas, now } = useStore()

  const choicesFor = (provider: string) =>
    sharingChoices(
      files.filter((f) => !f.disabled && providerOf(f) === provider).flatMap((f) => quotas[f.auth_index]?.quota?.windows ?? []),
      now,
    )

  const load = useCallback(
    () =>
      getSharing()
        .then((s) => {
          setState(s)
          setOwnerName(s.owner)
        })
        .catch((err) => toast(`Couldn’t load sharing: ${err.message}`)),
    [],
  )

  const saveOwner = () => {
    if (state && owner.trim() !== state.owner) setOwner(owner).then((r) => setState({ ...state, owner: r.owner })).catch((err) => toast(`Couldn’t save name: ${err.message}`))
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load()
    fetch('/connect/networks')
      .then((r) => r.json() as Promise<Networks>)
      .then((n) => setGateway(n.lan?.dashboard ?? n.tailnet?.dashboard ?? null))
      .catch(() => setGateway(null))
  }, [load])

  const share = async (pool: Pool, until: number | null | false) => {
    if (!state) return
    try {
      const { sharing } = await setSharing(pool, until)
      setState({ ...state, sharing })
    } catch (err) {
      toast(`Couldn’t change sharing: ${(err as Error).message}`)
    }
  }

  const keep = async (pool: Pool, percent: number) => {
    if (!state) return
    try {
      const { floors } = await setFloor(pool, percent)
      setState({ ...state, floors })
    } catch (err) {
      toast(`Couldn’t change what you keep: ${(err as Error).message}`)
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
      <PageHead title="Sharing" sub="Lend a pool to peers’ proxies when they run out. Off unless you turn it on.">
        <label className="share-owner faint">
          Peers see you as
          <input
            className="input"
            placeholder="Your name"
            value={owner}
            onChange={(e) => setOwnerName(e.target.value)}
            onBlur={saveOwner}
            onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
          />
        </label>
      </PageHead>

      <div className="panel klist">
        {POOLS.map((p) => {
          const choices = choicesFor(p.provider)
          const choice = choices.find((c) => c.id === picked[p.id]) ?? choices[0]
          const shared = state?.sharing[p.id]
          const current = shared && (shared.until === null || shared.until > now) ? shared : null
          return (
            <div key={p.id} className="krow">
              <span className="krow-key">
                <ProviderMark of={p.id} />
                {p.label}
              </span>
              <span className="share-when">
                {current ? (
                  <span className="mono">
                    {current.until === null ? 'Shared until you turn it off' : `Shared until ${formatStamp(current.until, now)} · ${formatRelative(current.until, now).replace('in ', '')} left`}
                  </span>
                ) : (
                  <select
                    className="input"
                    aria-label={`How long to share ${p.label}`}
                    value={choice.id}
                    onChange={(e) => setPicked({ ...picked, [p.id]: e.target.value })}
                  >
                    {choices.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                )}
                <select
                  className="input share-floor"
                  aria-label={`Share of each ${p.label} limit to keep for yourself`}
                  value={state?.floors[p.id] ?? 0}
                  disabled={!state}
                  onChange={(e) => keep(p.id, Number(e.target.value))}
                >
                  {FLOORS.map((f) => (
                    <option key={f} value={f}>
                      {f ? `Keep ${f}% for me` : 'Keep nothing back'}
                    </option>
                  ))}
                </select>
              </span>
              <Switch on={!!current} label={`Share ${p.label}`} disabled={!state} onChange={() => share(p.id, current ? false : choice.until)} />
            </div>
          )
        })}
      </div>
      <p className="mono faint">
        {sharingAny
          ? 'Peers can use a shared pool only while it has a working account here, and only above what you keep.'
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
