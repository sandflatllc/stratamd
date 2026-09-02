import { useEffect, useRef } from 'react'
import { claimEscape } from '../escape'

export interface PathContextMenuState {
  x: number
  y: number
  path: string
  /** True for an explorer root folder row, which can also be removed from the list (PRD §6.4). */
  root?: boolean
}

export function PathContextMenu({ menu, onCopyPath, onRemoveFolder, onClose }: {
  menu: PathContextMenuState
  onCopyPath(path: string): void
  onRemoveFolder?(path: string): void
  onClose(): void
}) {
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
  return (
    <div ref={root} className="context-menu" role="menu" style={{ left: menu.x, top: menu.y }}>
      <button type="button" role="menuitem" onClick={() => { onCopyPath(menu.path); onClose() }}>Copy full path</button>
      {menu.root && onRemoveFolder && (
        <button type="button" role="menuitem" className="menu-danger" onClick={() => { onRemoveFolder(menu.path); onClose() }}>Remove folder</button>
      )}
    </div>
  )
}
