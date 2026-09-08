import { FileTextIcon, MessageSquareIcon, GlobeIcon } from '../icons/lucide'
import { useCallback, useLayoutEffect, useRef, useState, type ReactNode, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react'
import type { DocumentTabView, EngineView, WindowState, WindowAction } from '../../shared/contracts'
import { AGENT_COLORS, textColorFor } from '../model'
import { Logo } from './Logo'
import { WindowControls } from './WindowControls'
import { engineStateLabel } from './EngineDialog'
import { primaryModifierLabel } from '../../shared/primary-modifier'
import { claimEscape } from '../escape'
import { orderPinned, isPinned, readPins, togglePin, writePins, type ConversationTabView, type TopBarPins, type PinKind } from '../topbarPins'
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
  onOpenUsage?(): void
  onToggleTerminal?(): void
  onOpenAccounts?(): void
  onOpenSettings?(): void
  /** Open web views, named by project and page, listed in the web view dropdown. */
  previewPills?: Array<{ id: string; name: string; active: boolean; held: boolean }>
  onOpenPreviewPill?(id: string): void
  onClosePreviewPill?(id: string): void
  /** Opens a preview window for the active project from the logo menu. */
  onOpenPreview?(): void
}

type MenuKind = 'app' | 'documents' | 'conversations' | 'previews'

/** One icon dropdown for each kind of open content. */
function MenuPill({ kind, label, icon, count, open, onToggle }: { kind: MenuKind; label: string; icon: ReactNode; count: number; open: boolean; onToggle(): void }) {
  return <button
    type="button"
    className={`tab tab-menu ${open ? 'tab-menu-expanded' : ''}`}
    data-menu={kind}
    aria-haspopup="menu"
    aria-expanded={open}
    aria-controls={open ? `topbar-menu-${kind}` : undefined}
    aria-label={`${label} menu`}
    title={label}
    onClick={onToggle}
  >
    {icon}
    <span className="tab-badge tab-menu-count">{count}</span>
    <span className="tab-menu-chevron" aria-hidden="true">▾</span>
  </button>
}

interface OpenItem {
  id: string
  name: string
  title?: string
  active: boolean
  badge?: ReactNode
  onOpen(): void
  onClose(): void
  onContextMenu?(event: ReactMouseEvent): void
}

