// Codex reset credits: a quiet line on the card; spending one takes a
// deliberate trip through a confirmation that spells out what happens.

import { RotateCcw } from 'lucide-react'
import { useState } from 'react'
import type { AuthFile } from '../lib/api'
import { formatStamp } from '../lib/format'
import { spendResetCredit, type QuotaWindow, type ResetCredits as Credits } from '../lib/quota'
import { accountName } from '../lib/store'
import { ConfirmDialog, toast } from './ui'

const dateFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' })

export function ResetCredits({
  file,
  credits,
  windows,
  onSpent,
}: {
  file: AuthFile
  credits: Credits
  windows: QuotaWindow[]
  onSpent: () => void
}) {
  const [confirming, setConfirming] = useState(false)
  const [spending, setSpending] = useState(false)
  if (credits.available <= 0) return null

  const plural = credits.available === 1 ? 'credit' : 'credits'
  const soonest = credits.expiresAtMs[0]
  // Spending a credit while there's still room left mostly wastes it.
  const roomLeft = windows.filter((w) => w.usedPercent < 100)

  const spend = async () => {
    setSpending(true)
    try {
      await spendResetCredit(file)
      toast('Reset applied')
      onSpent()
    } catch (err) {
      toast(`Reset failed: ${(err as Error).message}`)
    } finally {
      setSpending(false)
      setConfirming(false)
    }
  }

  return (
    <>
      <div className="reset-credits">
        <span className="muted">
          {credits.available} reset {plural}
          {soonest && <span className="faint"> · expires {dateFmt.format(soonest)}</span>}
        </span>
        <button className="btn btn-small" onClick={() => setConfirming(true)}>
          <RotateCcw size={12} /> Use reset…
        </button>
      </div>

      <ConfirmDialog
        open={confirming}
        title="Use a reset credit?"
        body={
          <>
            <p>
              Resets Codex usage limits for <strong>{accountName(file)}</strong> right away. This uses{' '}
              {credits.available === 1 ? 'your only credit' : `1 of your ${credits.available} credits`} and can’t be undone.
            </p>
            {roomLeft.length > 0 && (
              <p className="warn-text reset-warning">
                {roomLeft.map((w) => `${w.label} still has ${Math.round(100 - w.usedPercent)}% left`).join(', ')}
                {' — '}using a credit now wastes most of it.
              </p>
            )}
            {credits.expiresAtMs.length > 0 && (
              <p className="faint">Credits expire {credits.expiresAtMs.map((t) => formatStamp(t)).join(', ')}.</p>
            )}
          </>
        }
        confirmLabel={spending ? 'Applying…' : 'Use 1 credit'}
        onConfirm={spend}
        onCancel={() => setConfirming(false)}
      />
    </>
  )
}
