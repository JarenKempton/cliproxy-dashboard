// What peers lend this proxy, and what it lends them, for the Quota page.

import { useEffect, useState } from 'react'
import { getLenders, getSharing, type Lender, type SharingState } from './sharing'

const EVERY_MS = 5 * 60e3

export type SharingOverview = { lenders: Lender[]; lending: SharingState['sharing'] | null }

export function useSharingOverview(): SharingOverview {
  const [overview, setOverview] = useState<SharingOverview>({ lenders: [], lending: null })
  useEffect(() => {
    const load = () =>
      Promise.all([getLenders().catch(() => []), getSharing().then((s) => s.sharing).catch(() => null)]).then(([lenders, lending]) =>
        setOverview({ lenders, lending }),
      )
    load()
    const timer = setInterval(load, EVERY_MS)
    return () => clearInterval(timer)
  }, [])
  return overview
}

export const lenderName = (l: Lender) => l.owner || new URL(l.gateway).hostname
