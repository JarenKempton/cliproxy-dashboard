import { Copy, Plus, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ProviderMark } from '../components/ProviderMark'
import { ShareSetup, type Draft } from '../components/ShareSetup'
import { ConfirmDialog, copyText, PageHead, Switch, toast } from '../components/ui'
import { formatRelative, formatStamp } from '../lib/format'
import { providerOf } from '../lib/quota'
import {
  addPeer,
  getLenders,
  getSharing,
  joinPeer,
  pauseLender,
  describeFloors,
  peerConfig,
  POOLS,
  removePeer,
  setFloor,
  setOwner,
  setSharing,
  sharingChoices,
  type Lender,
  type Peer,
  type Pool,
  type SharingState,
} from '../lib/sharing'
import { lenderName } from '../lib/lenders'
import { useStore } from '../lib/store'

type Networks = Record<'tailnet' | 'lan', { dashboard: string } | null>

export function SharingPage() {
  const [state, setState] = useState<SharingState | null>(null)
  const [gateway, setGateway] = useState<string | null>(null)
  const [name, setName] = useState('')
  const nameInput = useRef<HTMLInputElement>(null)
  const [issued, setIssued] = useState<{
    name: string
    token: string
    code: string
    expires: number
  } | null>(null)
  const [byHand, setByHand] = useState(false)
  const [link, setLink] = useState('')
  const [lenders, setLenders] = useState<Lender[] | null>(null)
  const [pausing, setPausing] = useState<string | null>(null)
  const [removing, setRemoving] = useState<Peer | null>(null)
  const [owner, setOwnerName] = useState('')
  const [drafts, setDrafts] = useState<Partial<Record<Pool, Draft>>>({})
  const { files, quotas, now, loaded } = useStore()
  // Only pools you have an account for, plus any still shared so it can be stopped.
  const pools = POOLS.filter((p) => files.some((f) => providerOf(f) === p.provider) || state?.sharing[p.id])

  // The quota windows this pool's accounts report, plus any already kept.
  const windowsFor = (provider: string, kept: Record<string, number>) => [
    ...new Set([
      ...files.filter((f) => !f.disabled && providerOf(f) === provider).flatMap((f) => (quotas[f.auth_index]?.quota?.windows ?? []).map((w) => w.label)),
      ...Object.keys(kept),
    ]),
  ]

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
    if (state && owner.trim() !== state.owner)
      setOwner(owner)
        .then((r) => setState({ ...state, owner: r.owner }))
        .catch((err) => toast(`Couldn’t save name: ${err.message}`))
  }

  const loadLenders = useCallback(
    () =>
      getLenders()
        .then(setLenders)
        .catch(() => setLenders([])),
    [],
  )

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load()
    loadLenders()
    fetch('/connect/networks')
      .then((r) => r.json() as Promise<Networks>)
      .then((n) => setGateway(n.lan?.dashboard ?? n.tailnet?.dashboard ?? null))
      .catch(() => setGateway(null))
  }, [load, loadLenders])

  const share = async (pool: Pool, until: number | null | false) => {
    if (!state) return
    try {
      const { sharing } = await setSharing(pool, until)
      setState({ ...state, sharing })
    } catch (err) {
      toast(`Couldn’t change sharing: ${(err as Error).message}`)
    }
  }

  const startDraft = (pool: Pool) => setDrafts({ ...drafts, [pool]: { choice: '', floors: { ...(state?.floors[pool] ?? {}) } } })

  const start = async (pool: Pool, until: number | null) => {
    if (!state) return
    const draft = drafts[pool]!
    try {
      let floors = state.floors
      for (const [w, percent] of Object.entries(draft.floors))
        if ((state.floors[pool]?.[w] ?? 0) !== percent) floors = (await setFloor(pool, w, percent)).floors
      const { sharing } = await setSharing(pool, until)
      setState({ ...state, sharing, floors })
      setDrafts({ ...drafts, [pool]: undefined })
    } catch (err) {
      toast(`Couldn’t start sharing: ${(err as Error).message}`)
    }
  }

  const add = async () => {
    const peer = name.trim()
    if (!peer) return nameInput.current?.focus()
    try {
      setIssued({ name: peer, ...(await addPeer(peer)) })
      setByHand(false)
      setName('')
      await load()
    } catch (err) {
      toast(`Couldn’t add peer: ${(err as Error).message}`)
    }
  }

  const join = async () => {
    try {
      const { owner, gateway: at } = await joinPeer(link)
      toast(`Joined ${owner || new URL(at).hostname}. Your proxy now falls back to their shared pools.`)
      setLink('')
      await loadLenders()
    } catch (err) {
      toast(`Couldn’t join: ${(err as Error).message}`)
    }
  }

  const pause = async (lender: Lender) => {
    setPausing(lender.gateway)
    try {
      await pauseLender(lender.gateway, !lender.paused)
      await loadLenders()
    } catch (err) {
      toast(`Couldn’t ${lender.paused ? 'resume' : 'pause'} borrowing: ${(err as Error).message}`)
    } finally {
      setPausing(null)
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

      {loaded && pools.length === 0 && <div className="empty">No accounts to share yet. Add one on the Accounts page.</div>}
      <div className="panel klist">
        {pools.map((p) => {
          const shared = state?.sharing[p.id]
          const current = shared && (shared.until === null || shared.until > now) ? shared : null
          const kept = describeFloors(state?.floors[p.id] ?? {})
          return (
            <div key={p.id} className="krow share-row">
              <span className="krow-key">
                <ProviderMark of={p.id} />
                {p.label}
              </span>
              <span className="share-when mono">
                {current
                  ? [
                      current.until === null
                        ? 'Shared until you turn it off'
                        : `Shared until ${formatStamp(current.until, now)} · ${formatRelative(current.until, now).replace('in ', '')} left`,
                      kept && `keeping ${kept}`,
                    ]
                      .filter(Boolean)
                      .join(' · ')
                  : !drafts[p.id] && <span className="faint">Not shared</span>}
              </span>
              <Switch
                on={!!current || !!drafts[p.id]}
                label={`Share ${p.label}`}
                disabled={!state}
                onChange={() => (current ? share(p.id, false) : drafts[p.id] ? setDrafts({ ...drafts, [p.id]: undefined }) : startDraft(p.id))}
              />
              {!current && drafts[p.id] && (
                <ShareSetup
                  label={p.label}
                  choices={choicesFor(p.provider)}
                  windows={windowsFor(p.provider, drafts[p.id]!.floors)}
                  draft={drafts[p.id]!}
                  onChange={(d) => setDrafts({ ...drafts, [p.id]: d })}
                  onCancel={() => setDrafts({ ...drafts, [p.id]: undefined })}
                  onStart={(until) => start(p.id, until)}
                />
              )}
            </div>
          )
        })}
      </div>
      <p className="mono faint">
        {sharingAny
          ? 'Peers can use a shared pool only while it has a working account here, and only while every window has more left than you keep.'
          : 'Nothing is shared. Every peer request is refused before it reaches the proxy.'}
      </p>

      <section className="section">
        <div className="section-head">
          <h2>Peers</h2>
        </div>
        <div className="panel klist">
          {state?.peers.map((peer) => (
            <div key={peer.id} className="krow peer-row">
              <span>{peer.name}</span>
              <span className="mono faint">
                added {formatRelative(peer.createdAt)} · usage under key “Pool: {peer.name}”
              </span>
              <button className="btn btn-ghost btn-icon" aria-label={`Remove ${peer.name}`} onClick={() => setRemoving(peer)}>
                <Trash2 size={14} />
              </button>
            </div>
          ))}
          <div className="krow">
            <input
              className="input krow-label"
              ref={nameInput}
              placeholder="Peer name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && add()}
            />
            <span />
            <button className="btn btn-primary" onClick={add}>
              <Plus size={14} /> Add peer
            </button>
          </div>
        </div>
      </section>

      {issued && (
        <section className="section">
          <div className="section-head">
            <h2>Invite for {issued.name}</h2>
          </div>
          <div className="panel invite">
            <span className="mono invite-link">{`${gateway ?? '<this dashboard>'}/pool/invite/${issued.code}`}</span>
            <button className="btn" onClick={() => copyText(`${gateway ?? '<this dashboard>'}/pool/invite/${issued.code}`, 'Invite link copied')}>
              <Copy size={14} /> Copy link
            </button>
          </div>
          <p className="mono faint">
            Send this to {issued.name}. They paste it under “Join a peer” on their Sharing page. Works once, until {formatStamp(issued.expires, now)}.{' '}
            <button className="btn-link" onClick={() => setByHand(!byHand)}>
              {byHand ? 'Hide' : 'Set up by hand instead'}
            </button>
          </p>
          {byHand && (
            <>
              <div className="section-head">
                <span className="faint">Add to {issued.name}’s proxy config.yaml</span>
                <button className="btn btn-ghost" onClick={() => copyText(peerConfig(gateway ?? '<this dashboard>', issued.token), 'Config copied')}>
                  <Copy size={14} /> Copy
                </button>
              </div>
              <pre className="panel mono peer-config">{peerConfig(gateway ?? '<this dashboard>', issued.token)}</pre>
            </>
          )}
        </section>
      )}

      <section className="section">
        <div className="section-head">
          <h2>Join a peer</h2>
        </div>
        <div className="panel invite">
          <input
            className="input mono invite-input"
            placeholder="Paste an invite link"
            value={link}
            onChange={(e) => setLink(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && link.trim() && join()}
          />
          <button className="btn btn-primary" onClick={join} disabled={!link.trim()}>
            Join
          </button>
        </div>
        {lenders && lenders.length > 0 && (
          <>
            <p className="mono faint lenders">Borrowing from</p>
            <div className="panel klist">
              {lenders.map((l) => (
                <div key={l.gateway} className="krow">
                  <span>
                    {lenderName(l)}
                    {l.paused && <span className="faint"> · paused</span>}
                  </span>
                  <span className="mono faint">
                    {l.error
                      ? `can’t reach them (${l.error})`
                      : l.pools.length
                        ? l.pools
                            .map(
                              (p) =>
                                `${POOLS.find((x) => x.id === p.pool)?.label ?? p.pool} ${p.until === null ? 'until they stop' : `until ${formatStamp(p.until, now)}`}`,
                            )
                            .join(' · ')
                        : 'not sharing anything right now'}
                  </span>
                  <Switch
                    on={!l.paused}
                    label={`${l.paused ? 'Resume' : 'Pause'} borrowing from ${lenderName(l)}`}
                    disabled={pausing === l.gateway}
                    onChange={() => pause(l)}
                  />
                </div>
              ))}
            </div>
          </>
        )}
      </section>

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
