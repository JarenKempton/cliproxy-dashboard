// Usage: laid out like T3 Code's usage view (total, per-tool split, chart,
// totals, breakdown), styled like the rest of this dashboard.

import { Pencil, RotateCcw } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { ProviderMark } from '../components/ProviderMark'
import { bucketLabel, UsageChart } from '../components/UsageChart'
import { PageHead, Segmented, toast } from '../components/ui'
import {
  byToolOrder,
  clearDeviceName,
  formatCount,
  formatPercent,
  formatTokens,
  formatUsd,
  getUsage,
  nameDevice,
  toolLabel,
  type MachineUsage,
  type Range,
  type Totals,
  type UsageSummary,
} from '../lib/usage'

type Metric = 'cost' | 'tokens'
type BreakdownKind = 'model' | 'day' | 'machine' | 'account'

const REFRESH_EVERY_MS = 30e3
const PREFS_KEY = 'cpa:usage-prefs'

type Prefs = { range: Range; metric: Metric; breakdown: BreakdownKind }
const DEFAULT_PREFS: Prefs = { range: '30d', metric: 'cost', breakdown: 'model' }

function usePrefs() {
  const [prefs, setPrefs] = useState<Prefs>(() => {
    try {
      return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') }
    } catch {
      return DEFAULT_PREFS
    }
  })
  const update = (patch: Partial<Prefs>) => {
    const next = { ...prefs, ...patch }
    setPrefs(next)
    localStorage.setItem(PREFS_KEY, JSON.stringify(next))
  }
  return [prefs, update] as const
}

// --- Pieces ------------------------------------------------------------------------

function Hero({ summary }: { summary: UsageSummary }) {
  const t = summary.totals
  const unpriced = t.records ? t.unpricedRecords / t.records : 0
  return (
    <div className="uhero">
      <div className="uhero-cost">{formatUsd(t.costMicros)}</div>
      <div className="mono faint uhero-sub">
        {formatCount(t.sessions)} sessions · API estimate
        {unpriced > 0 && ` excludes ${formatPercent(unpriced)} unpriced requests`}
      </div>

      <div className="utools">
        {[...summary.tools]
          .sort((a, b) => byToolOrder(a.tool, b.tool))
          .map((tool) => (
            <div key={tool.tool} className="utool">
              <div className="utool-line">
                <ProviderMark of={tool.tool} />
                <span className="utool-name">{toolLabel(tool.tool)}</span>
                <span className="mono faint utool-sessions">{formatCount(tool.sessions)} sessions</span>
                <span className="mono utool-cost">{formatUsd(tool.costMicros)}</span>
              </div>
              <div className="mono faint utool-sub">
                {formatPercent(t.costMicros ? tool.costMicros / t.costMicros : 0)} of cost · {formatTokens(tool.processedTokens)} tokens
              </div>
            </div>
          ))}
      </div>
    </div>
  )
}

function TotalsRow({ totals }: { totals: Totals }) {
  const tiles: [string, string][] = [
    ['Processed tokens', formatTokens(totals.processedTokens)],
    ['Cached input', formatTokens(totals.cachedTokens)],
    ['Uncached input', formatTokens(totals.uncachedTokens)],
    ['Output', formatTokens(totals.outputTokens)],
    ['Cache savings', formatUsd(totals.cacheSavingsMicros)],
  ]
  return (
    <div className="panel utotals">
      {tiles.map(([label, value]) => (
        <div key={label} className="utotal">
          <div className="eyebrow">{label}</div>
          <div className="mono utotal-value">{value}</div>
        </div>
      ))}
    </div>
  )
}

// Cost, share and tokens columns shared by every breakdown except Day.
function CostCells({ row, total, metric }: { row: Totals; total: number; metric: Metric }) {
  const unknown = row.records > 0 && row.unpricedRecords >= row.records
  const share = metric === 'cost' ? (total ? row.costMicros / total : 0) : total ? row.processedTokens / total : 0
  return (
    <>
      <td className="mono num">{unknown ? <span className="faint">Unpriced</span> : formatUsd(row.costMicros)}</td>
      <td className="mono num faint">{unknown && metric === 'cost' ? '—' : formatPercent(share)}</td>
      <td className="mono num">{formatTokens(row.processedTokens)}</td>
    </>
  )
}

function MachineName({ machine, onChange }: { machine: MachineUsage; onChange: () => void }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(machine.name)

  // Renaming applies to every identity this row was recognized by.
  const save = async () => {
    setEditing(false)
    const name = draft.trim()
    if (!name || name === machine.name) return
    try {
      await Promise.all(machine.identities.map((i) => nameDevice(i.kind, i.value, name)))
      onChange()
    } catch (err) {
      toast(`Couldn’t rename: ${(err as Error).message}`)
    }
  }

  const reset = async () => {
    await Promise.all(machine.identities.map((i) => clearDeviceName(i.kind, i.value))).catch((err) =>
      toast(`Couldn’t reset: ${err.message}`),
    )
    onChange()
  }

  if (editing) {
    return (
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
    )
  }
  return (
    <span className="udev">
      <button
        className="udev-name"
        title="Rename"
        onClick={() => {
          setDraft(machine.name)
          setEditing(true)
        }}
      >
        {machine.name}
        <Pencil size={12} className="faint" />
      </button>
      {machine.nameSource === 'tailscale' && <span className="tag">tailscale</span>}
      {machine.nameSource === 'custom' && (
        <button className="udev-reset faint" title="Use the Tailscale name again" onClick={reset}>
          <RotateCcw size={12} />
        </button>
      )}
    </span>
  )
}

