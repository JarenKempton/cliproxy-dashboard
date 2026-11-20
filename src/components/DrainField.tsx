// The Routing row for soonest reset first. A dashboard setting, not config.yaml,
// so it applies when switched instead of waiting for the config review.

import { useEffect, useState } from 'react'
import { getDrain, setDrain } from '../lib/sharing'
import { Switch, toast } from './ui'

export function DrainField() {
  const [on, setOn] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    getDrain()
      .then((d) => setOn(d.on))
      .catch(() => {}) // the row stays hidden
  }, [])
  if (on === null) return null

  const toggle = () => {
    setBusy(true)
    setDrain(!on)
      .then((d) => setOn(d.on))
      .catch((e: Error) => toast(`Couldn’t change account order: ${e.message}`))
      .finally(() => setBusy(false))
  }

  return (
    <div className="cfield">
      <div className="cfield-text">
        <div className="cfield-label">Soonest reset first</div>
        <div className="muted cfield-help">Use the account whose weekly quota resets soonest, so less expires unused. Applies right away; off clears every account’s priority</div>
        <div className="faint mono cfield-path">auth file priority · set by the dashboard</div>
      </div>
      <div className="cfield-control">
        <Switch on={on} label="Soonest reset first" disabled={busy} onChange={toggle} />
      </div>
    </div>
  )
}
