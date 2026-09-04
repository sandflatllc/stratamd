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
  /** Tab menu bulk actions (§5.16). */
  onCloseOthers?(path: string): void
  onCloseAll?(): void
  onCloseSaved?(): void
  onSend(): void
  zoomed: boolean
  onResetZoom(): void
  onOpenTheme(): void
  conversationTab?: { id: string; name: string }
  onCloseConversation?(): void
}

export function TopBar({ tabs, canSend, hasAgents, pending, pendingUnsaved, onOpenTab, onCloseTab, onCopyPath, onCloseOthers, onCloseAll, onCloseSaved, onSend, zoomed, onResetZoom, onOpenTheme, conversationTab, onCloseConversation }: TopBarProps) {
  const tabStrip = useRef<HTMLDivElement>(null)
  const [menu, setMenu] = useState<PathContextMenuState | null>(null)
  const activePath = conversationTab ? `conversation:${conversationTab.id}` : tabs.find((tab) => tab.active)?.path
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
            aria-selected={!conversationTab && tab.active}
            className={`tab ${!conversationTab && tab.active ? 'tab-active' : ''}`}
            key={tab.path}
            title={tab.name}
            onClick={() => onOpenTab(tab.path)}
            // A middle click closes the tab; its mousedown default would start autoscroll.
            onMouseDown={(event) => { if (event.button === 1) event.preventDefault() }}
            onAuxClick={(event) => { if (event.button === 1) { event.preventDefault(); onCloseTab(tab) } }}
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
        {conversationTab && <button type="button" role="tab" aria-selected className="tab tab-active conversation-tab" title={conversationTab.name}>
          <span className="tab-name">{conversationTab.name}</span>
          <span role="button" tabIndex={0} aria-label={`Close tab ${conversationTab.name}`} className="tab-close" onClick={(event) => { event.stopPropagation(); onCloseConversation?.() }} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onCloseConversation?.() } }}>×</span>
        </button>}
      </div>
      {menu && <PathContextMenu menu={menu} onCopyPath={onCopyPath} onClose={closeMenu} {...(onCloseOthers ? { onCloseOthers } : {})} {...(onCloseAll ? { onCloseAll } : {})} {...(onCloseSaved ? { onCloseSaved } : {})} />}
      <div className="topbar-spacer" />
      <button type="button" className="text-action theme-button" onClick={onOpenTheme}>Theme</button>
      {zoomed && <button type="button" className="text-action reset-zoom" onClick={onResetZoom}>Reset zoom</button>}
      <span className="pending-status" data-unsaved={pendingUnsaved} title="Next change · F7. Previous change · Shift+F7. All shortcuts · F1">{pending} pending</span>
      <kbd>{primaryModifierLabel()}+Enter</kbd>
      <button type="button" className="send-button" data-enabled={canSend} onClick={onSend} disabled={!canSend}>{hasAgents ? 'Send ↗' : 'Start thread'}</button>
    </header>
  )
}
