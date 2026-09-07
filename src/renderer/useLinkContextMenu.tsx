import { useLayoutEffect, useRef, useState } from 'react'
import { linkCopyTarget, type LinkCopyTarget } from '../core/link-target'
import { menuKeyTarget } from './components/PathContextMenu'
import { claimEscape } from './escape'

interface MenuState { x: number; y: number; target: LinkCopyTarget; origin: HTMLElement }
interface Options {
  /** The document a link belongs to when its editor host carries no `data-document-path`. */
  documentFor(origin: Element): string
  onCopy(text: string, notice: string): void
}

/**
 * One right-click menu for every link in the shell, including editor DOM
 * (PRD §6.9). It runs in the capture phase so the editor's annotate menu,
 * which also listens for right-click, stays closed over a link. The menu sits
 * at the pointer, not on the link, so scrolling underneath it does not close
 * it: the transcript adjusts its own scroll as message editors mount, and a
 * menu that closed on that would vanish between the right-click and the choice.
 */
export function useLinkContextMenu(options: Options) {
  const [menu, setMenu] = useState<MenuState | null>(null)
  const panel = useRef<HTMLDivElement>(null)
  const latest = useRef({ options, menu })
  useLayoutEffect(() => { latest.current = { options, menu } })
  const close = (restoreFocus = false) => {
    const origin = latest.current.menu?.origin
    setMenu(null)
    if (restoreFocus && origin?.isConnected) origin.focus({ preventScroll: true })
  }

  useLayoutEffect(() => {
    const contextmenu = (event: MouseEvent) => {
      const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null
      if (!anchor) { if (latest.current.menu) close(); return }
      const host = anchor.closest<HTMLElement>('[data-document-path]')
      const documentPath = host?.dataset.documentPath || latest.current.options.documentFor(anchor)
      const target = linkCopyTarget(anchor.getAttribute('href') ?? '', documentPath)
      if (!target) return
      event.preventDefault()
      event.stopPropagation()
      setMenu({ x: event.clientX, y: event.clientY, target, origin: anchor })
    }
    const away = (event: PointerEvent) => { if (latest.current.menu && event.target instanceof Node && !panel.current?.contains(event.target)) close() }
    const key = (event: KeyboardEvent) => {
      if (!latest.current.menu || event.key !== 'Escape') return
      claimEscape(event)
      event.stopPropagation()
      close(true)
    }
    const dismiss = () => { if (latest.current.menu) close() }
    document.addEventListener('contextmenu', contextmenu, true)
    document.addEventListener('pointerdown', away, true)
    window.addEventListener('keydown', key, true)
    window.addEventListener('resize', dismiss)
    window.addEventListener('blur', dismiss)
    return () => {
      document.removeEventListener('contextmenu', contextmenu, true)
      document.removeEventListener('pointerdown', away, true)
      window.removeEventListener('keydown', key, true)
      window.removeEventListener('resize', dismiss)
      window.removeEventListener('blur', dismiss)
    }
  }, [])

  useLayoutEffect(() => {
    if (!menu || !panel.current) return
    const { width, height } = panel.current.getBoundingClientRect()
    panel.current.style.left = `${Math.max(8, Math.min(menu.x, window.innerWidth - width - 8))}px`
    panel.current.style.top = `${Math.max(8, Math.min(menu.y, window.innerHeight - height - 8))}px`
    panel.current.querySelector('button')?.focus({ preventScroll: true })
  }, [menu])

  const item = (label: string, text: string, notice: string) => (
    <button type="button" role="menuitem" key={label} onClick={() => { latest.current.options.onCopy(text, notice); close(true) }}>{label}</button>
  )
  const items = (target: LinkCopyTarget) => {
    if (target.kind === 'web') return [item('Copy link address', target.address, 'Link address copied.')]
    if (target.kind === 'other') return [item('Copy link address', target.address, 'Link address copied.')]
    const out = []
    if (target.path) out.push(item('Copy full path', target.path, 'Path copied.'))
    if (target.path !== target.written) out.push(item('Copy link as written', target.written, 'Link copied.'))
    return out
  }
  const node = menu && <div
    ref={panel}
    className="context-menu link-context-menu"
    role="menu"
    aria-label="Link actions"
    onKeyDown={(event) => {
      const buttons = [...(panel.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])]
      const next = menuKeyTarget(buttons, buttons.indexOf(document.activeElement as HTMLElement), event.key)
      if (next === null) return
      event.preventDefault()
      buttons[next]?.focus()
    }}
  >{items(menu.target)}</div>
  return { menu: node }
}
