import { Copy, Eye, EyeOff, Plus, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { ConfirmDialog, copyText, PageHead, Segmented, toast } from '../components/ui'
import { listApiKeys, putApiKeys } from '../lib/api'
import { CHANGED_FILES, type Tool } from '../lib/connect'
import { formatRelative, maskKey } from '../lib/format'
import { dedicateKey, getDevices, getKeyLabels, hashKey, setKeyLabel } from '../lib/usage'

function newKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return 'sk-cpa-' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

function endpoints(): [string, string][] {
  const out: [string, string][] = [['http://127.0.0.1:8317', 'This Mac']]
  // Served over the tailnet: the same host on 443 reaches the proxy.
  if (location.hostname.endsWith('.ts.net')) out.push([`https://${location.hostname}`, 'Tailnet'])
  return out
}

type Tools = 'both' | 'claude' | 'codex'
const TOOL_LIST: Record<Tools, Tool[]> = { both: ['claude', 'codex'], claude: ['claude'], codex: ['codex'] }

// What the setup command writes, for doing it by hand.
function manualSnippet(tools: Tool[], base: string, key: string) {
  const parts = []
  if (tools.includes('claude')) {
    parts.push(`// ~/.claude/settings.json  (merge into "env")
{
  "env": {
    "ANTHROPIC_BASE_URL": "${base}",
    "ANTHROPIC_AUTH_TOKEN": "${key}"
  }
}`)
  }
  if (tools.includes('codex')) {
    parts.push(`# ~/.codex/config.toml
model_provider = "cliproxy"

[model_providers.cliproxy]
name = "CLIProxy"
base_url = "${base}/v1"
wire_api = "responses"
experimental_bearer_token = "${key}"`)
  }
  return parts.join('\n\n')
}

// Labels used to live in this browser; move any leftovers to the server once.
const LEGACY_LABELS_KEY = 'cpa:key-labels'
async function migrateLegacyLabels(serverLabels: Record<string, string>) {
  const legacy = JSON.parse(localStorage.getItem(LEGACY_LABELS_KEY) ?? '{}') as Record<string, string>
  for (const [key, label] of Object.entries(legacy)) {
    if (label.trim() && !serverLabels[await hashKey(key)]) await setKeyLabel(key, label.trim())
  }
  localStorage.removeItem(LEGACY_LABELS_KEY)
}

type KeyInfo = { key: string; hash: string; label: string; machine: string | null }

export function KeysPage() {
  const [keys, setKeys] = useState<KeyInfo[] | null>(null)
  const [revealed, setRevealed] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<KeyInfo | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [machine, setMachine] = useState('')
  const [base, setBase] = useState(() => endpoints().at(-1)![0])
  const [tools, setTools] = useState<Tools>('both')
  const [mode, setMode] = useState<'command' | 'manual'>('command')
  const [setup, setSetup] = useState<{ code: string; expires: number; origin: string; machine: string } | null>(null)
  const [now, setNow] = useState(() => Date.now())

  // Proxy keys, joined with their labels and dedicated machines from the usage server.
  const load = useCallback(async () => {
    try {
      const [raw, labels, devices] = await Promise.all([listApiKeys(), getKeyLabels(), getDevices()])
      if (localStorage.getItem(LEGACY_LABELS_KEY)) {
        await migrateLegacyLabels(labels)
        return load()
      }
      const machineOf = new Map(devices.filter((d) => d.kind === 'key' && d.nameSource === 'custom').map((d) => [d.value, d.name]))
      setKeys(
        await Promise.all(
          raw.map(async (key) => {
            const hash = await hashKey(key)
            return { key, hash, label: labels[hash] ?? '', machine: machineOf.get(hash) ?? null }
          }),
        ),
      )
    } catch (err) {
      toast(`Couldn’t load keys: ${(err as Error).message}`)
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load()
  }, [load])

  // A code is minted for one machine/tools/address; changing any of them voids it.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSetup(null)
  }, [machine, tools, base])

  useEffect(() => {
    if (!setup) return
    const t = setInterval(() => setNow(Date.now()), 15e3)
    return () => clearInterval(t)
  }, [setup])

  const editLabel = (key: string, label: string) =>
    setKeys((prev) => prev && prev.map((k) => (k.key === key ? { ...k, label } : k)))

  const saveLabel = (info: KeyInfo) =>
    setKeyLabel(info.key, info.label).catch((err) => toast(`Couldn’t save label: ${err.message}`))

  const add = async () => {
    if (!keys) return
    const key = newKey()
    try {
      await putApiKeys([...keys.map((k) => k.key), key])
      await load()
      setRevealed(key)
      setSelected(key)
    } catch (err) {
      toast(`Couldn’t create key: ${(err as Error).message}`)
    }
  }

  // Each machine gets its own key, so its usage is attributed to it and it can
  // be revoked alone. Reconnecting a machine reuses its key.
  const createSetup = async () => {
    const name = machine.trim()
    if (!keys || !name) return
    try {
      let key = keys.find((k) => k.machine === name)?.key
      if (!key) {
        key = newKey()
        await putApiKeys([...keys.map((k) => k.key), key])
        await setKeyLabel(key, name)
        await dedicateKey(key, name)
        await load()
      }
      const res = await fetch('/connect/codes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, url: base, tools: TOOL_LIST[tools] }),
      })
      if (!res.ok) throw new Error(((await res.json()) as { error?: string }).error ?? `HTTP ${res.status}`)
      setSetup({ ...(await res.json()), machine: name })
      setNow(Date.now())
    } catch (err) {
      toast(`Couldn’t create setup command: ${(err as Error).message}`)
    }
  }

  const confirmDelete = async () => {
    const target = deleting
    setDeleting(null)
    if (!target || !keys) return
    try {
      await putApiKeys(keys.filter((k) => k.key !== target.key).map((k) => k.key))
      await load()
      if (selected === target.key) setSelected(null)
      toast('Key deleted')
    } catch (err) {
      toast(`Couldn’t delete key: ${(err as Error).message}`)
    }
  }

  const active = keys?.find((k) => k.key === selected) ?? keys?.[0] ?? null
  const reusing = keys?.some((k) => k.machine === machine.trim())

  return (
    <div className="page">
      <PageHead title="API keys" sub="Keys your machines and projects use to call the proxy">
        <button className="btn btn-primary" onClick={add} disabled={!keys}>
          <Plus size={14} /> New key
        </button>
      </PageHead>

      {keys && keys.length === 0 && <div className="empty">No keys configured.</div>}
      {keys && keys.length > 0 && (
        <div className="panel klist">
          {keys.map((k) => (
            <div key={k.key} className={k.key === active?.key ? 'krow selected' : 'krow'} onClick={() => setSelected(k.key)}>
              <input
                className="input krow-label"
                placeholder="Label (e.g. Primary)"
                size={Math.max(18, k.label.length + 2)}
                value={k.label}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => editLabel(k.key, e.target.value)}
                onBlur={() => saveLabel(k)}
                onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
              />
              <span className="krow-key">
                <span className="mono">{revealed === k.key ? k.key : maskKey(k.key)}</span>
                {k.machine && <span className="tag">machine · {k.machine}</span>}
              </span>
              <div className="page-actions">
                <button
                  className="btn btn-ghost btn-icon"
                  aria-label={revealed === k.key ? 'Hide key' : 'Show key'}
                  onClick={(e) => {
                    e.stopPropagation()
                    setRevealed(revealed === k.key ? null : k.key)
                  }}
                >
                  {revealed === k.key ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
                <button
                  className="btn btn-ghost btn-icon"
                  aria-label="Copy key"
                  onClick={(e) => {
                    e.stopPropagation()
                    copyText(k.key, 'Key copied')
                  }}
                >
                  <Copy size={14} />
                </button>
                <button
                  className="btn btn-ghost btn-icon"
                  aria-label="Delete key"
                  onClick={(e) => {
                    e.stopPropagation()
                    // Removing the last key would cut off every client at once.
                    if (keys.length === 1) toast('Can’t delete the last key — create another one first')
                    else setDeleting(k)
                  }}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {keys && (
        <section className="section">
          <div className="section-head">
            <h2>Connect a machine</h2>
          </div>
          <div className="panel connect">
            <div className="connect-controls">
              <Segmented
                value={tools}
                onChange={setTools}
                options={[
                  ['both', 'Claude Code + Codex'],
                  ['claude', 'Claude Code'],
                  ['codex', 'Codex'],
                ]}
              />
              <Segmented value={base} onChange={setBase} options={endpoints()} />
              <Segmented
                value={mode}
                onChange={setMode}
                options={[
                  ['command', 'Command'],
                  ['manual', 'Manual'],
                ]}
              />
            </div>
            {mode === 'command' ? (
              <>
                <div className="connect-machine">
                  <label className="eyebrow" htmlFor="machine-name">
                    Machine
                  </label>
                  <input
                    id="machine-name"
                    className="input"
                    placeholder="e.g. laptop"
                    value={machine}
                    onChange={(e) => setMachine(e.target.value)}
                  />
                  <span className="faint">
                    {machine.trim() ? (reusing ? 'reuses this machine’s key' : 'gets its own new key') : ''}
                  </span>
                </div>
                <div className="connect-files">
                  {TOOL_LIST[tools].map((t) => (
                    <div key={t} className="connect-file">
                      <span className="mono">{CHANGED_FILES[t].path}</span>
                      <span className="mono faint">{CHANGED_FILES[t].what}</span>
                    </div>
                  ))}
                </div>
                {!setup || setup.expires < now ? (
                  <div className="connect-actions">
                    <button className="btn btn-primary" onClick={createSetup} disabled={!machine.trim()}>
                      {setup ? 'Create a new setup command' : 'Create setup command'}
                    </button>
                    <a className="btn btn-ghost" href="/connect" target="_blank" rel="noopener">
                      View script
                    </a>
                  </div>
                ) : (
                  <div className="connect-cmds">
                    <div className="cmd">
                      <code className="mono">
                        curl -fsSL {setup.origin}/connect | sh -s -- <b>{setup.code}</b>
                      </code>
                      <button
                        className="btn btn-primary"
                        onClick={() => copyText(`curl -fsSL ${setup.origin}/connect | sh -s -- ${setup.code}`, 'Setup command copied')}
                      >
                        <Copy size={14} /> Copy
                      </button>
                    </div>
                    <div className="cmd-meta mono faint">
                      for {setup.machine} · single-use · expires {formatRelative(setup.expires, now)} ·{' '}
                      <a href="/connect" target="_blank" rel="noopener">
                        view script
                      </a>
                    </div>
                    <div className="cmd subtle">
                      <code className="mono">curl -fsSL {setup.origin}/connect/undo | sh</code>
                      <button className="btn btn-ghost" onClick={() => copyText(`curl -fsSL ${setup.origin}/connect/undo | sh`, 'Undo command copied')}>
                        <Copy size={14} /> Copy undo
                      </button>
                    </div>
                  </div>
                )}
                <p className="faint connect-note">
                  {location.hostname.endsWith('.ts.net')
                    ? 'Paste into a terminal on the machine you’re connecting. The first run backs up each file; undo restores it.'
                    : 'Only this Mac can reach this address. Open the dashboard through its tailnet URL to connect other machines.'}
                </p>
              </>
            ) : (
              active && (
                <>
                  <div className="connect-actions">
                    <span className="mono faint">using {active.label || maskKey(active.key)}</span>
                    <button className="btn" onClick={() => copyText(manualSnippet(TOOL_LIST[tools], base, active.key), 'Snippet copied')}>
                      <Copy size={14} /> Copy
                    </button>
                  </div>
                  <pre className="code">{manualSnippet(TOOL_LIST[tools], base, revealed === active.key ? active.key : maskKey(active.key))}</pre>
                  <p className="faint connect-note">Copy includes the full key. Select a key above to use a different one.</p>
                </>
              )
            )}
          </div>
        </section>
      )}

      <ConfirmDialog
        open={!!deleting}
        title="Delete this key?"
        body={
          <>
            Anything still using <span className="mono">{deleting && (deleting.label || maskKey(deleting.key))}</span> will get
            401 errors immediately.
          </>
        }
        confirmLabel="Delete key"
        danger
        onConfirm={confirmDelete}
        onCancel={() => setDeleting(null)}
      />
    </div>
  )
}
