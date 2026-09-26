import { ExternalLink, Plus, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { ProviderMark } from '../components/ProviderMark'
import { ConfirmDialog, PageHead, Switch, toast } from '../components/ui'
import { cancelLogin, loginStatus, startLogin, submitLoginCallback, type AuthFile, type LoginProvider } from '../lib/api'
import { formatRelative } from '../lib/format'
import { PROVIDER_NAMES } from '../lib/quota'
import { accountStatus } from '../lib/status'
import { accountName, providerOf, useStore } from '../lib/store'

type Login = { provider: LoginProvider; url: string; state: string; status: 'wait' | 'ok' | 'error'; error?: string }

const LOGIN_LABEL: Record<LoginProvider, string> = { anthropic: 'Claude', codex: 'Codex' }

function AddAccount({ onDone }: { onDone: () => void }) {
  const [login, setLogin] = useState<Login | null>(null)
  const [callback, setCallback] = useState('')
  const loginRef = useRef(login)
  useEffect(() => {
    loginRef.current = login
  }, [login])

  // Poll the proxy until the login completes.
  useEffect(() => {
    if (!login || login.status !== 'wait') return
    const timer = setInterval(async () => {
      try {
        const res = await loginStatus(login.state)
        if (res.status === 'wait') return
        setLogin((l) => (l ? { ...l, status: res.status, error: res.error } : l))
        if (res.status === 'ok') {
          toast(`${LOGIN_LABEL[login.provider]} account added`)
          onDone()
        }
      } catch {
        // transient; keep polling
      }
    }, 2000)
    return () => clearInterval(timer)
  }, [login, onDone])

  // Cancel an unfinished login if the page goes away.
  useEffect(
    () => () => {
      const l = loginRef.current
      if (l?.status === 'wait') cancelLogin(l.state).catch(() => {})
    },
    [],
  )

  const begin = async (provider: LoginProvider) => {
    try {
      const { url, state } = await startLogin(provider)
      setLogin({ provider, url, state, status: 'wait' })
      setCallback('')
      window.open(url, '_blank', 'noopener')
    } catch (err) {
      toast(`Couldn’t start login: ${(err as Error).message}`)
    }
  }

  const cancel = async () => {
    if (login?.status === 'wait') await cancelLogin(login.state).catch(() => {})
    setLogin(null)
  }

  const submit = async () => {
    if (!login || !callback.trim()) return
    try {
      await submitLoginCallback(login.provider, callback.trim())
      toast('Callback sent — finishing login…')
    } catch (err) {
      toast(`Callback rejected: ${(err as Error).message}`)
    }
  }

  if (!login) {
    return (
      <div className="add-row">
        <button className="btn" onClick={() => begin('anthropic')}>
          <Plus size={14} /> Add Claude account
        </button>
        <button className="btn" onClick={() => begin('codex')}>
          <Plus size={14} /> Add Codex account
        </button>
      </div>
    )
  }

  return (
    <div className="panel login">
      <div className="login-head">
        <strong>
          {login.status === 'ok'
            ? `${LOGIN_LABEL[login.provider]} account added`
            : login.status === 'error'
              ? `Login failed${login.error ? ` · ${login.error}` : ''}`
              : `Waiting for ${LOGIN_LABEL[login.provider]} login…`}
        </strong>
        <div className="page-actions">
          {login.status === 'wait' && (
            <a className="btn" href={login.url} target="_blank" rel="noopener">
              <ExternalLink size={14} /> Open login page
            </a>
          )}
          <button className="btn btn-ghost" onClick={cancel}>
            {login.status === 'wait' ? 'Cancel' : 'Close'}
          </button>
        </div>
      </div>
      {login.status === 'wait' && (
        <div className="login-body">
          <p className="muted">
            Sign in on the page that just opened. If it ends on an error page (common when this dashboard isn’t on the same
            machine as the proxy), copy that page’s full URL and paste it here.
          </p>
          <div className="login-callback">
            <input
              className="input mono"
              placeholder="http://localhost:…/callback?code=…"
              value={callback}
              onChange={(e) => setCallback(e.target.value)}
            />
            <button className="btn" onClick={submit} disabled={!callback.trim()}>
              Submit
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function AccountRow({ file, onRemove }: { file: AuthFile; onRemove: (f: AuthFile) => void }) {
  const { now, busy, toggle } = useStore()
  const status = accountStatus(file, now)
  const provider = providerOf(file)
  const lastUsed = file.last_refresh ? Date.parse(file.last_refresh) : null
  return (
    <div className="arow">
      <ProviderMark of={provider} />
      <div className="arow-main">
        <div className="arow-name">{accountName(file)}</div>
        <div className="mono faint arow-sub">
          {PROVIDER_NAMES[provider]} · {file.name}
        </div>
      </div>
      <div className={`arow-status ${status.tone}`} title={status.text}>
        {status.tone === 'warn' || status.tone === 'bad' ? status.text : ''}
      </div>
      <div className="mono faint arow-stat" title="Requests since the proxy started">
        {file.success ?? 0} ok · {file.failed ?? 0} failed
      </div>
      <div className="mono faint arow-stat">{lastUsed ? `refreshed ${formatRelative(lastUsed, now)}` : ''}</div>
      <Switch
        on={!file.disabled}
        label={`${file.disabled ? 'Turn on' : 'Turn off'} ${accountName(file)}`}
        disabled={busy.has(file.auth_index)}
        onChange={() => toggle(file)}
      />
      <button className="btn btn-ghost btn-icon" aria-label={`Remove ${accountName(file)}`} title="Remove account" onClick={() => onRemove(file)}>
        <Trash2 size={14} />
      </button>
    </div>
  )
}

export function AccountsPage() {
  const { files, reloadAccounts, remove } = useStore()
  const [removing, setRemoving] = useState<AuthFile | null>(null)
  const groups = (['claude', 'codex'] as const).map((p) => ({
    provider: p,
    files: files.filter((f) => providerOf(f) === p).sort((a, b) => a.name.localeCompare(b.name)),
  }))

  const confirmRemove = async () => {
    const file = removing
    setRemoving(null)
    if (!file) return
    try {
      await remove(file)
      toast(`Removed ${accountName(file)}`)
    } catch (err) {
      toast(`Couldn’t remove: ${(err as Error).message}`)
    }
  }

  return (
    <div className="page">
      <PageHead title="Accounts" sub="Claude and Codex logins the proxy routes through" />
      <AddAccount onDone={reloadAccounts} />

      {groups.map((g) => (
        <section key={g.provider} className="section">
          <div className="section-head">
            <h2>{PROVIDER_NAMES[g.provider]}</h2>
            <span className="mono faint">
              {g.files.filter((f) => !f.disabled).length}/{g.files.length} on
            </span>
          </div>
          {g.files.length ? (
            <div className="panel alist">
              {g.files.map((f) => (
                <AccountRow key={f.auth_index} file={f} onRemove={setRemoving} />
              ))}
            </div>
          ) : (
            <div className="empty">No {PROVIDER_NAMES[g.provider]} accounts yet.</div>
          )}
        </section>
      ))}

      <ConfirmDialog
        open={!!removing}
        title="Remove account?"
        body={
          <>
            This deletes <span className="mono">{removing?.name}</span> from the proxy. To use it again you’ll need to log in
            again. To pause it instead, just switch it off.
          </>
        }
        confirmLabel="Remove"
        danger
        onConfirm={confirmRemove}
        onCancel={() => setRemoving(null)}
      />
    </div>
  )
}
