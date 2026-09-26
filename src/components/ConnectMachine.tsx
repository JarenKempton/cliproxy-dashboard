// Connect a machine: name it, pick tools and a network, get one command.
// Each machine gets its own proxy key (reused if it reconnects), so its usage
// is attributed to it and it can be revoked alone.

import { Check, Copy } from 'lucide-react'
import { useEffect, useState } from 'react'
import { putApiKeys } from '../lib/api'
import type { Tool } from '../lib/connect'
import { formatRelative } from '../lib/format'
import { dedicateKey, setKeyLabel } from '../lib/usage'
import { ProviderMark } from './ProviderMark'
import { copyText, Segmented, toast } from './ui'

type Network = 'tailnet' | 'lan'
type Networks = Record<Network, { dashboard: string; proxy: string } | null>
type Setup = { command: string; undo: string; expires: number }

export type KeyInfo = { key: string; label: string; machine: string | null }

const TOOLS: [Tool, string][] = [
  ['claude', 'Claude Code'],
  ['codex', 'Codex'],
]

function newKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return 'sk-cpa-' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

export function ConnectMachine({ keys, onKeysChanged }: { keys: KeyInfo[]; onKeysChanged: () => Promise<void> }) {
  const [networks, setNetworks] = useState<Networks | null>(null)
  const [machine, setMachine] = useState('')
  const [tools, setTools] = useState<Tool[]>([])
  const [network, setNetwork] = useState<Network>('tailnet')
  const [setup, setSetup] = useState<Setup | null>(null)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    fetch('/connect/networks')
      .then((r) => r.json() as Promise<Networks>)
      .then((n) => {
        setNetworks(n)
        if (!n.tailnet && n.lan) setNetwork('lan')
      })
      .catch(() => toast('Couldn’t load network addresses'))
  }, [])

  // A command is for one machine/tools/network; changing any of them voids it.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSetup(null)
  }, [machine, tools, network])

  useEffect(() => {
    if (!setup) return
    const t = setInterval(() => setNow(Date.now()), 15e3)
    return () => clearInterval(t)
  }, [setup])

  const toggleTool = (t: Tool) => setTools((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]))
  const name = machine.trim()
  const ready = name && tools.length > 0 && networks?.[network]

  const create = async () => {
    try {
      let key = keys.find((k) => k.machine === name)?.key
      if (!key) {
        key = newKey()
        await putApiKeys([...keys.map((k) => k.key), key])
        await setKeyLabel(key, name)
        await dedicateKey(key, name)
        await onKeysChanged()
      }
      const res = await fetch('/connect/codes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, tools, network }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
      setSetup(body)
      setNow(Date.now())
    } catch (err) {
      toast(`Couldn’t create command: ${(err as Error).message}`)
    }
  }

  return (
    <div className="panel connect">
      {/* One labeled row per choice. */}
      <div className="connect-form">
        <label className="eyebrow" htmlFor="connect-machine">
          Machine
        </label>
        <input
          id="connect-machine"
          className="input connect-name"
          placeholder="e.g. work laptop"
          value={machine}
          onChange={(e) => setMachine(e.target.value)}
        />

        <span className="eyebrow">Tools</span>
        <div className="connect-options">
          {TOOLS.map(([tool, label]) => (
            <button key={tool} className="chip" aria-pressed={tools.includes(tool)} onClick={() => toggleTool(tool)}>
              <span className="chip-check">{tools.includes(tool) && <Check size={11} strokeWidth={3} />}</span>
              <ProviderMark of={tool} size={13} />
              {label}
            </button>
          ))}
        </div>

        <span className="eyebrow">Network</span>
        <div className="connect-options">
          <Segmented
            value={network}
            onChange={setNetwork}
            options={[
              ['tailnet', 'Tailscale'],
              ['lan', 'Local network'],
            ]}
          />
        </div>

        <span />
        <div>
          <button className="btn btn-primary" onClick={create} disabled={!ready}>
            Create command
          </button>
        </div>
      </div>

      {setup && setup.expires > now && (
        <div className="connect-result">
          <div className="cmd">
            <code className="mono">{setup.command}</code>
            <button className="btn btn-primary" onClick={() => copyText(setup.command, 'Command copied')}>
              <Copy size={14} /> Copy
            </button>
          </div>
          <div className="connect-meta faint">
            <span>Expires {formatRelative(setup.expires, now)}</span>
            <button className="linklike" onClick={() => copyText(setup.undo, 'Undo command copied')}>
              Copy undo
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
