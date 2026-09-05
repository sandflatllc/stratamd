import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Chart, CategoryScale, LinearScale, PointElement, LineElement, LineController, Filler, Tooltip } from 'chart.js'
import type { UsageSummary, UsageWindow } from '../../shared/usage'
import { enumerateDays, enumerateHourStarts, formatCount, formatDayShort, formatHourShort, formatPercent, formatTokens, formatUsd, processedTokens, summarizeUsage, usageRows } from '../../core/usage'
import { useDialogFocus } from '../useDialogFocus'
import { RefreshCwIcon, UserRoundIcon, XIcon } from '../icons/lucide'

Chart.register(CategoryScale, LinearScale, PointElement, LineElement, LineController, Filler, Tooltip)
const windows: Record<UsageWindow, string> = { '24h': 'Past 24h', '7d': '7 days', '30d': '30 days', '90d': '90 days' }
const providerNames = { codex: 'Codex', claude: 'Claude Code', grok: 'Grok Build' }
const providerOrder = ['codex', 'claude', 'grok'] as const

function UsageChart({ summary, metric, window }: { summary: UsageSummary; metric: 'tokens' | 'cost'; window: UsageWindow }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const totals = useMemo(() => summarizeUsage(summary), [summary])
  useEffect(() => {
    const element = canvas.current
    if (!element) return
    const style = getComputedStyle(element)
    const hourly = window === '24h'
    const hours = summary.buckets.flatMap(bucket => bucket.hourStart ? [bucket.hourStart] : []).sort()
    const points = hourly && summary.sinceTime && summary.untilTime ? enumerateHourStarts(summary.sinceTime, summary.untilTime) : enumerateDays(summary.sinceDay, summary.untilDay)
    const labels = points.map(point => hourly && hours.length ? formatHourShort(point, summary.timeZone) : formatDayShort(point))
    const chart = new Chart(element, { type: 'line', data: { labels, datasets: providerOrder.filter(provider => totals.providers.some(row => row.provider === provider)).map(provider => {
      const color = style.getPropertyValue(`--visuals-category-${providerOrder.indexOf(provider) + 1}`).trim()
      const data = new Map<string, number>()
      for (const bucket of summary.buckets.filter(bucket => bucket.provider === provider)) {
        const key = hourly ? bucket.hourStart ?? bucket.day : bucket.day
        data.set(key, (data.get(key) ?? 0) + (metric === 'tokens' ? processedTokens(bucket.totals) : bucket.costUsd))
      }
      return { label: providerNames[provider], data: points.map(point => data.get(point) ?? 0), borderColor: color, backgroundColor: `color-mix(in srgb, ${color} 12%, transparent)`, borderWidth: 2, pointRadius: points.length === 1 ? 3 : 0, pointHitRadius: 12, fill: true }
    }) }, options: { responsive: true, maintainAspectRatio: false, animation: false, interaction: { intersect: false, mode: 'index' }, plugins: { tooltip: { callbacks: { label: item => `${item.dataset.label}: ${metric === 'tokens' ? formatTokens(item.parsed.y ?? 0) : formatUsd(item.parsed.y ?? 0)}` } } }, scales: { x: { grid: { display: false }, ticks: { color: style.getPropertyValue('--dim'), maxTicksLimit: 8, maxRotation: 0 } }, y: { beginAtZero: true, grid: { color: style.getPropertyValue('--line') }, ticks: { color: style.getPropertyValue('--dim'), callback: value => metric === 'tokens' ? formatTokens(Number(value)) : formatUsd(Number(value)) } } } } })
    return () => chart.destroy()
  }, [summary, metric, window, totals])
  return <div className="usage-chart-row"><div className="usage-chart"><canvas ref={canvas} role="img" aria-label={`${metric === 'tokens' ? 'Tokens' : 'API estimate'} by provider over time`} /></div><div className="usage-legend">{providerOrder.flatMap((provider, index) => {
    const row = totals.providers.find(candidate => candidate.provider === provider)
    return row ? [<div key={provider}><strong><i style={{ background: `var(--visuals-category-${index + 1})` }} />{providerNames[provider]}</strong><small>{metric === 'tokens' ? `${formatTokens(row.tokens)} tokens` : formatUsd(row.costUsd)} · {formatCount(row.sessions)} sessions</small></div>] : []
  })}</div></div>
}

