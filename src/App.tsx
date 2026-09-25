import { useEffect, useState } from 'react'
import { ApiError, get } from './api'
import { mask } from './mask'
import { SECTIONS, type Section } from './sections'

type Verdict = 'keep' | 'kill' | undefined
type Result = { ok: true; data: unknown } | { ok: false; error: ApiError | Error }

const VERDICTS_KEY = 'cpa-dashboard:verdicts'

function loadVerdicts(): Record<string, Verdict> {
  try {
    return JSON.parse(localStorage.getItem(VERDICTS_KEY) ?? '{}')
  } catch {
    return {}
  }
}

function Endpoint({ path }: { path: string }) {
  const [result, setResult] = useState<Result>()

  useEffect(() => {
    let cancelled = false
    get(path)
      .then((data) => !cancelled && setResult({ ok: true, data }))
      .catch((error) => !cancelled && setResult({ ok: false, error }))
    return () => {
      cancelled = true
    }
  }, [path])

  return (
    <div className="endpoint">
      <div className="endpoint-path">GET {path}</div>
      {!result && <div className="muted">Loading…</div>}
      {result && !result.ok && (
        <div className={result.error instanceof ApiError && result.error.guard ? 'error guard' : 'error'}>
          {result.error instanceof ApiError ? `${result.error.status}: ` : ''}
          {result.error.message}
        </div>
      )}
      {result?.ok && <pre>{typeof result.data === 'string' ? result.data : JSON.stringify(mask(result.data), null, 2)}</pre>}
    </div>
  )
}

function SectionView({ section }: { section: Section }) {
  return (
    <>
      <h2>{section.title}</h2>
      <p className="muted">{section.blurb}</p>
      {section.endpoints.map((path) => (
        <Endpoint key={path} path={path} />
      ))}
    </>
  )
}

export default function App() {
  const [activeId, setActiveId] = useState(SECTIONS[0].id)
  const [verdicts, setVerdicts] = useState(loadVerdicts)
  const active = SECTIONS.find((s) => s.id === activeId) ?? SECTIONS[0]

  const setVerdict = (id: string, v: Verdict) => {
    const next = { ...verdicts, [id]: verdicts[id] === v ? undefined : v }
    setVerdicts(next)
    localStorage.setItem(VERDICTS_KEY, JSON.stringify(next))
  }

  const kept = SECTIONS.filter((s) => verdicts[s.id] === 'keep').map((s) => s.title)

  return (
    <div className="layout">
      <nav>
        <div className="brand">CLIProxy · prototype</div>
        {SECTIONS.map((s) => (
          <div key={s.id} className={s.id === activeId ? 'nav-item active' : 'nav-item'}>
            <button className="nav-link" onClick={() => setActiveId(s.id)}>
              {s.title}
            </button>
            <button
              className={verdicts[s.id] === 'keep' ? 'chip keep on' : 'chip keep'}
              title="Keep"
              onClick={() => setVerdict(s.id, 'keep')}
            >
              ✓
            </button>
            <button
              className={verdicts[s.id] === 'kill' ? 'chip kill on' : 'chip kill'}
              title="Kill"
              onClick={() => setVerdict(s.id, 'kill')}
            >
              ✕
            </button>
          </div>
        ))}
        <div className="summary muted">Keeping: {kept.length ? kept.join(', ') : 'nothing yet'}</div>
      </nav>
      <main>
        <SectionView key={active.id} section={active} />
      </main>
    </div>
  )
}
