import { useCallback, useEffect, useState } from 'react'
import { ApiError, listAuthFiles, setDisabled, type AuthFile } from './api'
import { AccountCard, type QuotaState } from './components/AccountCard'
import { formatAgo } from './format'
import { pruneSamples, recordSample } from './history'
import { fetchQuota, PROVIDER_NAMES, providerOf, supportsQuota } from './quota'

const ACCOUNTS_EVERY_MS = 30e3
const QUOTA_EVERY_MS = 3 * 60e3

export default function App() {
  const [files, setFiles] = useState<AuthFile[]>([])
  const [quotas, setQuotas] = useState<Record<string, QuotaState>>({})
  const [fatal, setFatal] = useState<ApiError | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [updatedAt, setUpdatedAt] = useState<number | null>(null)
  const [now, setNow] = useState(() => Date.now())

  const loadAccounts = useCallback(async () => {
    try {
      const list = await listAuthFiles()
      setFiles(list)
      setFatal(null)
      return list
    } catch (err) {
      if (err instanceof ApiError && (err.guard || err.status === 401)) setFatal(err)
      return null
    }
  }, [])

  const loadQuotas = useCallback(async (list: AuthFile[]) => {
    // Off accounts aren't refreshed by the proxy, so their tokens can't be used.
    const targets = list.filter((f) => supportsQuota(f) && !f.disabled)
    setQuotas((prev) => {
      const next = { ...prev }
      for (const f of targets) next[f.auth_index] = { ...next[f.auth_index], loading: true }
      return next
    })
    await Promise.all(
      targets.map(async (f) => {
        try {
          const quota = await fetchQuota(f)
          quota.windows.forEach((w) => recordSample(f.auth_index, w))
          setQuotas((prev) => ({ ...prev, [f.auth_index]: { quota, loading: false } }))
        } catch (err) {
          // Keep the last good reading on screen; just flag the failure.
          setQuotas((prev) => ({
            ...prev,
            [f.auth_index]: { ...prev[f.auth_index], error: (err as Error).message, loading: false },
          }))
        }
      }),
    )
    setUpdatedAt(Date.now())
  }, [])

  const refreshAll = useCallback(async () => {
    const list = await loadAccounts()
    if (list) await loadQuotas(list)
  }, [loadAccounts, loadQuotas])

  useEffect(() => {
    pruneSamples()
    refreshAll()
    const accounts = setInterval(loadAccounts, ACCOUNTS_EVERY_MS)
    const quota = setInterval(refreshAll, QUOTA_EVERY_MS)
    const clock = setInterval(() => setNow(Date.now()), 30e3)
    return () => [accounts, quota, clock].forEach(clearInterval)
  }, [loadAccounts, refreshAll])

  const toggle = async (file: AuthFile) => {
    const turningOff = !file.disabled
    const provider = providerOf(file)
    const othersOn = files.filter((f) => f !== file && providerOf(f) === provider && !f.disabled).length
    if (turningOff && othersOn === 0) {
      const name = PROVIDER_NAMES[provider] ?? provider
      if (!window.confirm(`This is your last ${name} account that's on. Anything using ${name} through the proxy will stop working. Turn it off?`)) return
    }
    setBusy(file.auth_index)
    setFiles((prev) => prev.map((f) => (f === file ? { ...f, disabled: turningOff } : f)))
    try {
      await setDisabled(file.name, turningOff)
    } catch (err) {
      window.alert(`Couldn’t ${turningOff ? 'turn off' : 'turn on'} the account: ${(err as Error).message}`)
    } finally {
      await loadAccounts()
      setBusy(null)
    }
  }

  if (fatal) {
    return (
      <main className="page">
        <h1>Can’t reach the proxy</h1>
        <p className="muted">{fatal.message}</p>
      </main>
    )
  }

  const providers = [...new Set(files.map(providerOf))].sort((a, b) => (PROVIDER_NAMES[a] ? 0 : 1) - (PROVIDER_NAMES[b] ? 0 : 1))

  return (
    <main className="page">
      <header className="page-head">
        <h1>Accounts</h1>
        <div className="page-actions">
          {updatedAt && <span className="muted small">Updated {formatAgo(updatedAt, now)}</span>}
          <button className="button" onClick={refreshAll}>Refresh</button>
        </div>
      </header>

      {providers.map((provider) => {
        const group = files
          .filter((f) => providerOf(f) === provider)
          // Stable order, so a card never moves out from under a toggle.
          .sort((a, b) => a.name.localeCompare(b.name))
        const onCount = group.filter((f) => !f.disabled).length
        return (
          <section key={provider} className="provider">
            <h2>
              {PROVIDER_NAMES[provider] ?? provider}
              <span className="muted"> · {onCount} of {group.length} on</span>
            </h2>
            {group.map((f) => (
              <AccountCard
                key={f.auth_index}
                file={f}
                quota={quotas[f.auth_index]}
                now={now}
                busy={busy === f.auth_index}
                onToggle={toggle}
              />
            ))}
          </section>
        )
      })}
    </main>
  )
}
