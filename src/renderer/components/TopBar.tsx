import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import type { DocumentTabView, EngineView } from '../../shared/contracts'
import { AGENT_COLORS, textColorFor } from '../model'
import { Logo } from './Logo'
import { engineStateLabel } from './EngineDialog'
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
  /** A document with no attached thread offers Start thread in place of Send (§5.7). */
  onStartThread?(): void
  zoomed: boolean
  onResetZoom(): void
  onOpenTheme(): void
  /** Conversation tabs beside the documents (§5.2, §6); `active` is the one showing in the center. */
  conversationTabs?: Array<{ id: string; name: string; attention: number; active: boolean }>
  onOpenConversationTab?(id: string): void
  onCloseConversation?(id: string): void
  /** The paired engine's state; the status control opens the engine dialog (§5.1, §5.13). */
  engine?: EngineView
  onOpenEngine?(): void
  /** Accounts (§5.13) opens from the engine status area once an engine is paired. */
  onOpenAccounts?(): void
}

export function TopBar({ tabs, canSend, hasAgents, pending, pendingUnsaved, onOpenTab, onCloseTab, onCopyPath, onCloseOthers, onCloseAll, onCloseSaved, onSend, onStartThread, zoomed, onResetZoom, onOpenTheme, conversationTabs = [], onOpenConversationTab, onCloseConversation, engine, onOpenEngine, onOpenAccounts }: TopBarProps) {
  const conversationTab = conversationTabs.find((tab) => tab.active)
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
        {conversationTabs.map((tab) => <button type="button" role="tab" aria-selected={tab.active} className={`tab conversation-tab ${tab.active ? 'tab-active' : ''}`} title={tab.name} key={tab.id} onClick={() => onOpenConversationTab?.(tab.id)}>
          <span className="tab-name">{tab.name}</span>
          {tab.attention > 0 && <span className="tab-badge attention-badge" aria-label={`${tab.attention} new`}>{tab.attention}</span>}
          <span role="button" tabIndex={0} aria-label={`Close tab ${tab.name}`} className="tab-close" onClick={(event) => { event.stopPropagation(); onCloseConversation?.(tab.id) }} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); onCloseConversation?.(tab.id) } }}>×</span>
        </button>)}
      </div>
      {menu && <PathContextMenu menu={menu} onCopyPath={onCopyPath} onClose={closeMenu} {...(onCloseOthers ? { onCloseOthers } : {})} {...(onCloseAll ? { onCloseAll } : {})} {...(onCloseSaved ? { onCloseSaved } : {})} />}
      <div className="topbar-spacer" />
      {engine && onOpenEngine && (
        <button type="button" className="text-action engine-status" data-state={engine.state} aria-label="Engine status" title={engine.server ?? 'No engine paired'} onClick={onOpenEngine}>
          <i className={`state-dot state-${engine.state === 'connected' || engine.state === 'mismatch' ? 'ready' : engine.state === 'connecting' ? 'starting' : 'disconnected'}`} aria-hidden="true" />
          {engine.state === 'unpaired' ? 'Pair engine' : engineStateLabel(engine)}
        </button>
      )}
      {engine && engine.state !== 'unpaired' && onOpenAccounts && (
        <button type="button" className="text-action accounts-button" aria-label="Accounts" title={engine.accounts.length ? `${engine.accounts.filter((account) => account.usable).length} of ${engine.accounts.length} accounts can take a thread` : 'Provider accounts'} onClick={onOpenAccounts}>
          Accounts{engine.accounts.some((account) => !account.usable && !account.parked) && <i className="attention-dot" aria-hidden="true" />}
        </button>
      )}
      <button type="button" className="text-action theme-button" onClick={onOpenTheme}>Theme</button>
      {zoomed && <button type="button" className="text-action reset-zoom" onClick={onResetZoom}>Reset zoom</button>}
      <span className="pending-status" data-unsaved={pendingUnsaved} title="Next change · F7. Previous change · Shift+F7. All shortcuts · F1">{pending} pending</span>
      <kbd>{primaryModifierLabel()}+Enter</kbd>
      {hasAgents || !onStartThread
        ? <button type="button" className="send-button" data-enabled={canSend} onClick={onSend} disabled={!canSend}>Send ↗</button>
        : <button type="button" className="send-button" data-enabled onClick={onStartThread}>Start thread</button>}
    </header>
  )
}
