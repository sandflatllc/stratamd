import { useId, useLayoutEffect, useRef, useState } from 'react'
import type { CompactContextAction } from '../useContextCompaction'
import './context-compaction.css'
import type { EngineActivityView } from '../../shared/contracts'

function tokenCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

/** T3 reports current context separately from cumulative account usage. */
function latestContext(activities: readonly EngineActivityView[]) {
  for (let index = activities.length - 1; index >= 0; index--) {
    const activity = activities[index]!
    if (activity.kind !== 'context-window.updated' || !activity.payload || typeof activity.payload !== 'object') continue
    const payload = activity.payload as Record<string, unknown>
    const used = tokenCount(payload.usedTokens)
    if (used === null) continue
    const limit = tokenCount(payload.maxTokens)
    return {
      used,
      limit: limit !== null && limit > 0 ? limit : null,
      compactsAutomatically: payload.compactsAutomatically === true,
      threshold: tokenCount(payload.autoCompactThreshold),
    }
  }
  return null
}

export function ContextWindowMeter({ activities, compact }: { activities: readonly EngineActivityView[]; compact?: CompactContextAction }) {
  const [open, setOpen] = useState(false)
  const control = useRef<HTMLSpanElement>(null)
  const popup = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const element = popup.current
    if (!open || !element) return
    element.showPopover()
    const place = () => {
      const box = control.current!.closest('.chat-composer-box')?.getBoundingClientRect() ?? control.current!.getBoundingClientRect()
      const width = Math.min(320, window.innerWidth - 24)
      element.style.width = `${width}px`
      element.style.left = `${Math.max(12, Math.min(box.right - width, window.innerWidth - width - 12))}px`
      element.style.top = `${Math.max(12, box.top - element.getBoundingClientRect().height - 10)}px`
    }
    place()
    const observer = new ResizeObserver(place)
    observer.observe(element)
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => { observer.disconnect(); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); if (element.matches(':popover-open')) element.hidePopover() }
  }, [open])
  const tooltipId = useId()
  const usage = latestContext(activities)
  const percentage = usage?.limit ? Math.min(100, usage.used / usage.limit * 100) : null
  const percentLabel = percentage === null ? null : `${Number(percentage.toFixed(1))}%`
  const count = (value: number) => Math.round(value).toLocaleString()
  const label = usage
    ? percentage === null ? `Context window: ${count(usage.used)} tokens used; limit not reported` : `Context window: ${percentLabel} used, ${count(usage.used)} of ${count(usage.limit!)} tokens`
    : 'Context usage not reported yet'

  return <span ref={control} className="chat-context-control" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false) }} onKeyDown={event => { if (event.key === 'Escape') { setOpen(false); event.stopPropagation() } }}>
  <span className="chat-context-meter" tabIndex={0} role={compact ? "button" : "img"} aria-label={label} aria-expanded={compact ? open : undefined} onClick={() => compact && setOpen(!open)} onKeyDown={event => { if (compact && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); setOpen(!open) } }} aria-describedby={tooltipId} data-unknown={percentage === null || undefined} data-full={percentage !== null && percentage > 90 || undefined}>
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle className="chat-context-track" cx="12" cy="12" r="9" />
      {percentage !== null && percentage > 0 && <circle className="chat-context-fill" cx="12" cy="12" r="9" pathLength="100" strokeDasharray={`${percentage} 100`} transform="rotate(-90 12 12)" />}
    </svg>
    <span className="chat-context-tooltip" id={tooltipId} role="tooltip">
      <strong>Context window</strong>
      <span>{usage ? <>{percentLabel && `${percentLabel} used · `}{count(usage.used)}{usage.limit ? ` / ${count(usage.limit)}` : ''} tokens{!usage.limit && ' · limit not reported'}</> : 'Context usage not reported yet'}</span>
      {usage?.compactsAutomatically && <span>{usage.threshold ? `Compacts automatically at ${count(usage.threshold)} tokens.` : 'Compacts automatically when needed.'}</span>}
    </span>
  </span>
  {compact && open && <div ref={popup} popover="auto" onToggle={event => { if (!event.currentTarget.matches(':popover-open')) setOpen(false) }} className="chat-menu context-compaction-menu" role="dialog" aria-label="Context actions">
    <h3>Context{percentLabel ? ` · ${percentLabel} used` : ''}</h3>
    <p>Summary replaces older model context. Your visible conversation stays available.</p>
    <button type="button" disabled={!!compact.disabledReason} onClick={() => { setOpen(false); void compact.execute() }}>{compact.working ? 'Compacting context…' : 'Compact context'}</button>
    <p>{compact.disabledReason ?? (usage ? `Provider report · ${count(usage.used)}${usage.limit ? ` of ${count(usage.limit)}` : ''} tokens` : 'Context usage not reported yet')}</p>
    {compact.error && <p role="alert">{compact.error} Try again when the engine is ready.</p>}
  </div>}
  </span>
}
