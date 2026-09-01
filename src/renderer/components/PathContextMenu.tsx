import { useEffect, useRef } from 'react'

export interface PathContextMenuState {
  x: number
  y: number
  path: string
}

export function PathContextMenu({ menu, onCopyPath, onClose }: {
  menu: PathContextMenuState
  onCopyPath(path: string): void
  onClose(): void
}) {
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    root.current?.querySelector('button')?.focus()
    const away = (event: Event) => { if (!root.current?.contains(event.target as Node)) onClose() }
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
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
    </div>
  )
}
