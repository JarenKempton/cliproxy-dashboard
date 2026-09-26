import { Copy, Eye, EyeOff, Plus, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { ConnectMachine } from '../components/ConnectMachine'
import { ConfirmDialog, copyText, PageHead, toast } from '../components/ui'
import { listApiKeys, putApiKeys } from '../lib/api'
import { maskKey } from '../lib/format'
import { getDevices, getKeyLabels, hashKey, setKeyLabel } from '../lib/usage'

function newKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return 'sk-cpa-' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
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
    } catch (err) {
      toast(`Couldn’t create key: ${(err as Error).message}`)
    }
  }

  const confirmDelete = async () => {
    const target = deleting
    setDeleting(null)
    if (!target || !keys) return
    try {
      await putApiKeys(keys.filter((k) => k.key !== target.key).map((k) => k.key))
      await load()
      toast('Key deleted')
    } catch (err) {
      toast(`Couldn’t delete key: ${(err as Error).message}`)
    }
  }


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
            <div key={k.key} className="krow">
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
          <ConnectMachine keys={keys} onKeysChanged={load} />
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