export function TopBar({ windowState, onWindowAction, tabs, canSend, hasAgents, pending, pendingUnsaved, onOpenTab, onCloseTab, onCopyPath, onCloseOthers, onCloseAll, onCloseSaved, onOpenFile, onSend, onStartThread, zoomed, onResetZoom, onOpenTheme, conversationTabs = [], onOpenConversationTab, onCloseConversation, engine, onOpenEngine, onOpenAccounts, onOpenSettings, onToggleTerminal, onOpenUsage, previewPills = [], onOpenPreviewPill, onClosePreviewPill, onOpenPreview }: TopBarProps) {
  const previewActive = previewPills.some((pill) => pill.active)
  const conversationTab = previewActive ? undefined : conversationTabs.find((tab) => tab.active)
  const navigation = useRef<HTMLElement>(null)
  const menuRoot = useRef<HTMLDivElement>(null)
  const [menu, setMenu] = useState<PathContextMenuState | null>(null)
  const [openMenu, setOpenMenu] = useState<MenuKind | null>(null)
  const [pins, setPins] = useState<TopBarPins>(() => readPins())
  const openContextMenu = (event: ReactMouseEvent, path: string) => {
    event.preventDefault()
    event.stopPropagation()
    setOpenMenu(null)
    setMenu({ x: event.clientX, y: event.clientY, path })
  }
  const closeContextMenu = () => setMenu(null)
  const pin = useCallback((kind: PinKind, id: string) => {
    setPins((current) => { const next = togglePin(current, kind, id); writePins(next); return next })
  }, [])
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
  const showAccounts = engine && engine.state !== 'unpaired' && onOpenAccounts
  const menuAction = (action: () => void) => {
    setOpenMenu(null)
    navigation.current?.querySelector<HTMLElement>('[data-menu="app"]')?.focus()
    action()
  }
  const sendTitle = `${pending} pending${pendingUnsaved ? ' · Unsaved changes' : ''} · ${primaryModifierLabel()}+Enter`
  const pinLabel = (pinned: boolean, name: string) => `${pinned ? 'Unpin' : 'Pin'} ${name}`

  const documentItems: OpenItem[] = tabs.map((tab) => ({
    id: tab.path, name: tab.name, title: tab.path, active: !conversationTab && !previewActive && tab.active,
    badge: <>{tab.dirty && <span className="tab-dirty-dot" aria-label="Unsaved changes" title="Unsaved changes" />}{tab.pendingCount > 0 && <span className="tab-badge" style={tab.pendingColor ? { background: AGENT_COLORS[tab.pendingColor], color: textColorFor(AGENT_COLORS[tab.pendingColor]) } : undefined}>{tab.pendingCount}</span>}</>,
    onOpen: () => onOpenTab(tab.path), onClose: () => onCloseTab(tab),
    onContextMenu: (event) => openContextMenu(event, tab.path),
  }))
  const conversationItems: OpenItem[] = conversationTabs.map((tab) => ({
    id: tab.id, name: tab.name, active: !previewActive && tab.active,
    badge: tab.attention > 0 ? <span className="tab-badge attention-badge" aria-label={`${tab.attention} new`}>{tab.attention}</span> : null,
    onOpen: () => onOpenConversationTab?.(tab.id), onClose: () => onCloseConversation?.(tab.id),
  }))
  const previewItems: OpenItem[] = previewPills.map((tab) => ({
    id: tab.id, name: tab.name, active: tab.active,
    badge: tab.held ? <span className="tab-dirty-dot" aria-label="Held visual comments" title="Held visual comments" /> : null,
    onOpen: () => onOpenPreviewPill?.(tab.id), onClose: () => onClosePreviewPill?.(tab.id),
  }))
  const closeContentItem = (kind: MenuKind, item: OpenItem, count: number) => {
    if (count === 1) {
      setOpenMenu(null)
      navigation.current?.querySelector<HTMLElement>(`[data-menu="${kind}"]`)?.focus()
    }
    item.onClose()
  }
  const contentMenu = (kind: Exclude<MenuKind, 'app'>, pinKind: PinKind, label: string, empty: string, items: OpenItem[]) => (
    <div ref={menuRoot} id={`topbar-menu-${kind}`} className="tab-menu-list" role="menu" aria-label={label} onKeyDown={menuKeys}>
      {items.length === 0 && <p className="tab-menu-empty">{empty}</p>}
      {orderPinned(items, pins, pinKind).map((item) => {
        const pinned = isPinned(pins, pinKind, item.id)
        return <div className={`tab-menu-row ${item.active ? 'tab-menu-row-active' : ''}`} key={item.id} data-pinned={pinned || undefined}>
          <button type="button" role="menuitem" className="tab-menu-open" aria-current={item.active || undefined} title={item.title ?? item.name}
            onClick={() => { setOpenMenu(null); navigation.current?.querySelector<HTMLElement>(`[data-menu="${kind}"]`)?.focus(); item.onOpen() }}
            onMouseDown={(event) => { if (event.button === 1) event.preventDefault() }}
            onAuxClick={(event) => { if (event.button === 1) { event.preventDefault(); closeContentItem(kind, item, items.length) } }}
            onContextMenu={item.onContextMenu}>
            <span className="tab-name">{item.name}</span>{item.badge}
          </button>
          <button type="button" className="tab-pin" aria-pressed={pinned} aria-label={pinLabel(pinned, item.name)} title={pinLabel(pinned, item.name)} onClick={() => pin(pinKind, item.id)}>{pinned ? '★' : '☆'}</button>
          <button type="button" className="tab-menu-close" aria-label={`Close ${item.name}`} title={`Close ${item.name}`} onClick={() => closeContentItem(kind, item, items.length)}>×</button>
        </div>
      })}
    </div>
  )

  return (
    <header className="topbar" ref={navigation} data-menu-open={openMenu !== null} data-window-chrome={windowState?.chrome} data-fullscreen={windowState?.fullscreen} data-maximized={windowState?.maximized} data-focused={windowState?.focused}>
      {openMenu && <div className="topbar-menu-dismiss" aria-hidden="true" onPointerDown={() => setOpenMenu(null)} />}
      <span className="tab-menu-anchor app-menu-anchor">
        <button type="button" className="app-menu-trigger" data-menu="app" aria-label="StrataMD menu" aria-haspopup="menu" aria-expanded={openMenu === 'app'} aria-controls={openMenu === 'app' ? 'topbar-menu-app' : undefined} title="StrataMD menu" onClick={() => setOpenMenu(current => current === 'app' ? null : 'app')}>
          <Logo compact />
          <span className="app-menu-chevron" aria-hidden="true">▾</span>
        </button>
        {openMenu === 'app' && <div ref={menuRoot} id="topbar-menu-app" className="tab-menu-list app-menu-list" role="menu" aria-label="StrataMD" onKeyDown={menuKeys}>
          <button type="button" role="menuitem" className="tab-menu-open open-file-button" onClick={() => menuAction(onOpenFile)}>Open file <kbd>{primaryModifierLabel()}+O</kbd></button>
          {onToggleTerminal && <button type="button" role="menuitem" className="tab-menu-open" onClick={() => menuAction(onToggleTerminal)}>Terminal <kbd>{primaryModifierLabel()}+`</kbd></button>}
          {onOpenPreview && engine && engine.state === 'connected' && <button type="button" role="menuitem" className="tab-menu-open open-preview-button" onClick={() => menuAction(onOpenPreview)}>Open preview</button>}
          {(showAccounts || onOpenUsage) && <>
            <div className="app-menu-divider" role="separator" />
            {showAccounts && <button type="button" role="menuitem" className="tab-menu-open accounts-button" onClick={() => menuAction(showAccounts)}>Usage Limits</button>}
            {onOpenUsage && <button type="button" role="menuitem" className="tab-menu-open" onClick={() => menuAction(onOpenUsage)}>Token Use</button>}
          </>}
          <div className="app-menu-divider" role="separator" />
          {engine && onOpenEngine && <button type="button" role="menuitem" className="tab-menu-open" onClick={() => menuAction(onOpenEngine)}>{engine.managed ? 'This computer' : 'Engine'}</button>}
          {onOpenSettings && <button type="button" role="menuitem" className="tab-menu-open" onClick={() => menuAction(onOpenSettings)}>Settings</button>}
          <button type="button" role="menuitem" className="tab-menu-open theme-button" onClick={() => menuAction(onOpenTheme)}>Theme</button>
          {zoomed && <button type="button" role="menuitem" className="tab-menu-open reset-zoom" onClick={() => menuAction(onResetZoom)}>Reset zoom</button>}
        </div>}
      </span>
      <div className="tab-navigation">
        <span className="tab-menu-anchor">
          <MenuPill kind="documents" label="Docs" icon={<FileTextIcon />} count={tabs.length} open={openMenu === 'documents'} onToggle={() => setOpenMenu((current) => current === 'documents' ? null : 'documents')} />
          {openMenu === 'documents' && contentMenu('documents', 'document', 'Open docs', 'No documents open.', documentItems)}
        </span>
        <span className="tab-menu-anchor">
          <MenuPill kind="conversations" label="Conversations" icon={<MessageSquareIcon />} count={conversationTabs.length} open={openMenu === 'conversations'} onToggle={() => setOpenMenu((current) => current === 'conversations' ? null : 'conversations')} />
          {openMenu === 'conversations' && contentMenu('conversations', 'conversation', 'Open conversations', 'No conversations open.', conversationItems)}
        </span>
        <span className="tab-menu-anchor">
          <MenuPill kind="previews" label="Web views" icon={<GlobeIcon />} count={previewPills.length} open={openMenu === 'previews'} onToggle={() => setOpenMenu((current) => current === 'previews' ? null : 'previews')} />
          {openMenu === 'previews' && contentMenu('previews', 'preview', 'Open web views', 'No web views open.', previewItems)}
        </span>
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
