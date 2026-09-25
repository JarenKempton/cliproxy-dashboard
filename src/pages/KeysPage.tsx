import { Copy, Eye, EyeOff, Plus, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { ConfirmDialog, copyText, PageHead, Segmented, toast } from '../components/ui'
import { listApiKeys, putApiKeys } from '../lib/api'
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

type Tool = 'claude' | 'codex' | 'env'

function snippet(tool: Tool, base: string, key: string) {
  if (tool === 'claude') {
    return `// ~/.claude/settings.json
{
  "env": {
    "ANTHROPIC_BASE_URL": "${base}",
    "ANTHROPIC_AUTH_TOKEN": "${key}"
  }
}`
  }
  if (tool === 'codex') {
    return `# ~/.codex/config.toml
model_provider = "cliproxy"

[model_providers.cliproxy]
name = "CLIProxy"
base_url = "${base}/v1"
wire_api = "responses"
experimental_bearer_token = "${key}"`
  }
  return `# Shell (any tool that reads these)
export ANTHROPIC_BASE_URL="${base}"
export ANTHROPIC_AUTH_TOKEN="${key}"
export OPENAI_BASE_URL="${base}/v1"
export OPENAI_API_KEY="${key}"`
}

export function KeysPage() {
  const [keys, setKeys] = useState<string[] | null>(null)
  const [labels, setLabels] = useState(loadLabels)
  const [revealed, setRevealed] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [base, setBase] = useState(() => endpoints().at(-1)![0])
  const [tool, setTool] = useState<Tool>('claude')

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
                value={tool}
                onChange={setTool}
                options={[
                  ['claude', 'Claude Code'],
                  ['codex', 'Codex'],
                  ['env', 'Shell env'],
                ]}
              />
              <Segmented value={base} onChange={setBase} options={endpoints()} />
              <button className="btn" style={{ marginLeft: 'auto' }} onClick={() => copyText(snippet(tool, base, active), 'Snippet copied')}>
                <Copy size={14} /> Copy
              </button>
            </div>
            <pre className="code">{snippet(tool, base, revealed === active ? active : maskKey(active))}</pre>
            <p className="faint connect-note">
              Copy includes the full key. A one-line installer that edits these files for you (with backup and undo) comes next.
            </p>
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