export function UsageDialog({ connected, onClose, onAccounts }: { connected: boolean; onClose(): void; onAccounts(): void }) {
  const dialog = useRef<HTMLElement>(null)
  useDialogFocus(dialog, onClose)
  const [window, setWindow] = useState<UsageWindow>('30d')
  const [metric, setMetric] = useState<'tokens' | 'cost'>('tokens')
  const [group, setGroup] = useState<'model' | 'time'>('model')
  const [summary, setSummary] = useState<UsageSummary | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    let current = true
    setSummary(null); setError(''); setLoading(connected)
    if (connected) void globalThis.window.strata.readEngineUsage(window).then(result => { if (current) setSummary(result) }).catch(failure => { if (current) setError(String(failure)) }).finally(() => { if (current) setLoading(false) })
    return () => { current = false }
  }, [window, refresh, connected])
  const totals = summary ? summarizeUsage(summary) : null
  const grouping = group === 'model' ? 'model' : window === '24h' ? 'hour' : 'day'
  const rows = summary ? usageRows(summary.buckets, grouping) : []
  return createPortal(<div className="modal-backdrop" onMouseDown={event => { if (event.currentTarget === event.target) onClose() }}>
    <section className="modal usage-dialog" role="dialog" aria-modal="true" aria-label="Your usage" tabIndex={-1} ref={dialog}>
      <header className="usage-header"><div><p className="usage-eyebrow">All activity on this engine</p><h2>Your usage</h2><p>A view of the models doing your work.</p></div><button className="quiet-button" type="button" onClick={onAccounts}><UserRoundIcon />Accounts</button><button className="icon-button" type="button" aria-label="Close usage" onClick={onClose}><XIcon /></button></header>
      <div className="usage-body">
        <div className="usage-toolbar"><div className="usage-segments" aria-label="Usage metric">{(['tokens', 'cost'] as const).map(value => <button type="button" key={value} aria-pressed={metric === value} onClick={() => setMetric(value)}>{value === 'tokens' ? 'Tokens' : 'API estimate'}</button>)}</div><div className="usage-segments usage-windows" aria-label="Usage window">{(Object.keys(windows) as UsageWindow[]).map(value => <button type="button" key={value} aria-pressed={window === value} onClick={() => setWindow(value)}>{windows[value]}</button>)}</div><button type="button" className="icon-button" aria-label="Refresh usage" disabled={loading || !connected} onClick={() => setRefresh(value => value + 1)}><RefreshCwIcon /></button></div>
        {loading && <p role="status">Reading usage from the engine…</p>}
        {!connected && <p role="status">Connect the engine to read its usage.</p>}
        {error && <p role="alert">Could not read usage from the engine: {error}</p>}
        {summary && totals && <>
          <div className="usage-metrics"><div><span>Processed tokens</span><strong>{formatTokens(totals.tokens)}</strong><small>{formatCount(totals.sessions)} sessions · {windows[window]}</small></div><div><span>Cached input</span><strong>{formatTokens(totals.cachedInputTokens)}</strong><small>{formatPercent(totals.tokens ? totals.cachedInputTokens / totals.tokens : 0, 0)} of processed tokens</small></div><div><span>Uncached input</span><strong>{formatTokens(totals.uncachedInputTokens)}</strong><small>New input processed</small></div><div><span>Output</span><strong>{formatTokens(totals.outputTokens)}</strong><small>Generated tokens</small></div></div>
          {summary.sources.some(source => source.status === 'partial' || source.status === 'failed') && <p className="usage-quality" role="status">Some transcripts could not be read. Totals include the available records.</p>}
          {totals.unpricedRecords > 0 && <p className="usage-quality">{formatCount(totals.unpricedRecords)} records have tokens but no API price.</p>}
          {summary.pricing.status !== 'fresh' && <p className="usage-quality">{summary.pricing.status === 'cached' ? 'Estimates use cached model prices.' : 'Model prices are unavailable. Estimates include provider-reported costs only.'}</p>}
          {summary.buckets.length ? <UsageChart summary={summary} metric={metric} window={window} /> : <p className="usage-empty">No usage recorded in this window.</p>}
          <div className="usage-breakdown-heading"><h3>Where the usage goes</h3><div className="usage-segments"><button type="button" aria-pressed={group === 'model'} onClick={() => setGroup('model')}>Model</button><button type="button" aria-pressed={group === 'time'} onClick={() => setGroup('time')}>{window === '24h' ? 'Hour' : 'Day'}</button></div></div>
          <table className="usage-table"><thead><tr><th>{group === 'model' ? 'Model' : window === '24h' ? 'Hour' : 'Day'}</th><th>Tokens</th><th>API estimate</th><th>Token share</th></tr></thead><tbody>{rows.map(row => <tr key={row.key}><td>{grouping === 'model' ? row.label : grouping === 'hour' ? formatHourShort(row.label, summary.timeZone) : formatDayShort(row.label)}</td><td>{formatTokens(row.tokens)}</td><td>{formatUsd(row.costUsd)}</td><td><span className="usage-share"><span><i style={{ width: `${totals.tokens ? row.tokens / totals.tokens * 100 : 0}%` }} /></span>{formatPercent(totals.tokens ? row.tokens / totals.tokens : 0, 0)}</span></td></tr>)}</tbody></table>
        </>}
      </div>
      <footer>{summary ? `Updated ${new Date(summary.readAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} · ` : ''}Cost is an API-equivalent estimate. Your subscription bill is separate.</footer>
    </section>
  </div>, document.querySelector('.app-shell') ?? document.body)
}
