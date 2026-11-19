import { expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { StoreProvider } from '../lib/store'
import type { SharingOverview } from '../lib/lenders'
import { Timeline } from './Timeline'

test('paused borrowed accounts do not contribute available quota to the burndown', () => {
  const now = Date.now()
  const sharing: SharingOverview = {
    lenders: [{
      gateway: 'https://lender.example', owner: 'Example lender', paused: false,
      pools: [{ pool: 'claude', provider: 'claude', until: null, floors: {}, accounts: [{
        windows: [{ id: 'weekly', label: 'Weekly', usedPercent: 20, resetAtMs: now + 86400e3, periodMs: 7 * 86400e3 }],
        cost: [], yourCost: [],
      }] }],
    }],
    lending: null, floors: null, peers: [],
  }
  const storage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const media = Object.getOwnPropertyDescriptor(globalThis, 'matchMedia')
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null } })
  Object.defineProperty(globalThis, 'matchMedia', { configurable: true, value: () => ({ matches: false }) })
  try {
    const render = () => renderToStaticMarkup(createElement(StoreProvider, { children: createElement(Timeline, { sharing }) }))
    expect(render()).not.toContain('No active account has a weekly window')
    sharing.lenders[0].paused = true
    expect(render()).toContain('No active account has a weekly window')
  } finally {
    if (storage) Object.defineProperty(globalThis, 'localStorage', storage)
    else Reflect.deleteProperty(globalThis, 'localStorage')
    if (media) Object.defineProperty(globalThis, 'matchMedia', media)
    else Reflect.deleteProperty(globalThis, 'matchMedia')
  }
})
