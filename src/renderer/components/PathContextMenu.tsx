import { useEffect, useRef } from 'react'
import { claimEscape } from '../escape'

export interface PathContextMenuState {
  x: number
  y: number
  path: string
  /** True for an explorer root folder row, which can also be removed from the list (PRD §6.4). */
  root?: boolean
  /** True for any folder row (root or subfolder): New file and Reveal apply to the folder. */
  folder?: boolean
}

export interface PathMenuActions {
  onCopyPath(path: string): void
  onRemoveFolder?(path: string): void
  /** File actions (§5.10). */
  onOpen?(path: string): void
  onRename?(path: string): void
  onTrash?(path: string): void
  onReveal?(path: string): void
  /** Folder action (§5.10): a new untitled file inside it. */
  onNewFile?(directory: string): void
  /** Tab actions (§5.16). */
  onCloseOthers?(path: string): void
  /** Pin or unpin the document's pill on the top bar (§6.9); `pinned` says which the item offers. */
  onTogglePin?(path: string): void
  pinned?: boolean
  onCloseAll?(): void
  onCloseSaved?(): void
}

/** Arrow keys, Home, and End move through the items; the menu is a menu (§5.13). */
export function menuKeyTarget(items: readonly HTMLElement[], current: number, key: string): number | null {
  if (items.length === 0) return null
  if (key === 'ArrowDown') return (current + 1) % items.length
  if (key === 'ArrowUp') return (current - 1 + items.length) % items.length
  if (key === 'Home') return 0
  if (key === 'End') return items.length - 1
  return null
}

export function PathContextMenu({ menu, onClose, ...actions }: { menu: PathContextMenuState; onClose(): void } & PathMenuActions) {
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    root.current?.querySelector('button')?.focus()
    const away = (event: Event) => { if (!root.current?.contains(event.target as Node)) onClose() }
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      claimEscape(event)
      onClose()
    }
    window.addEventListener('pointerdown', away, true)
    window.addEventListener('contextmenu', away, true)
    window.addEventListener('keydown', key)
    window.addEventListener('blur', onClose)
    return () => {
      window.removeEventListener('pointerdown', away, true)
      window.removeEventListener('contextmenu', away, true)
      window.removeEventListener('keydown', key)
      window.removeEventListener('blur', onClose)
    }
  }, [onClose])
  const item = (label: string, run: () => void, className?: string) => (
    <button type="button" role="menuitem" key={label} className={className} onClick={() => { run(); onClose() }}>{label}</button>
  )
  const name = menu.path.split('/').pop() ?? menu.path
  const isFile = !menu.folder && !menu.root
  return (
    <div
      ref={root}
      className="context-menu"
      role="menu"
      aria-label={`${name} actions`}
      style={{ left: menu.x, top: menu.y }}
      onKeyDown={(event) => {
        const items = [...(root.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])]
        const current = items.indexOf(document.activeElement as HTMLElement)
        const next = menuKeyTarget(items, current, event.key)
        if (next === null) return
        event.preventDefault()
        items[next]?.focus()
      }}
    >
      {isFile && actions.onOpen && item('Open', () => actions.onOpen!(menu.path))}
      {(menu.folder || menu.root) && actions.onNewFile && item('New file', () => actions.onNewFile!(menu.path))}
      {isFile && actions.onRename && item('Rename…', () => actions.onRename!(menu.path))}
      {actions.onReveal && item('Show in file manager', () => actions.onReveal!(menu.path))}
      {item('Copy full path', () => actions.onCopyPath(menu.path))}
      {isFile && actions.onTogglePin && item(actions.pinned ? 'Unpin from list' : 'Pin to top of list', () => actions.onTogglePin!(menu.path))}
      {isFile && actions.onCloseOthers && item('Close other tabs', () => actions.onCloseOthers!(menu.path))}
      {isFile && actions.onCloseSaved && item('Close saved tabs', () => actions.onCloseSaved!())}
      {isFile && actions.onCloseAll && item('Close all tabs', () => actions.onCloseAll!())}
      {isFile && actions.onTrash && item('Move to trash…', () => actions.onTrash!(menu.path), 'menu-danger')}
      {menu.root && actions.onRemoveFolder && item('Remove folder', () => actions.onRemoveFolder!(menu.path), 'menu-danger')}
    </div>
  )
}
