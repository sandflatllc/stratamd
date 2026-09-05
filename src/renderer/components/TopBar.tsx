import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react'
import type { DocumentTabView, EngineView, WindowState, WindowAction } from '../../shared/contracts'
import { AGENT_COLORS, textColorFor } from '../model'
import { Logo } from './Logo'
import { WindowControls } from './WindowControls'
import { engineStateLabel } from './EngineDialog'
import { primaryModifierLabel } from '../../shared/primary-modifier'
import { claimEscape } from '../escape'
import { arrangeStrip, isPinned, readPins, togglePin, writePins, type ConversationTabView, type TopBarPins } from '../topbarPins'
import { PathContextMenu, type PathContextMenuState } from './PathContextMenu'
import { menuKeyTarget } from './PathContextMenu'

interface TopBarProps {
  windowState: WindowState | null
  onWindowAction(action: WindowAction): void
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
  /** The system file dialog (§6.9): the one way to open a document from the shell besides drag and drop. */
  onOpenFile(): void
  onSend(): void
  /** A document with no attached thread offers Start thread in place of Send (§5.7). */
  onStartThread?(): void
  zoomed: boolean
  onResetZoom(): void
  onOpenTheme(): void
  /** Conversations open in the center (§5.2, §6); `active` is the one showing there. */
  conversationTabs?: ConversationTabView[]
  onOpenConversationTab?(id: string): void
  onCloseConversation?(id: string): void
  /** The paired engine's state; the status control opens the engine dialog (§5.1, §5.13). */
  engine?: EngineView
  onOpenEngine?(): void
  /** Accounts (§5.13) opens from the logo menu once an engine is paired. */
  onOpenAccounts?(): void
}

type MenuKind = 'app' | 'documents' | 'conversations'

function CloseControl({ name, onClose }: { name: string; onClose(): void }) {
  return <span
    role="button"
    tabIndex={0}
    aria-label={`Close tab ${name}`}
    className="tab-close"
    onClick={(event) => { event.stopPropagation(); onClose() }}
    onKeyDown={(event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        event.stopPropagation()
        onClose()
      }
    }}
  >×</span>
}

/** One dropdown pill: the group label, the active item's name while it is not a pill, and the open count. */
function MenuPill({ kind, label, count, activeName, open, onToggle }: { kind: MenuKind; label: string; count: number; activeName: string | null; open: boolean; onToggle(): void }) {
  return <button
    type="button"
    className={`tab tab-menu ${open ? 'tab-menu-expanded' : ''}`}
    data-menu={kind}
    aria-haspopup="menu"
    aria-expanded={open}
    aria-controls={`topbar-menu-${kind}`}
    aria-label={`${label} menu`}
    onClick={onToggle}
  >
    <span className="tab-menu-label">{label}</span>
    {activeName && <span className="tab-name tab-menu-active">{activeName}</span>}
    <span className="tab-badge tab-menu-count">{count}</span>
    <span className="tab-menu-chevron" aria-hidden="true">▾</span>
  </button>
}

