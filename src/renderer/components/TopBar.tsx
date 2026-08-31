import type { DocumentTabView } from '../../shared/contracts'
import { AGENT_COLORS, textColorFor } from '../model'
import { Logo } from './Logo'
import { primaryModifierLabel } from '../../shared/primary-modifier'

interface TopBarProps {
  tabs: DocumentTabView[]
  canSend: boolean
  hasAgents: boolean
  pending: number
  /** Tints the pending total while any counted change is unsaved (PRD §6.9). */
  pendingUnsaved: boolean
  onOpenTab(path: string): void
  onCloseTab(tab: DocumentTabView): void
  onSend(): void
  onCopy(): void
  zoomed: boolean
  onResetZoom(): void
  onOpenTheme(): void
}

export function TopBar({ tabs, canSend, hasAgents, pending, pendingUnsaved, onOpenTab, onCloseTab, onSend, onCopy, zoomed, onResetZoom, onOpenTheme }: TopBarProps) {
  return (
    <header className="topbar">
      <Logo />
      <div className="tabs" role="tablist" aria-label="Open documents">
        {tabs.map((tab) => (
          <button
            type="button"
            role="tab"
            aria-selected={tab.active}
            className={`tab ${tab.active ? 'tab-active' : ''}`}
            key={tab.path}
            onClick={() => onOpenTab(tab.path)}
          >
            <span>{tab.name}</span>
            {tab.dirty && <span className="tab-dirty-dot" aria-label="Unsaved changes" title="Unsaved changes" />}
            {tab.pendingCount > 0 && <span className="tab-badge" style={tab.pendingColor ? { background: AGENT_COLORS[tab.pendingColor], color: textColorFor(AGENT_COLORS[tab.pendingColor]) } : undefined}>{tab.pendingCount}</span>}
            <span
              role="button"
              tabIndex={0}
              aria-label={`Close tab ${tab.name}`}
              className="tab-close"
              onClick={(event) => { event.stopPropagation(); onCloseTab(tab) }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  event.stopPropagation()
                  onCloseTab(tab)
                }
              }}
            >×</span>
          </button>
        ))}
      </div>
      <div className="topbar-spacer" />
      <button type="button" className="text-action theme-button" onClick={onOpenTheme}>Theme</button>
      {zoomed && <button type="button" className="text-action reset-zoom" onClick={onResetZoom}>Reset zoom</button>}
      <span className="pending-status" data-unsaved={pendingUnsaved}>{pending} pending</span>
      <kbd>{primaryModifierLabel()}+Enter</kbd>
      {hasAgents ? (
        <button type="button" className="send-button" data-enabled={canSend} onClick={onSend} disabled={!canSend}>Send ↗</button>
      ) : (
        <button type="button" className="copy-button" onClick={onCopy}>Copy for agent ⧉</button>
      )}
    </header>
  )
}
