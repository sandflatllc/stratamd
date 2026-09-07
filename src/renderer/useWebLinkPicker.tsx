import { useLayoutEffect, useRef, useState } from 'react'
import strataIcon from '../../resources/stratamd-icon.svg?url'
import { ExternalLinkIcon } from './icons/lucide'
import { claimEscape } from './escape'
import { classifyLocalLink } from '../shared/local-link'

type Destination = 'strata' | 'external'
interface LinkRequest {
  url: string
  projectId: string | null
  origin: HTMLElement | null
  x: number
  y: number
  keyboard: boolean
  /** Where the link sat when the picker opened; a scroll that leaves it there keeps the picker. */
  anchor: { left: number; top: number } | null
  /** A .html page or Markdown file on this computer rather than a web address. */
  local: 'html' | 'markdown' | null
}
interface Options {
  scope: string | null
  projectFor(origin: Element | null): string | null
  openInternal(url: string, projectId: string): Promise<void>
  onError(message: string): void
}

/** One picker and one session choice for all links in the shell, including editor DOM. */
export function useWebLinkPicker(options: Options) {
  const [request, setRequest] = useState<LinkRequest | null>(null)
  const last = useRef<Destination | null>(null)
  const busy = useRef(false)
  const panel = useRef<HTMLDivElement>(null)
  const latest = useRef({ options, request })
  useLayoutEffect(() => { latest.current = { options, request } })
  useLayoutEffect(() => { setRequest(null) }, [options.scope])

  const close = (restoreFocus = false) => {
    const origin = latest.current.request?.origin
    setRequest(null)
    if (restoreFocus && origin?.isConnected) origin.focus({ preventScroll: true })
  }
  const open = async (link: LinkRequest, destination: Destination) => {
    if (busy.current) return
    if (destination === 'strata' && !link.projectId && link.local !== 'markdown') { setRequest(link); return }
    busy.current = true
    const current = latest.current.options
    close()
    try {
      // Main resolves a local link against the project folder and checks the
      // file before anything opens it. A Markdown file becomes a document tab
      // and takes no picker; a page offers the same two destinations as a web link.
      const url = link.local ? (await window.strata.resolveLocalLink({ projectId: link.projectId, href: link.url })).url : link.url
      if (link.local === 'markdown') {
        await window.strata.openDocument(fileURLPath(url))
        return
      }
      if (destination === 'strata') await current.openInternal(url, link.projectId!)
      else {
        if (!window.strata.openExternal) throw new Error('The default browser is unavailable.')
        await window.strata.openExternal(url)
      }
      last.current = destination
    } catch (error) {
      current.onError(`Could not open ${link.url}: ${String(error)}`)
    } finally { busy.current = false }
  }
  const activate = (url: string, event: MouseEvent, projectId?: string | null) => {
    const local = classifyLocalLink(url)
    if (!local) {
      if (!/^https?:\/\//i.test(url)) return
      try { new URL(url) } catch { return }
    }
    // A document's own editor previews a Markdown reference beside the link
    // and offers Open document (PRD §6.1); that stays with the editor. A
    // conversation message mounts the same editor, but its links open directly.
    if (local?.kind === 'markdown' && event.target instanceof Element && event.target.closest('[data-document-path]') && !event.target.closest('.conversation-panel, .conversation-discussion')) return
    // The window itself never follows a link: a relative path would replace
    // the whole app with a missing app:// page.
    event.preventDefault()
    event.stopPropagation()
    if (event.detail > 2 || busy.current) return
    if (local?.kind === 'other') {
      if (event.detail === 1) latest.current.options.onError(`Only web links, .html pages, and Markdown files open from here: ${url}`)
      return
    }
    const origin = event.target instanceof Element ? event.target.closest<HTMLElement>('a[href]') ?? (event.target instanceof HTMLElement ? event.target : null) : null
    const keyboard = event.detail === 0
    const rect = origin?.getBoundingClientRect()
    const link: LinkRequest = {
      url, origin, keyboard,
      anchor: rect ? { left: rect.left, top: rect.top } : null,
      local: local?.kind ?? null,
      projectId: projectId === undefined ? latest.current.options.projectFor(origin) : projectId,
      x: keyboard && rect ? rect.left : event.clientX,
      y: keyboard && rect ? rect.bottom : event.clientY,
    }
    if (link.local === 'markdown') { if (event.detail === 1) void open(link, 'strata'); return }
    if (event.detail === 2 && last.current) void open(link, last.current)
    else setRequest(link)
  }
  const activateRef = useRef(activate)
  useLayoutEffect(() => { activateRef.current = activate })

  useLayoutEffect(() => {
    const click = (event: MouseEvent) => {
      if (event.button !== 0) return
      const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null
      if (anchor) activateRef.current(anchor.getAttribute('href') ?? '', event)
    }
    const away = (event: PointerEvent) => {
      if (event.target instanceof Node && !panel.current?.contains(event.target) && !latest.current.request?.origin?.contains(event.target)) close()
    }
    const key = (event: KeyboardEvent) => {
      if (!latest.current.request) return
      if (event.key === 'Escape') { claimEscape(event); event.stopPropagation(); close(true); return }
      // Editing shortcuts belong to the editor. Do not leave this picker
      // behind a newly opened form, where it would consume that form's Escape.
      if (event.ctrlKey || event.metaKey || event.altKey) { close(); return }
      const buttons = Array.from(panel.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
      if (['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Tab'].includes(event.key)) {
        event.preventDefault()
        event.stopPropagation()
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
        const backwards = event.key === 'ArrowLeft' || event.shiftKey
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : index < 0 ? (backwards ? buttons.length - 1 : 0) : index + (backwards ? -1 : 1)
        buttons[(next + buttons.length) % buttons.length]?.focus()
      } else if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Shift') {
        close()
      }
    }
    const dismiss = () => close()
    // A transcript pinned to its end re-scrolls whenever an earlier message
    // finishes mounting, without moving what is on screen. Only a scroll that
    // moves the link away from the picker closes it.
    const scrolled = () => {
      const request = latest.current.request
      if (!request) return
      const rect = request.origin?.isConnected ? request.origin.getBoundingClientRect() : null
      if (rect && request.anchor && Math.abs(rect.left - request.anchor.left) < 1 && Math.abs(rect.top - request.anchor.top) < 1) return
      close()
    }
    document.addEventListener('click', click, true)
    document.addEventListener('pointerdown', away, true)
    window.addEventListener('keydown', key, true)
    document.addEventListener('scroll', scrolled, true)
    window.addEventListener('resize', dismiss)
    window.addEventListener('blur', dismiss)
    return () => {
      document.removeEventListener('click', click, true)
      document.removeEventListener('pointerdown', away, true)
      window.removeEventListener('keydown', key, true)
      document.removeEventListener('scroll', scrolled, true)
      window.removeEventListener('resize', dismiss)
      window.removeEventListener('blur', dismiss)
    }
  }, [])

  useLayoutEffect(() => {
    if (!request || !panel.current) return
    const { width, height } = panel.current.getBoundingClientRect()
    const anchor = request.origin instanceof HTMLAnchorElement ? request.origin.getBoundingClientRect() : null
    const beside = anchor && anchor.right + width + 16 < window.innerWidth
    const x = beside ? anchor.right + 8 : request.x
    const y = beside ? anchor.top - 8 : anchor ? anchor.top - height - 8 : request.y + 12
    panel.current.style.left = `${Math.max(8, Math.min(x, window.innerWidth - width - 8))}px`
    panel.current.style.top = `${Math.max(8, Math.min(y, window.innerHeight - height - 8))}px`
    if (request.keyboard) (panel.current.querySelector<HTMLButtonElement>('button[data-last="true"]:not(:disabled)') ?? panel.current.querySelector<HTMLButtonElement>('button:not(:disabled)'))?.focus({ preventScroll: true })
  }, [request])

  const picker = request && <div ref={panel} className="web-link-picker" role="dialog" aria-label="Open web link" onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') event.stopPropagation() }}>
    <button type="button" aria-label="Open in Strata" title={request.projectId ? 'Open in Strata' : 'Add a project to open links in Strata'} disabled={!request.projectId} data-last={last.current === 'strata'} onClick={() => void open(request, 'strata')}><img src={strataIcon} alt="" /></button>
    <span className="web-link-divider" aria-hidden="true" />
    <button type="button" aria-label="Open in default browser" title="Open in default browser" data-last={last.current === 'external'} onClick={() => void open(request, 'external')}><ExternalLinkIcon size={22} /></button>
  </div>
  return { picker, activate }
}

/** The path inside a `file:` URL main returned, without its query or fragment. */
function fileURLPath(url: string): string {
  const parsed = new URL(url)
  return decodeURIComponent(parsed.pathname)
}