function Breakdown({ summary, kind, metric, onChange }: { summary: UsageSummary; kind: BreakdownKind; metric: Metric; onChange: () => void }) {
  const total = metric === 'cost' ? summary.totals.costMicros : summary.totals.processedTokens
  const sort = <T extends Totals>(rows: T[]) =>
    metric === 'tokens' ? [...rows].sort((a, b) => b.processedTokens - a.processedTokens) : rows

  if (kind === 'day') {
    const tools = summary.tools.map((t) => t.tool).sort(byToolOrder)
    const rows = [...summary.series].reverse().filter((b) => Object.keys(b.tools).length > 0)
    return (
      <table className="utable">
        <thead>
          <tr>
            <th>{summary.bucket === 'hour' ? 'Hour' : 'Day'}</th>
            {tools.map((t) => (
              <th key={t} className="num">
                {toolLabel(t)}
              </th>
            ))}
            <th className="num">Total</th>
            <th className="num">Tokens</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((b) => {
            const cost = tools.reduce((n, t) => n + (b.tools[t]?.costMicros ?? 0), 0)
            const tokens = tools.reduce((n, t) => n + (b.tools[t]?.tokens ?? 0), 0)
            return (
              <tr key={String(b.key)}>
                <td className="mono">{bucketLabel(b.key, true)}</td>
                {tools.map((t) => (
                  <td key={t} className="mono num faint">
                    {b.tools[t] ? formatUsd(b.tools[t].costMicros) : '—'}
                  </td>
                ))}
                <td className="mono num">{formatUsd(cost)}</td>
                <td className="mono num">{formatTokens(tokens)}</td>
              </tr>
            )
          })}
          {rows.length === 0 && <EmptyRow cols={tools.length + 3} />}
        </tbody>
      </table>
    )
  }

  const heading = { model: 'Model', machine: 'Machine', account: 'Account' }[kind]
  return (
    <table className="utable">
      <thead>
        <tr>
          <th className="ucol-name">{heading}</th>
          <th className="num">Cost</th>
          <th className="num">Share</th>
          <th className="num">Tokens</th>
        </tr>
      </thead>
      <tbody>
        {kind === 'model' &&
          sort(summary.byModel).map((m) => (
            <tr key={`${m.tool}:${m.model}`}>
              <td>
                <span className="ucell-name">
                  <ProviderMark of={m.tool} />
                  <span className="mono">{m.model}</span>
                </span>
              </td>
              <CostCells row={m} total={total} metric={metric} />
            </tr>
          ))}
        {kind === 'machine' &&
          sort(summary.byMachine).map((m) => (
            <tr key={m.name}>
              <td>
                <MachineName machine={m} onChange={onChange} />
              </td>
              <CostCells row={m} total={total} metric={metric} />
            </tr>
          ))}
        {kind === 'account' &&
          sort(summary.byAccount).map((a) => (
            <tr key={a.name}>
              <td>{a.name}</td>
              <CostCells row={a} total={total} metric={metric} />
            </tr>
          ))}
        {summary.totals.records === 0 && <EmptyRow cols={4} />}
      </tbody>
    </table>
  )
}

function EmptyRow({ cols }: { cols: number }) {
  return (
    <tr>
      <td colSpan={cols} className="faint">
        No activity in this window.
      </td>
    </tr>
  )
}

// --- Page ----------------------------------------------------------------------------

export function UsagePage() {
  const [prefs, setPrefs] = usePrefs()
  const [summary, setSummary] = useState<UsageSummary | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setSummary(await getUsage(prefs.range))
      setError(null)
    } catch (err) {
      setError((err as Error).message)
    }
  }, [prefs.range])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load()
    const timer = setInterval(load, REFRESH_EVERY_MS)
    return () => clearInterval(timer)
  }, [load])

  const chartTitle = `${summary?.bucket === 'hour' ? 'Hourly' : 'Daily'} ${prefs.metric === 'cost' ? 'cost' : 'tokens'}`

  return (
    <div className="page">
      <PageHead title="Usage">
        <Segmented
          value={prefs.metric}
          onChange={(metric) => setPrefs({ metric })}
          options={[
            ['cost', 'Cost'],
            ['tokens', 'Tokens'],
          ]}
        />
        <Segmented
          value={prefs.range}
          onChange={(range) => setPrefs({ range })}
          options={[
            ['24h', '24h'],
            ['7d', '7 days'],
            ['30d', '30 days'],
            ['90d', '90 days'],
          ]}
        />
      </PageHead>

      {error && <p className="error-text">Usage server unreachable: {error}</p>}

      {summary && (
        <>
          <div className="utop">
            <Hero summary={summary} />
            <div>
              <div className="eyebrow utop-title">{chartTitle}</div>
              <UsageChart summary={summary} metric={prefs.metric} />
            </div>
          </div>

          <section className="section">
            <div className="section-head">
              <h2>Totals</h2>
            </div>
            <TotalsRow totals={summary.totals} />
          </section>

          <section className="section">
            <div className="section-head">
              <h2>Breakdown</h2>
              <div className="page-actions">
                <Segmented
                  value={prefs.breakdown}
                  onChange={(breakdown) => setPrefs({ breakdown })}
                  options={[
                    ['model', 'Model'],
                    ['day', summary.bucket === 'hour' ? 'Hour' : 'Day'],
                    ['machine', 'Machine'],
                    ['account', 'Account'],
                  ]}
                />
              </div>
            </div>
            <div className="panel utable-wrap">
              <Breakdown summary={summary} kind={prefs.breakdown} metric={prefs.metric} onChange={load} />
            </div>
          </section>
        </>
      )}
    </div>
  )
}
