import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import type { DocumentTabView } from '../../shared/contracts'
import { AGENT_COLORS, textColorFor } from '../model'
import { Logo } from './Logo'
import { primaryModifierLabel } from '../../shared/primary-modifier'
import { PathContextMenu, type PathContextMenuState } from './PathContextMenu'

interface TopBarProps {
  tabs: DocumentTabView[]
  canSend: boolean
  hasAgents: boolean
  pending: number
  /** Tints the pending total while any counted change is unsaved (PRD §6.9). */
  pendingUnsaved: boolean
  onOpenTab(path: string): void
  onCloseTab(tab: DocumentTabView): void
  onCopyPath(path: string): void
  onSend(): void
  onCopy(): void
  zoomed: boolean
  onResetZoom(): void
  onOpenTheme(): void
}

export function TopBar({ tabs, canSend, hasAgents, pending, pendingUnsaved, onOpenTab, onCloseTab, onCopyPath, onSend, onCopy, zoomed, onResetZoom, onOpenTheme }: TopBarProps) {
  const tabStrip = useRef<HTMLDivElement>(null)
  const [menu, setMenu] = useState<PathContextMenuState | null>(null)
  const activePath = tabs.find((tab) => tab.active)?.path
  const openMenu = (event: ReactMouseEvent, path: string) => {
    event.preventDefault()
    event.stopPropagation()
    setMenu({ x: event.clientX, y: event.clientY, path })
  }
  const closeMenu = () => setMenu(null)
  useEffect(() => {
    tabStrip.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activePath])
  return (
    <header className="topbar">
      <Logo />
      <div
        className="tabs"
        role="tablist"
        aria-label="Open documents"
        ref={tabStrip}
        onWheel={(event) => {
          if (event.deltaY !== 0 && event.deltaX === 0) event.currentTarget.scrollLeft += event.deltaY
        }}
      >
        {tabs.map((tab) => (
          <button
            type="button"
            role="tab"
            aria-selected={tab.active}
            className={`tab ${tab.active ? 'tab-active' : ''}`}
            key={tab.path}
            title={tab.name}
            onClick={() => onOpenTab(tab.path)}
            onContextMenu={(event) => openMenu(event, tab.path)}
          >
            <span className="tab-name">{tab.name}</span>
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
      {menu && <PathContextMenu menu={menu} onCopyPath={onCopyPath} onClose={closeMenu} />}
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
