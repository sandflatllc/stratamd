import { useId } from 'react'
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

export function ContextWindowMeter({ activities }: { activities: readonly EngineActivityView[] }) {
  const tooltipId = useId()
  const usage = latestContext(activities)
  const percentage = usage?.limit ? Math.min(100, usage.used / usage.limit * 100) : null
  const percentLabel = percentage === null ? null : `${Number(percentage.toFixed(1))}%`
  const count = (value: number) => Math.round(value).toLocaleString()
  const label = usage
    ? percentage === null ? `Context window: ${count(usage.used)} tokens used; limit not reported` : `Context window: ${percentLabel} used, ${count(usage.used)} of ${count(usage.limit!)} tokens`
    : 'Context usage not reported yet'

  return <span className="chat-context-meter" tabIndex={0} role="img" aria-label={label} aria-describedby={tooltipId} data-unknown={percentage === null || undefined} data-full={percentage !== null && percentage > 90 || undefined}>
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
}
