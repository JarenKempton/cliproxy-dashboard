import { Copy, Eye, EyeOff, Plus, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { ConfirmDialog, copyText, PageHead, Segmented, toast } from '../components/ui'
import { listApiKeys, putApiKeys } from '../lib/api'
import { CHANGED_FILES, setupCommand, undoCommand, type Tool } from '../lib/connect'
import { maskKey } from '../lib/format'

// The proxy stores bare keys; names live in this browser until the dashboard
// has a backend of its own.
const LABELS_KEY = 'cpa:key-labels'
const loadLabels = (): Record<string, string> => {
  try {
    return JSON.parse(localStorage.getItem(LABELS_KEY) ?? '{}')
  } catch {
    return {}
  }
}

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

export function KeysPage() {
  const [keys, setKeys] = useState<string[] | null>(null)
  const [labels, setLabels] = useState(loadLabels)
  const [revealed, setRevealed] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [base, setBase] = useState(() => endpoints().at(-1)![0])
  const [tools, setTools] = useState<Tools>('both')
  const [mode, setMode] = useState<'command' | 'manual'>('command')
  const [showScript, setShowScript] = useState(false)

  const load = useCallback(async () => {
    try {
      setKeys(await listApiKeys())
    } catch (err) {
      toast(`Couldn’t load keys: ${(err as Error).message}`)
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load()
  }, [load])

  const setLabel = (key: string, label: string) => {
    const next = { ...labels, [key]: label }
    setLabels(next)
    localStorage.setItem(LABELS_KEY, JSON.stringify(next))
  }

  const add = async () => {
    if (!keys) return
    const key = newKey()
    try {
      await putApiKeys([...keys, key])
      await load()
      setRevealed(key)
      setSelected(key)
      toast('Key created — name it after the machine that will use it')
    } catch (err) {
      toast(`Couldn’t create key: ${(err as Error).message}`)
    }
  }

  const confirmDelete = async () => {
    const key = deleting
    setDeleting(null)
    if (!key || !keys) return
    try {
      await putApiKeys(keys.filter((k) => k !== key))
      await load()
      if (selected === key) setSelected(null)
      toast('Key deleted')
    } catch (err) {
      toast(`Couldn’t delete key: ${(err as Error).message}`)
    }
  }

  const active = selected ?? keys?.[0] ?? null

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
            <div key={k} className={k === active ? 'krow selected' : 'krow'} onClick={() => setSelected(k)}>
              <input
                className="input krow-label"
                placeholder="Name (e.g. laptop)"
                size={Math.max(18, (labels[k] ?? '').length + 2)}
                value={labels[k] ?? ''}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => setLabel(k, e.target.value)}
              />
              <span className="mono krow-key">{revealed === k ? k : maskKey(k)}</span>
              <div className="page-actions">
                <button
                  className="btn btn-ghost btn-icon"
                  aria-label={revealed === k ? 'Hide key' : 'Show key'}
                  onClick={(e) => {
                    e.stopPropagation()
                    setRevealed(revealed === k ? null : k)
                  }}
                >
                  {revealed === k ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
                <button
                  className="btn btn-ghost btn-icon"
                  aria-label="Copy key"
                  onClick={(e) => {
                    e.stopPropagation()
                    copyText(k, 'Key copied')
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

      {active && (
        <section className="section">
          <div className="section-head">
            <h2>Connect a machine</h2>
            <span className="mono faint">using {labels[active] || maskKey(active)}</span>
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
                <div className="connect-files">
                  {TOOL_LIST[tools].map((t) => (
                    <div key={t} className="connect-file">
                      <span className="mono">{CHANGED_FILES[t].path}</span>
                      <span className="mono faint">{CHANGED_FILES[t].what}</span>
                    </div>
                  ))}
                </div>
                <div className="connect-actions">
                  <button className="btn btn-primary" onClick={() => copyText(setupCommand(base, active, TOOL_LIST[tools]), 'Setup command copied')}>
                    <Copy size={14} /> Copy setup command
                  </button>
                  <button className="btn" onClick={() => copyText(undoCommand(TOOL_LIST[tools]), 'Undo command copied')}>
                    <Copy size={14} /> Copy undo
                  </button>
                  <button className="btn btn-ghost" onClick={() => setShowScript(!showScript)}>
                    {showScript ? 'Hide script' : 'View script'}
                  </button>
                </div>
                {showScript && <pre className="code">{setupCommand(base, revealed === active ? active : maskKey(active), TOOL_LIST[tools])}</pre>}
                <p className="faint connect-note">
                  Paste into a terminal on the machine you’re connecting, from any folder. The first run backs up each file; undo
                  restores it.
                </p>
              </>
            ) : (
              <>
                <div className="connect-actions">
                  <button className="btn" onClick={() => copyText(manualSnippet(TOOL_LIST[tools], base, active), 'Snippet copied')}>
                    <Copy size={14} /> Copy
                  </button>
                </div>
                <pre className="code">{manualSnippet(TOOL_LIST[tools], base, revealed === active ? active : maskKey(active))}</pre>
                <p className="faint connect-note">Copy includes the full key.</p>
              </>
            )}
          </div>
        </section>
      )}

      <ConfirmDialog
        open={!!deleting}
        title="Delete this key?"
        body={
          <>
            Anything still using <span className="mono">{deleting && (labels[deleting] || maskKey(deleting))}</span> will get
            401 errors immediately. This Mac’s own Claude Code and Codex use one of these keys.
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
