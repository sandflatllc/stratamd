import { createPortal } from 'react-dom'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { EngineThreadView } from '../../shared/contracts'
import { conversationMarkers, type ConversationMarker } from '../conversationNavigation'

/** Scroll only the marker list; scrolling its ancestors can move the transcript. */
function keepMarkerVisible(button: HTMLElement | null | undefined) {
  const list = button?.parentElement
  if (!button || !list) return
  const row = button.getBoundingClientRect()
  const bounds = list.getBoundingClientRect()
  if (row.top < bounds.top) list.scrollTop += row.top - bounds.top
  else if (row.bottom > bounds.bottom) list.scrollTop += row.bottom - bounds.bottom
}

/** A quiet route back to the owner's messages and passage feedback. */
export function ConversationNavigator({ thread, onJump }: { thread: EngineThreadView; onJump(marker: ConversationMarker): void }) {
  const markers = useMemo(() => conversationMarkers(thread), [thread.messages, thread.comments])
  const root = useRef<HTMLElement>(null)
  const [active, setActive] = useState<string>()
  const [preview, setPreview] = useState<{ id: string; top: number; left: number }>()
  const tooltipId = useId()
  const shown = markers.find(marker => marker.id === preview?.id)

  useEffect(() => {
    const viewport = root.current?.parentElement?.querySelector('.conversation-messages')
    if (!viewport) return
    let frame = 0
    const update = () => {
      const top = viewport.getBoundingClientRect().top + Math.min(100, viewport.clientHeight / 4)
      let nearest: string | undefined
      let distance = Infinity
      for (const marker of markers) {
        if (marker.unavailable) continue
        const message = viewport.querySelector(`[data-message-id="${CSS.escape(marker.message)}"]`)
        if (!message) continue
        const passage = marker.comment ? Array.from(message.querySelectorAll<HTMLElement>('[data-annotation-id], [data-draft-id]')).find(element => (element.dataset.annotationId ?? element.dataset.draftId) === marker.comment) : undefined
        const next = Math.abs((passage ?? message).getBoundingClientRect().top - top)
        if (next < distance) { nearest = marker.id; distance = next }
      }
      setActive(nearest)
    }
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(update) }
    const resize = new ResizeObserver(schedule)
    resize.observe(viewport)
    const column = viewport.querySelector('.conversation-column')
    if (column) resize.observe(column)
    viewport.addEventListener('scroll', schedule, { passive: true })
    schedule()
    return () => { cancelAnimationFrame(frame); resize.disconnect(); viewport.removeEventListener('scroll', schedule) }
  }, [markers])

  useEffect(() => {
    if (!preview) keepMarkerVisible(root.current?.querySelector<HTMLElement>('[aria-current="location"]'))
  }, [active, preview])

  const reveal = (marker: ConversationMarker, button: HTMLButtonElement) => {
    const box = root.current!.getBoundingClientRect()
    setPreview({ id: marker.id, left: Math.min(box.left + 44, window.innerWidth - 336), top: Math.max(12, Math.min(button.getBoundingClientRect().top - 24, window.innerHeight - 192)) })
  }
  if (!markers.length) return null
  return <nav ref={root} className="conversation-navigator" aria-label="Conversation history" onMouseLeave={() => setPreview(undefined)} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setPreview(undefined) }} onKeyDown={event => {
    if (event.key === 'Escape') { setPreview(undefined); event.stopPropagation() }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const buttons = Array.from(root.current!.querySelectorAll<HTMLButtonElement>('.conversation-marker'))
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : Math.max(0, Math.min(buttons.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))
    event.preventDefault(); buttons[next]?.focus({ preventScroll: true }); keepMarkerVisible(buttons[next])
  }}>
    <div className="conversation-marker-list">
      {markers.map(marker => <button type="button" key={marker.id} className="conversation-marker" data-kind={marker.kind} data-marker-id={marker.id} data-held={marker.held || undefined} aria-label={`${marker.kind === 'message' ? 'Message' : 'Comment'}: ${marker.text.slice(0, 160)}`} aria-current={active === marker.id ? 'location' : undefined} aria-describedby={shown?.id === marker.id ? tooltipId : undefined} onMouseEnter={event => reveal(marker, event.currentTarget)} onFocus={event => reveal(marker, event.currentTarget)} onClick={() => { onJump(marker); setActive(marker.id); setPreview(undefined) }}><span /></button>)}
    </div>
    {shown && createPortal(<div id={tooltipId} role="tooltip" className="conversation-marker-preview" style={{ top: preview!.top, left: preview!.left }}>
      <small>{shown.kind === 'message' ? 'Your message' : shown.held ? 'Held comment' : 'Your comment'}</small>
      <p>{shown.text}</p>
      {shown.quote && <blockquote>{shown.quote}</blockquote>}
      {shown.unavailable && <small>Original passage unavailable</small>}
    </div>, document.querySelector('.app-shell') ?? document.body)}
  </nav>
}
