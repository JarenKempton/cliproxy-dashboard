import { yaml as yamlLang } from '@codemirror/lang-yaml'
import { unifiedMergeView } from '@codemirror/merge'
import { EditorView } from '@codemirror/view'
import CodeMirror from '@uiw/react-codemirror'
import { RotateCw } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { parseDocument } from 'yaml'
import { ConfirmDialog, PageHead, Segmented, Switch, toast } from '../components/ui'
import { getConfigYaml, putConfigYaml } from '../lib/api'

type Path = (string | number)[]
type Field =
  | { path: Path; label: string; help?: string; kind: 'bool'; fallback: boolean }
  | { path: Path; label: string; help?: string; kind: 'int'; fallback: number; unit?: string }
  | { path: Path; label: string; help?: string; kind: 'text'; fallback: string; placeholder?: string }
  | { path: Path; label: string; help?: string; kind: 'select'; fallback: string; options: [string, string][] }

const SECTIONS: { title: string; fields: Field[] }[] = [
  {
    title: 'Routing',
    fields: [
      {
        path: ['routing', 'strategy'],
        label: 'Account selection',
        help: 'How requests spread across accounts that can serve them',
        kind: 'select',
        fallback: 'round-robin',
        options: [
          ['round-robin', 'Round robin — spread evenly'],
          ['fill-first', 'Fill first — use one until it’s exhausted'],
        ],
      },
      { path: ['request-retry'], label: 'Retries', help: 'Times to retry a failed request on another account', kind: 'int', fallback: 0 },
      { path: ['max-retry-credentials'], label: 'Max accounts per retry', help: '0 = no limit', kind: 'int', fallback: 0 },
      { path: ['max-retry-interval'], label: 'Max retry wait', kind: 'int', fallback: 0, unit: 'seconds' },
    ],
  },
  {
    title: 'When an account hits its limit',
    fields: [
      { path: ['disable-cooling'], label: 'Disable cooldown', help: 'Keep sending to an account after it reports a limit', kind: 'bool', fallback: false },
      { path: ['claude', 'model-level-cooling'], label: 'Claude: cool down per model', help: 'Only pause the model that hit its limit, not the whole account', kind: 'bool', fallback: false },
      { path: ['codex', 'model-level-cooling'], label: 'Codex: cool down per model', help: 'Only pause the model that hit its limit, not the whole account', kind: 'bool', fallback: false },
      { path: ['quota-exceeded', 'switch-preview-model'], label: 'Fall back to preview models', kind: 'bool', fallback: false },
    ],
  },
  {
    title: 'Network',
    fields: [{ path: ['proxy-url'], label: 'Outbound proxy', help: 'Route upstream traffic through a proxy', kind: 'text', fallback: '', placeholder: 'socks5://user:pass@host:1080' }],
  },
  {
    title: 'Logging',
    fields: [
      { path: ['usage-statistics-enabled'], label: 'Usage statistics', help: 'Record per-request usage (needed for cost tracking)', kind: 'bool', fallback: false },
      { path: ['logging-to-file'], label: 'Log to file', kind: 'bool', fallback: false },
      { path: ['request-log'], label: 'Full request logs', help: 'Saves request and response bodies — large and sensitive', kind: 'bool', fallback: false },
      { path: ['debug'], label: 'Debug logging', kind: 'bool', fallback: false },
      { path: ['logs-max-total-size-mb'], label: 'Log size cap', help: '0 = no cap', kind: 'int', fallback: 0, unit: 'MB' },
      { path: ['error-logs-max-files'], label: 'Error logs kept', kind: 'int', fallback: 10 },
    ],
  },
]

// Shown, not editable here: a wrong value can cut the dashboard off.
const LOCKED: { path: Path; label: string }[] = [
  { path: ['host'], label: 'Listen address' },
  { path: ['port'], label: 'Port' },
  { path: ['remote-management', 'allow-remote'], label: 'Remote management' },
]

const editorTheme = EditorView.theme(
  {
    '&': { backgroundColor: 'var(--bg)', fontSize: '12.5px' },
    '.cm-content, .cm-gutters': { fontFamily: 'var(--mono)' },
    '.cm-gutters': { backgroundColor: 'var(--bg)', borderRight: '1px solid var(--line)', color: 'var(--fg-3)' },
    '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'oklch(0.17 0 0)' },
    '&.cm-focused': { outline: 'none' },
  },
  { dark: true },
)

function FieldControl({ field, value, onChange }: { field: Field; value: unknown; onChange: (v: unknown) => void }) {
  switch (field.kind) {
    case 'bool':
      return <Switch on={Boolean(value)} label={field.label} onChange={() => onChange(!value)} />
    case 'int':
      return (
        <div className="cfield-num">
          <input
            className="input mono"
            type="number"
            min={0}
            value={String(value ?? field.fallback)}
            onChange={(e) => onChange(e.target.value === '' ? 0 : Math.max(0, Math.round(Number(e.target.value))))}
          />
          {field.unit && <span className="faint">{field.unit}</span>}
        </div>
      )
    case 'text':
      return <input className="input mono" placeholder={field.placeholder} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />
    case 'select':
      return (
        <select className="input" value={String(value ?? field.fallback)} onChange={(e) => onChange(e.target.value)}>
          {field.options.map(([v, label]) => (
            <option key={v} value={v}>
              {label}
            </option>
          ))}
        </select>
      )
  }
}

