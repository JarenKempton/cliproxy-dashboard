import { Pencil, RotateCcw } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { CostChart } from '../components/CostChart'
import { PageHead, Segmented, toast } from '../components/ui'
import { formatAgo, formatStamp } from '../lib/format'
import {
  clearDeviceName,
  formatTokens,
  formatUsd,
  getDevices,
  getOverview,
  getRecent,
  nameDevice,
  type Breakdown,
  type Device,
  type Overview,
  type Range,
  type RecentRequest,
} from '../lib/usage'

const REFRESH_EVERY_MS = 30e3

function BreakdownPanel({ title, rows, total, mono }: { title: string; rows: Breakdown[]; total: number; mono?: boolean }) {
  return (
    <div className="panel ubreak">
      <div className="eyebrow ubreak-title">{title}</div>
      {rows.length === 0 && <div className="faint ubreak-empty">No requests</div>}
      {rows.map((r) => {
        const share = total ? r.costMicros / total : 0
        return (
          <div key={r.name} className="ubreak-row" title={`${r.requests} requests`}>
            <div className="ubreak-line">
              <span className={mono ? 'mono ubreak-name' : 'ubreak-name'}>{r.name}</span>
              <span className="mono faint">{r.requests}</span>
              <span className="mono ubreak-cost">{formatUsd(r.costMicros)}</span>
            </div>
            <div className="ubreak-bar">
              <div style={{ width: `${Math.max(share * 100, share > 0 ? 1 : 0)}%` }} />
            </div>
          </div>
        )
      })}
    </div>
  )
}

function DeviceRow({ device, onChange }: { device: Device; onChange: () => void }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const identity = device.kind === 'key' ? `key ${device.value.slice(0, 8)}…` : device.value

  const save = async () => {
    setEditing(false)
    const name = draft.trim()
    if (!name || name === device.name) return
    try {
      await nameDevice(device.kind, device.value, name)
      onChange()
    } catch (err) {
      toast(`Couldn’t rename: ${(err as Error).message}`)
    }
  }

  const reset = async () => {
    await clearDeviceName(device.kind, device.value).catch((err) => toast(`Couldn’t reset: ${err.message}`))
    onChange()
  }

  return (
    <tr>
      <td>
        {editing ? (
          <input
            className="input udev-input"
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={save}
            onKeyDown={(e) => {
              if (e.key === 'Enter') save()
              if (e.key === 'Escape') setEditing(false)
            }}
          />
        ) : (
          <button
            className="udev-name"
            onClick={() => {
              setDraft(device.name ?? '')
              setEditing(true)
            }}
          >
            <span className={device.name ? '' : 'faint'}>{device.name ?? 'Unnamed'}</span>
            <Pencil size={12} className="faint" />
          </button>
        )}
      </td>
      <td>
        {device.nameSource === 'custom' ? (
          <span className="tag">custom</span>
        ) : device.nameSource === 'tailscale' ? (
          <span className="tag">tailscale{device.tailscale?.os ? ` · ${device.tailscale.os}` : ''}</span>
        ) : null}
      </td>
      <td className="mono faint">{identity}</td>
      <td className="mono num">{device.requests}</td>
      <td className="mono num">{formatUsd(device.costMicros)}</td>
      <td className="mono faint num">{device.lastSeen ? formatAgo(device.lastSeen) : '—'}</td>
      <td className="num">
        {device.nameSource === 'custom' && (
          <button className="btn btn-ghost btn-icon" title="Reset to Tailscale name" aria-label="Reset name" onClick={reset}>
            <RotateCcw size={13} />
          </button>
        )}
      </td>
    </tr>
  )
}

