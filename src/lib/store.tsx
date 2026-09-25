// Shared account + quota state for all pages, with background refresh.

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { ApiError, deleteAuthFile, listAuthFiles, setDisabled, type AuthFile } from './api'
import { fetchQuota, providerOf, supportsQuota, type Quota } from './quota'

const ACCOUNTS_EVERY_MS = 30e3
const QUOTA_EVERY_MS = 5 * 60e3
const CACHE_KEY = 'cpa:quota-cache'

function loadCachedQuotas(): Record<string, QuotaState> {
  try {
    const raw = JSON.parse(localStorage.getItem(CACHE_KEY) ?? '{}') as Record<string, { quota: Quota; at: number }>
    return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, { quota: v.quota, at: v.at, loading: false }]))
  } catch {
    return {}
  }
}

function saveCachedQuota(authIndex: string, quota: Quota, at: number) {
  try {
    const raw = JSON.parse(localStorage.getItem(CACHE_KEY) ?? '{}')
    raw[authIndex] = { quota, at }
    localStorage.setItem(CACHE_KEY, JSON.stringify(raw))
  } catch {
    // storage full or unavailable; the in-memory state still works
  }
}

export type QuotaState = { quota?: Quota; error?: string; loading: boolean; at?: number }

type Store = {
  files: AuthFile[]
  quotas: Record<string, QuotaState>
  fatal: ApiError | null
  loaded: boolean
  busy: Set<string>
  now: number
  refresh: () => Promise<void>
  refreshQuota: (file: AuthFile) => Promise<void>
  toggle: (file: AuthFile) => Promise<void>
  remove: (file: AuthFile) => Promise<void>
  reloadAccounts: () => Promise<AuthFile[] | null>
}

const StoreContext = createContext<Store | null>(null)

// Only the providers this dashboard manages.
const isManaged = (f: AuthFile) => supportsQuota(f)

export function StoreProvider({ children }: { children: ReactNode }) {
  const [files, setFiles] = useState<AuthFile[]>([])
  const [quotas, setQuotas] = useState<Record<string, QuotaState>>(loadCachedQuotas)
  const [fatal, setFatal] = useState<ApiError | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState<Set<string>>(new Set())
  const [now, setNow] = useState(() => Date.now())

  const reloadAccounts = useCallback(async () => {
    try {
      const list = (await listAuthFiles()).filter(isManaged)
      setFiles(list)
      setFatal(null)
      setLoaded(true)
      return list
    } catch (err) {
      if (err instanceof ApiError && (err.guard || err.status === 401)) setFatal(err)
      setLoaded(true)
      return null
    }
  }, [])

  const refreshQuota = useCallback(async (f: AuthFile) => {
    // Off accounts aren't refreshed by the proxy, so their tokens can't be used.
    if (f.disabled) return
    setQuotas((prev) => ({ ...prev, [f.auth_index]: { ...prev[f.auth_index], loading: true } }))
    try {
      const quota = await fetchQuota(f)
      const at = Date.now()
      saveCachedQuota(f.auth_index, quota, at)
      setQuotas((prev) => ({ ...prev, [f.auth_index]: { quota, loading: false, at } }))
    } catch (err) {
      // Keep the last good reading on screen; just flag the failure.
      setQuotas((prev) => ({
        ...prev,
        [f.auth_index]: { ...prev[f.auth_index], error: (err as Error).message, loading: false },
      }))
    }
  }, [])

  const refresh = useCallback(async () => {
    const list = await reloadAccounts()
    if (list) await Promise.all(list.map(refreshQuota))
  }, [reloadAccounts, refreshQuota])

  useEffect(() => {
    // Initial load; the intervals below keep it current.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh()
    const accounts = setInterval(reloadAccounts, ACCOUNTS_EVERY_MS)
    const quota = setInterval(refresh, QUOTA_EVERY_MS)
    const clock = setInterval(() => setNow(Date.now()), 30e3)
    return () => [accounts, quota, clock].forEach(clearInterval)
  }, [refresh, reloadAccounts])

  const withBusy = useCallback(async (id: string, fn: () => Promise<unknown>) => {
    setBusy((prev) => new Set(prev).add(id))
    try {
      await fn()
    } finally {
      setBusy((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    }
  }, [])

  const toggle = useCallback(
    (file: AuthFile) =>
      withBusy(file.auth_index, async () => {
        const disabled = !file.disabled
        setFiles((prev) => prev.map((f) => (f.auth_index === file.auth_index ? { ...f, disabled } : f)))
        try {
          await setDisabled(file.name, disabled)
        } finally {
          const list = await reloadAccounts()
          const updated = list?.find((f) => f.auth_index === file.auth_index)
          if (updated && !updated.disabled) await refreshQuota(updated)
        }
      }),
    [withBusy, reloadAccounts, refreshQuota],
  )

  const remove = useCallback(
    (file: AuthFile) =>
      withBusy(file.auth_index, async () => {
        await deleteAuthFile(file.name)
        await reloadAccounts()
      }),
    [withBusy, reloadAccounts],
  )

  const value = useMemo(
    () => ({ files, quotas, fatal, loaded, busy, now, refresh, refreshQuota, toggle, remove, reloadAccounts }),
    [files, quotas, fatal, loaded, busy, now, refresh, refreshQuota, toggle, remove, reloadAccounts],
  )
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>
}

export function useStore(): Store {
  const store = useContext(StoreContext)
  if (!store) throw new Error('useStore outside StoreProvider')
  return store
}

export function accountName(f: AuthFile) {
  return f.email || f.label || f.name
}

export { providerOf }