export function ConfigPage() {
  const [original, setOriginal] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [view, setView] = useState<'form' | 'yaml'>('form')
  const [reviewing, setReviewing] = useState(false)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    try {
      const text = await getConfigYaml()
      setOriginal(text)
      setDraft(text)
    } catch (err) {
      toast(`Couldn’t load config: ${(err as Error).message}`)
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load()
  }, [load])

  const doc = useMemo(() => parseDocument(draft), [draft])
  const parseError = doc.errors[0]?.message
  const dirty = original !== null && draft !== original

  const valueOf = (f: Field) => {
    const v = doc.getIn(f.path)
    return v === undefined || v === null ? f.fallback : v
  }

  const setValue = (f: Field, v: unknown) => {
    const next = parseDocument(draft)
    // An empty optional text field is removed rather than stored as "".
    if (f.kind === 'text' && v === '') next.deleteIn(f.path)
    else next.setIn(f.path, v)
    setDraft(next.toString({ lineWidth: 0 }))
  }

  const save = async () => {
    setSaving(true)
    try {
      await putConfigYaml(draft)
      setReviewing(false)
      toast('Saved — the proxy reloads its config automatically')
      await load()
    } catch (err) {
      toast(`Not saved: ${(err as Error).message}`)
    } finally {
      setSaving(false)
    }
  }

  const reviewExtensions = useMemo(
    () => (original === null ? [] : [yamlLang(), editorTheme, EditorView.editable.of(false), unifiedMergeView({ original, mergeControls: false })]),
    [original],
  )

  return (
    <div className="page config-page">
      <PageHead title="Config" sub="config.yaml · changes apply to the live proxy after you review them">
        <Segmented
          value={view}
          onChange={setView}
          options={[
            ['form', 'Settings'],
            ['yaml', 'YAML'],
          ]}
        />
        <button className="btn btn-ghost btn-icon" aria-label="Reload from proxy" title="Reload from proxy" onClick={load}>
          <RotateCw size={14} />
        </button>
      </PageHead>

      {original === null ? (
        <p className="faint">Loading…</p>
      ) : view === 'yaml' ? (
        <div className="panel editor">
          <CodeMirror value={draft} onChange={setDraft} theme="dark" extensions={[yamlLang(), editorTheme]} basicSetup={{ foldGutter: false }} minHeight="420px" />
        </div>
      ) : parseError ? (
        <div className="empty">
          The YAML has an error, so the settings form is unavailable: <span className="mono error-text">{parseError}</span>. Fix it in
          the YAML view.
        </div>
      ) : (
        <>
          {SECTIONS.map((section) => (
            <section key={section.title} className="section config-section">
              <div className="eyebrow">{section.title}</div>
              <div className="panel">
                {section.fields.map((f) => (
                  <div key={f.path.join('.')} className="cfield">
                    <div className="cfield-text">
                      <div className="cfield-label">{f.label}</div>
                      {f.help && <div className="muted cfield-help">{f.help}</div>}
                      <div className="faint mono cfield-path">{f.path.join('.')}</div>
                    </div>
                    <div className="cfield-control">
                      <FieldControl field={f} value={valueOf(f)} onChange={(v) => setValue(f, v)} />
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ))}
          <section className="section config-section">
            <div className="eyebrow">Server · edit in YAML</div>
            <div className="panel">
              {LOCKED.map((f) => (
                <div key={f.path.join('.')} className="cfield">
                  <div className="cfield-text">
                    <div className="cfield-label">{f.label}</div>
                    <div className="faint mono cfield-path">{f.path.join('.')}</div>
                  </div>
                  <div className="cfield-control mono">{String(doc.getIn(f.path) ?? '—')}</div>
                </div>
              ))}
            </div>
          </section>
        </>
      )}

      {dirty && (
        <div className="savebar">
          <span className="dot warn" />
          <span>Unsaved changes</span>
          {parseError && <span className="error-text mono">YAML error</span>}
          <div className="page-actions">
            <button className="btn btn-ghost" onClick={() => setDraft(original!)}>
              Discard
            </button>
            <button className="btn btn-primary" disabled={!!parseError} onClick={() => setReviewing(true)}>
              Review &amp; save
            </button>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={reviewing}
        wide
        title="Review changes"
        body="This is exactly what will be written to config.yaml. A backup of the current file is saved first."
        confirmLabel={saving ? 'Saving…' : 'Save to proxy'}
        onConfirm={save}
        onCancel={() => setReviewing(false)}
      >
        {reviewing && (
          <div className="panel editor review">
            <CodeMirror value={draft} theme="dark" extensions={reviewExtensions} basicSetup={{ foldGutter: false }} maxHeight="55vh" />
          </div>
        )}
      </ConfirmDialog>
    </div>
  )
}