function RecentTable({ rows }: { rows: RecentRequest[] }) {
  return (
    <div className="panel utable-wrap">
      <table className="utable">
        <thead>
          <tr>
            <th>Time</th>
            <th>Machine</th>
            <th>Tool</th>
            <th>Model</th>
            <th>Account</th>
            <th className="num">In</th>
            <th className="num">Cache read</th>
            <th className="num">Cache write</th>
            <th className="num">Out</th>
            <th className="num">Cost</th>
            <th className="num">Latency</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className={r.failed ? 'failed' : undefined}>
              <td className="mono faint">{formatStamp(Date.parse(r.occurredAt))}</td>
              <td>{r.machine}</td>
              <td className="faint">{r.tool ?? '—'}</td>
              <td className="mono">{r.model}</td>
              <td className="faint utable-clip" title={r.account ?? undefined}>{r.account ?? '—'}</td>
              <td className="mono num">{r.inputTokens == null ? '—' : formatTokens(r.inputTokens)}</td>
              <td className="mono num">{r.cacheReadTokens == null ? '—' : formatTokens(r.cacheReadTokens)}</td>
              <td className="mono num">{r.cacheWriteTokens == null ? '—' : formatTokens(r.cacheWriteTokens)}</td>
              <td className="mono num">{r.outputTokens == null ? '—' : formatTokens(r.outputTokens)}</td>
              <td className="mono num">{r.costMicros == null ? '—' : formatUsd(r.costMicros)}</td>
              <td className="mono faint num">{r.latencyMs == null ? '—' : `${(r.latencyMs / 1000).toFixed(1)}s`}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function UsagePage() {
  const [range, setRange] = useState<Range>('24h')
  const [overview, setOverview] = useState<Overview | null>(null)
  const [recent, setRecent] = useState<RecentRequest[]>([])
  const [devices, setDevices] = useState<Device[]>([])
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())

  const load = useCallback(async () => {
    try {
      const [o, r, d] = await Promise.all([getOverview(range), getRecent(25), getDevices()])
      setOverview(o)
      setRecent(r)
      setDevices(d)
      setNow(Date.now())
      setError(null)
    } catch (err) {
      setError((err as Error).message)
    }
  }, [range])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load()
    const timer = setInterval(load, REFRESH_EVERY_MS)
    return () => clearInterval(timer)
  }, [load])

  const t = overview?.totals
  const cacheShare = t && t.inputTokens + t.cacheReadTokens + t.cacheWriteTokens > 0
    ? t.cacheReadTokens / (t.inputTokens + t.cacheReadTokens + t.cacheWriteTokens)
    : 0

  return (
    <div className="page">
      <PageHead title="Usage" sub="Requests through the proxy, priced at API rates">
        <Segmented
          value={range}
          onChange={setRange}
          options={[
            ['24h', '24h'],
            ['7d', '7 days'],
            ['30d', '30 days'],
          ]}
        />
      </PageHead>

      {error && <div className="empty error-text">Usage server unreachable · {error}</div>}

      {overview && t && (
        <>
          <div className="ustats">
            <div className="ustat">
              <div className="eyebrow">API-equivalent cost</div>
              <div className="ustat-hero">{formatUsd(t.costMicros)}</div>
              {t.unpriced > 0 && <div className="mono faint small">{t.unpriced} requests unpriced</div>}
            </div>
            <div className="ustat">
              <div className="eyebrow">Requests</div>
              <div className="ustat-value">{t.requests.toLocaleString()}</div>
              {t.failed > 0 && <div className="mono error-text small">{t.failed} failed</div>}
            </div>
            <div className="ustat">
              <div className="eyebrow">Tokens</div>
              <div className="ustat-value">{formatTokens(t.inputTokens + t.cacheReadTokens + t.cacheWriteTokens + t.outputTokens)}</div>
              <div className="mono faint small">
                {formatTokens(t.outputTokens)} out · {Math.floor(cacheShare * 100)}% of input cached
              </div>
            </div>
          </div>

          <div className="panel ucharts">
            <CostChart overview={overview} now={now} />
          </div>

          <div className="ubreaks">
            <BreakdownPanel title="By model" rows={overview.byModel} total={t.costMicros} mono />
            <BreakdownPanel title="By machine" rows={overview.byMachine} total={t.costMicros} />
            <BreakdownPanel title="By account" rows={overview.byAccount} total={t.costMicros} />
            <BreakdownPanel title="By tool" rows={overview.byTool} total={t.costMicros} />
          </div>

          <section className="section">
            <div className="section-head">
              <h2>Machines</h2>
              <span className="mono faint">named by Tailscale unless you rename them</span>
            </div>
            <div className="panel utable-wrap">
              <table className="utable">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Source</th>
                    <th>Identity</th>
                    <th className="num">Requests</th>
                    <th className="num">Cost</th>
                    <th className="num">Last seen</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {/* A key is a machine only once it's dedicated to one; shared keys aren't. */}
                  {devices.filter((d) => d.kind === 'ip' || d.nameSource === 'custom').map((d) => (
                    <DeviceRow key={`${d.kind}:${d.value}`} device={d} onChange={load} />
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="section">
            <div className="section-head">
              <h2>Recent requests</h2>
            </div>
            <RecentTable rows={recent} />
          </section>
        </>
      )}
    </div>
  )
}
