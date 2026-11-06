// What peers lend this proxy, and what it lends them, for the Quota page.

import { useEffect, useState } from 'react'
import { getLenders, getSharing, type Lender, type Peer, type SharingState } from './sharing'

const EVERY_MS = 5 * 60e3

export type SharingOverview = { lenders: Lender[]; lending: SharingState['sharing'] | null; peers: Peer[] }

export function useSharingOverview(): SharingOverview {
  const [overview, setOverview] = useState<SharingOverview>({ lenders: [], lending: null, peers: [] })
  useEffect(() => {
    const load = () =>
      Promise.all([getLenders().catch(() => []), getSharing().catch(() => null)]).then(([lenders, own]) =>
        setOverview({ lenders, lending: own?.sharing ?? null, peers: own?.peers ?? [] }),
      )
    load()
    const timer = setInterval(load, EVERY_MS)
    return () => clearInterval(timer)
  }, [])
  return overview
}

export const lenderName = (l: Lender) => l.owner || new URL(l.gateway).hostname
