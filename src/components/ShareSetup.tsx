import type { Choice, Floors } from '../lib/sharing'

const FLOORS = [0, 10, 20, 30, 40, 50, 60, 70]

export type Draft = { choice: string; floors: Floors }

export function ShareSetup({
  label,
  choices,
  windows,
  draft,
  onChange,
  onCancel,
  onStart,
}: {
  label: string
  choices: Choice[]
  windows: string[]
  draft: Draft
  onChange: (draft: Draft) => void
  onCancel: () => void
  onStart: (until: number | null) => void
}) {
  const choice = choices.find((c) => c.id === draft.choice) ?? choices[0]
  return (
    <div className="share-setup">
      <label className="share-field">
        <span className="faint">Share for</span>
        <select className="input" aria-label={`How long to share ${label}`} value={choice.id} onChange={(e) => onChange({ ...draft, choice: e.target.value })}>
          {choices.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
      </label>
      {windows.map((w) => (
        <label key={w} className="share-field share-floor">
          <span className="faint">Keep of {w}</span>
          <select
            className="input"
            aria-label={`Share of the ${label} ${w} window to keep for yourself`}
            value={draft.floors[w] ?? 0}
            onChange={(e) => onChange({ ...draft, floors: { ...draft.floors, [w]: Number(e.target.value) } })}
          >
            {FLOORS.map((f) => (
              <option key={f} value={f}>
                {f ? `${f}%` : 'none'}
              </option>
            ))}
          </select>
        </label>
      ))}
      <div className="share-actions">
        <button className="btn btn-ghost" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn btn-primary" onClick={() => onStart(choice.until)}>
          Start sharing
        </button>
      </div>
    </div>
  )
}