export function TopBar({ windowState, onWindowAction, tabs, canSend, hasAgents, pending, pendingUnsaved, onOpenTab, onCloseTab, onCopyPath, onCloseOthers, onCloseAll, onCloseSaved, onOpenFile, onSend, onStartThread, zoomed, onResetZoom, onOpenTheme, conversationTabs = [], onOpenConversationTab, onCloseConversation, engine, onOpenEngine, onOpenAccounts }: TopBarProps) {
  const conversationTab = conversationTabs.find((tab) => tab.active)
  const tabStrip = useRef<HTMLDivElement>(null)
  const navigation = useRef<HTMLElement>(null)
  const menuRoot = useRef<HTMLDivElement>(null)
  const [menu, setMenu] = useState<PathContextMenuState | null>(null)
  const [openMenu, setOpenMenu] = useState<MenuKind | null>(null)
  const [pins, setPins] = useState<TopBarPins>(() => readPins())
  const strip = arrangeStrip(tabs, conversationTabs, pins, conversationTab !== undefined)
  const activePath = conversationTab ? `conversation:${conversationTab.id}` : tabs.find((tab) => tab.active)?.path
  const activeDocument = tabs.find((tab) => tab.active)
  const openContextMenu = (event: ReactMouseEvent, path: string) => {
    event.preventDefault()
    event.stopPropagation()
    setMenu({ x: event.clientX, y: event.clientY, path })
  }
  const closeContextMenu = () => setMenu(null)
  const pin = useCallback((kind: 'document' | 'conversation', id: string) => {
    setPins((current) => { const next = togglePin(current, kind, id); writePins(next); return next })
  }, [])
  useEffect(() => {
    tabStrip.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activePath, pins])
  useLayoutEffect(() => {
    if (!openMenu) return
    const away = (event: Event) => { if (!menuRoot.current?.contains(event.target as Node) && !navigation.current?.querySelector(`[data-menu="${openMenu}"]`)?.contains(event.target as Node)) setOpenMenu(null) }
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Tab') { setOpenMenu(null); return }
      if (event.key !== 'Escape') return
      claimEscape(event)
      setOpenMenu(null)
      navigation.current?.querySelector<HTMLElement>(`[data-menu="${openMenu}"]`)?.focus()
    }
    const blur = () => setOpenMenu(null)
    window.addEventListener('pointerdown', away, true)
    window.addEventListener('keydown', key)
    window.addEventListener('blur', blur)
    menuRoot.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
    return () => {
      window.removeEventListener('pointerdown', away, true)
      window.removeEventListener('keydown', key)
      window.removeEventListener('blur', blur)
    }
  }, [openMenu])
  const menuKeys = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = [...(menuRoot.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])]
    const current = items.indexOf(document.activeElement as HTMLElement)
    const next = menuKeyTarget(items, current, event.key)
    if (next === null) return
    event.preventDefault()
    items[next]?.focus()
  }
  const accountsAttention = engine?.accounts.some(account => !account.usable && !account.parked) ?? false
  const menuAction = (action: () => void) => {
    setOpenMenu(null)
    navigation.current?.querySelector<HTMLElement>('[data-menu="app"]')?.focus()
    action()
  }
  const sendTitle = `${pending} pending${pendingUnsaved ? ' · Unsaved changes' : ''} · ${primaryModifierLabel()}+Enter`
  const pinLabel = (pinned: boolean, name: string) => `${pinned ? 'Unpin' : 'Pin'} ${name}`

  const documentPill = (tab: DocumentTabView) => {
    const active = !conversationTab && tab.active
    return <button
      type="button"
      role="tab"
      aria-selected={active}
      className={`tab ${active ? 'tab-active' : ''} ${isPinned(pins, 'document', tab.path) ? 'tab-pinned' : ''}`}
      key={tab.path}
      title={tab.name}
      onClick={() => onOpenTab(tab.path)}
      // A middle click closes the tab; its mousedown default would start autoscroll.
      onMouseDown={(event) => { if (event.button === 1) event.preventDefault() }}
      onAuxClick={(event) => { if (event.button === 1) { event.preventDefault(); onCloseTab(tab) } }}
      onContextMenu={(event) => openContextMenu(event, tab.path)}
    >
      {isPinned(pins, 'document', tab.path) && <span className="tab-pin-mark" aria-hidden="true">★</span>}
      <span className="tab-name">{tab.name}</span>
      {tab.dirty && <span className="tab-dirty-dot" aria-label="Unsaved changes" title="Unsaved changes" />}
      {tab.pendingCount > 0 && <span className="tab-badge" style={tab.pendingColor ? { background: AGENT_COLORS[tab.pendingColor], color: textColorFor(AGENT_COLORS[tab.pendingColor]) } : undefined}>{tab.pendingCount}</span>}
      <CloseControl name={tab.name} onClose={() => onCloseTab(tab)} />
    </button>
  }
  const conversationPill = (tab: ConversationTabView) => <button
    type="button"
    role="tab"
    aria-selected={tab.active}
    className={`tab conversation-tab ${tab.active ? 'tab-active' : ''} ${isPinned(pins, 'conversation', tab.id) ? 'tab-pinned' : ''}`}
    title={tab.name}
    key={tab.id}
    onClick={() => onOpenConversationTab?.(tab.id)}
    onMouseDown={(event) => { if (event.button === 1) event.preventDefault() }}
    onAuxClick={(event) => { if (event.button === 1) { event.preventDefault(); onCloseConversation?.(tab.id) } }}
  >
    {isPinned(pins, 'conversation', tab.id) && <span className="tab-pin-mark" aria-hidden="true">★</span>}
    <span className="tab-name">{tab.name}</span>
    {tab.attention > 0 && <span className="tab-badge attention-badge" aria-label={`${tab.attention} new`}>{tab.attention}</span>}
    <CloseControl name={tab.name} onClose={() => onCloseConversation?.(tab.id)} />
  </button>

  const documentsMenu = <div ref={menuRoot} id="topbar-menu-documents" className="tab-menu-list" role="menu" aria-label="Open docs" onKeyDown={menuKeys}>
    {strip.documents.menu.length === 0 && <p className="tab-menu-empty">No documents open.</p>}
    {strip.documents.menu.map((tab) => {
      const active = !conversationTab && tab.active
      const pinned = isPinned(pins, 'document', tab.path)
      return <div className={`tab-menu-row ${active ? 'tab-menu-row-active' : ''}`} key={tab.path} data-pinned={pinned || undefined}>
        <button type="button" role="menuitem" className="tab-menu-open" aria-current={active || undefined} title={tab.path} onClick={() => { setOpenMenu(null); onOpenTab(tab.path) }} onContextMenu={(event) => openContextMenu(event, tab.path)}>
          <span className="tab-name">{tab.name}</span>
          {tab.dirty && <span className="tab-dirty-dot" aria-label="Unsaved changes" title="Unsaved changes" />}
          {tab.pendingCount > 0 && <span className="tab-badge" style={tab.pendingColor ? { background: AGENT_COLORS[tab.pendingColor], color: textColorFor(AGENT_COLORS[tab.pendingColor]) } : undefined}>{tab.pendingCount}</span>}
        </button>
        <button type="button" className="tab-pin" aria-pressed={pinned} aria-label={pinLabel(pinned, tab.name)} title={pinLabel(pinned, tab.name)} onClick={() => pin('document', tab.path)}>{pinned ? '★' : '☆'}</button>
        <button type="button" className="tab-menu-close" aria-label={`Close ${tab.name}`} title={`Close ${tab.name}`} onClick={() => onCloseTab(tab)}>×</button>
      </div>
    })}
  </div>
  const conversationsMenu = <div ref={menuRoot} id="topbar-menu-conversations" className="tab-menu-list" role="menu" aria-label="Open conversations" onKeyDown={menuKeys}>
    {strip.conversations.menu.length === 0 && <p className="tab-menu-empty">No conversations open. Choose a thread under Projects.</p>}
    {strip.conversations.menu.map((tab) => {
      const pinned = isPinned(pins, 'conversation', tab.id)
      return <div className={`tab-menu-row ${tab.active ? 'tab-menu-row-active' : ''}`} key={tab.id} data-pinned={pinned || undefined}>
        <button type="button" role="menuitem" className="tab-menu-open" aria-current={tab.active || undefined} title={tab.name} onClick={() => { setOpenMenu(null); onOpenConversationTab?.(tab.id) }}>
          <span className="tab-name">{tab.name}</span>
          {tab.attention > 0 && <span className="tab-badge attention-badge" aria-label={`${tab.attention} new`}>{tab.attention}</span>}
        </button>
        <button type="button" className="tab-pin" aria-pressed={pinned} aria-label={pinLabel(pinned, tab.name)} title={pinLabel(pinned, tab.name)} onClick={() => pin('conversation', tab.id)}>{pinned ? '★' : '☆'}</button>
        <button type="button" className="tab-menu-close" aria-label={`Close ${tab.name}`} title={`Close ${tab.name}`} onClick={() => onCloseConversation?.(tab.id)}>×</button>
      </div>
    })}
  </div>

  return (
    <header className="topbar" ref={navigation} data-window-chrome={windowState?.chrome} data-fullscreen={windowState?.fullscreen} data-maximized={windowState?.maximized} data-focused={windowState?.focused}>
      <span className="tab-menu-anchor app-menu-anchor">
        <button type="button" className="app-menu-trigger" data-menu="app" aria-label="StrataMD menu" aria-haspopup="menu" aria-expanded={openMenu === 'app'} aria-controls={openMenu === 'app' ? 'topbar-menu-app' : undefined} title={accountsAttention ? 'StrataMD menu · Accounts needs attention' : 'StrataMD menu'} onClick={() => setOpenMenu(current => current === 'app' ? null : 'app')}>
          <Logo compact />
          <span className="app-menu-chevron" aria-hidden="true">▾</span>
          {accountsAttention && <i className="attention-dot" aria-label="Accounts needs attention" />}
        </button>
        {openMenu === 'app' && <div ref={menuRoot} id="topbar-menu-app" className="tab-menu-list app-menu-list" role="menu" aria-label="StrataMD" onKeyDown={menuKeys}>
          <button type="button" role="menuitem" className="tab-menu-open open-file-button" onClick={() => menuAction(onOpenFile)}>Open file <kbd>{primaryModifierLabel()}+O</kbd></button>
          {engine && engine.state !== 'unpaired' && onOpenAccounts && <button type="button" role="menuitem" className="tab-menu-open accounts-button" aria-label="Accounts" onClick={() => menuAction(onOpenAccounts)}>Accounts{accountsAttention && <span className="account-warning">Needs attention</span>}</button>}
          <button type="button" role="menuitem" className="tab-menu-open theme-button" onClick={() => menuAction(onOpenTheme)}>Theme</button>
          {zoomed && <button type="button" role="menuitem" className="tab-menu-open reset-zoom" onClick={() => menuAction(onResetZoom)}>Reset zoom</button>}
        </div>}
      </span>
      <div className="tab-navigation">
        <span className="tab-menu-anchor">
          <MenuPill kind="documents" label="Docs" count={tabs.length} activeName={activeDocument && !conversationTab && !strip.documents.pills.includes(activeDocument) ? activeDocument.name : null} open={openMenu === 'documents'} onToggle={() => setOpenMenu((current) => current === 'documents' ? null : 'documents')} />
          {openMenu === 'documents' && documentsMenu}
        </span>
        <span className="tab-menu-anchor">
          <MenuPill kind="conversations" label="Conversations" count={conversationTabs.length} activeName={null} open={openMenu === 'conversations'} onToggle={() => setOpenMenu((current) => current === 'conversations' ? null : 'conversations')} />
          {openMenu === 'conversations' && conversationsMenu}
        </span>
        <div
          className="tabs"
          role="tablist"
          aria-label="Open documents"
          ref={tabStrip}
          onWheel={(event) => {
            if (event.deltaY !== 0 && event.deltaX === 0) event.currentTarget.scrollLeft += event.deltaY
          }}
        >
          {strip.documents.pills.map(documentPill)}
          {strip.conversations.pills.map(conversationPill)}
        </div>
      </div>
      <div className="window-drag-space" aria-hidden="true" />
      {menu && <PathContextMenu menu={menu} onCopyPath={onCopyPath} onClose={closeContextMenu} onTogglePin={(path) => pin('document', path)} pinned={isPinned(pins, 'document', menu.path)} {...(onCloseOthers ? { onCloseOthers } : {})} {...(onCloseAll ? { onCloseAll } : {})} {...(onCloseSaved ? { onCloseSaved } : {})} />}
      {engine && onOpenEngine && (
        <button type="button" className="text-action engine-status" data-state={engine.state} aria-label="Engine status" title={`${engineStateLabel(engine)} · ${engine.server ?? 'No engine paired'}`} onClick={onOpenEngine}>
          <i className={`state-dot state-${engine.state === 'connected' ? 'ready' : engine.state === 'connecting' ? 'starting' : 'disconnected'}`} aria-hidden="true" />
          <span className="engine-status-label">{engine.state === 'unpaired' ? 'Pair engine' : engineStateLabel(engine)}</span>
        </button>
      )}
      <span className="pending-status" data-unsaved={pendingUnsaved} title="Next change · F7. Previous change · Shift+F7. All shortcuts · F1">{pending} pending</span>
      {hasAgents || !onStartThread
        ? <button type="button" className="send-button" title={sendTitle} data-enabled={canSend} onClick={onSend} disabled={!canSend}>Send ↗</button>
        : <button type="button" className="send-button" title={sendTitle} data-enabled onClick={onStartThread}>Start thread</button>}
      <WindowControls state={windowState} onAction={onWindowAction} />
    </header>
  )
}
