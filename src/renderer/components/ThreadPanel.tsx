import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import type { AgentIdentity, AnnotationView, PanelSize } from '../../shared/contracts'
import { AGENT_COLORS, THREAD_PANEL_LIMITS, USER_ANNOTATION_COLOR } from '../model'
import { InlineMarkdown } from '../inlineMarkdown'

// The one thread surface (PRD §6.9): a floating, movable, user-resizable panel
// on the theme-panel pattern, opened beside the annotated span by rail rows and
// in-editor highlight clicks alike. Only the size persists; the position is
// derived fresh each open and is never stored.

export interface SpanAnchor {
  left: number
  top: number
  right: number
  bottom: number
}

interface ThreadPanelProps {
  annotation: AnnotationView
  /** Client coordinates of the annotated span at open time; null for orphans. */
  anchor: SpanAnchor | null
  /** Where an orphan opens when the panel has not been opened this session. */
  fallbackCenter: { x: number; y: number }
  size: PanelSize
  /** The editor pane's zoom factor; body text tracks the editor's body size. */
  zoom: number
  onSize(size: PanelSize, commit: boolean): void
  onReply(text: string): void
  onResolve(): void
  onClose(): void
}

/** The panel's most recent position this session; runtime state, never persisted. */
let lastSessionPosition: { x: number; y: number } | null = null

function clampToViewport(x: number, y: number, width: number, height: number): { x: number; y: number } {
  return {
    x: Math.round(Math.max(8, Math.min(window.innerWidth - width - 8, x))),
    y: Math.round(Math.max(8, Math.min(window.innerHeight - height - 8, y))),
  }
}

function initialPosition(anchor: SpanAnchor | null, width: number, fallback: { x: number; y: number }): { x: number; y: number } {
  const estimatedHeight = 320
  if (anchor === null) {
    const start = lastSessionPosition ?? { x: fallback.x - width / 2, y: fallback.y - estimatedHeight / 2 }
    return clampToViewport(start.x, start.y, width, estimatedHeight)
  }
  // Beside the span: to the right when there is room, otherwise the left, otherwise below.
  if (anchor.right + 16 + width <= window.innerWidth - 8) {
    return clampToViewport(anchor.right + 16, anchor.top, width, estimatedHeight)
  }
  if (anchor.left - 16 - width >= 8) {
    return clampToViewport(anchor.left - 16 - width, anchor.top, width, estimatedHeight)
  }
  return clampToViewport(anchor.left, anchor.bottom + 12, width, estimatedHeight)
}

function authorName(author: 'user' | AgentIdentity): string {
  return author === 'user' ? 'you' : author.name
}

function authorColor(author: 'user' | AgentIdentity): string {
  return author === 'user' ? USER_ANNOTATION_COLOR : AGENT_COLORS[author.color]
}

export function ThreadPanel({ annotation, anchor, fallbackCenter, size, zoom, onSize, onReply, onResolve, onClose }: ThreadPanelProps) {
  const [reply, setReply] = useState('')
  const [position, setPosition] = useState(() => initialPosition(anchor, size.width, fallbackCenter))
  const root = useRef<HTMLElement>(null)

  useEffect(() => {
    lastSessionPosition = position
  }, [position])

  // Once rendered, re-clamp with the real height (the estimate opens tall threads too low).
  useLayoutEffect(() => {
    const bounds = root.current?.getBoundingClientRect()
    if (!bounds) return
    const clamped = clampToViewport(position.x, position.y, bounds.width, bounds.height)
    if (clamped.x !== position.x || clamped.y !== position.y) setPosition(clamped)
    // Only on open and resize; dragging clamps as it moves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size.width, size.height, annotation.id])

  const submit = () => {
    const clean = reply.trim()
    if (!clean) return
    onReply(clean)
    setReply('')
  }

  const startDrag = (event: React.PointerEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).closest('button, input, textarea')) return
    event.preventDefault()
    const bounds = root.current?.getBoundingClientRect()
    const height = bounds?.height ?? 320
    const width = bounds?.width ?? size.width
    const origin = { x: event.clientX, y: event.clientY, panelX: position.x, panelY: position.y }
    const move = (next: PointerEvent) => {
      setPosition(clampToViewport(origin.panelX + next.clientX - origin.x, origin.panelY + next.clientY - origin.y, width, height))
    }
    const finish = () => window.removeEventListener('pointermove', move)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', finish, { once: true })
  }

  const startResize = (event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    const bounds = root.current?.getBoundingClientRect()
    const origin = {
      x: event.clientX,
      y: event.clientY,
      width: bounds?.width ?? size.width,
      height: bounds?.height ?? 320,
    }
    let latest = size
    const move = (next: PointerEvent) => {
      latest = {
        width: Math.round(Math.max(THREAD_PANEL_LIMITS.minWidth, Math.min(THREAD_PANEL_LIMITS.maxWidth, origin.width + next.clientX - origin.x))),
        height: Math.round(Math.max(THREAD_PANEL_LIMITS.minHeight, Math.min(THREAD_PANEL_LIMITS.maxHeight, origin.height + next.clientY - origin.y))),
      }
      onSize(latest, false)
    }
    const finish = () => {
      window.removeEventListener('pointermove', move)
      onSize(latest, true)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', finish, { once: true })
  }

  const orphaned = annotation.status === 'orphaned'
  const style: CSSProperties = {
    left: position.x,
    top: position.y,
    width: size.width,
    ...(size.height >= 0 ? { height: size.height } : {}),
    '--zoom': zoom,
  } as CSSProperties
  return (
    <section ref={root} className="thread-panel" role="dialog" aria-label={`${annotation.kind} thread`} style={style}>
      <header className="thread-panel-header" onPointerDown={startDrag}>
        <span className={`annotation-chip chip-${orphaned ? 'orphaned' : annotation.kind}`} title={orphaned ? 'The text this was attached to was removed' : undefined}>
          {orphaned ? 'text removed' : annotation.kind} · {authorName(annotation.author)}
        </span>
        <button type="button" className="popover-close" aria-label="Close thread" onClick={onClose}>×</button>
      </header>
      <div className="thread-panel-scroll">
        {orphaned && (
          <blockquote className="thread-panel-quote">
            <InlineMarkdown text={annotation.quote} />
          </blockquote>
        )}
        <p><InlineMarkdown text={annotation.text} /></p>
        {annotation.replies.map((item) => (
          <div className="reply" style={{ borderColor: authorColor(item.author) }} key={item.id}>
            <strong style={{ color: authorColor(item.author) }}>{authorName(item.author)}</strong>
            <span><InlineMarkdown text={item.text} /></span>
          </div>
        ))}
      </div>
      <div className="reply-box">
        <input value={reply} onChange={(event) => setReply(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') submit() }} placeholder="Reply…" aria-label="Reply" />
        <button type="button" aria-label="Send reply" onClick={submit}>↵</button>
      </div>
      {annotation.status !== 'resolved' && <button type="button" className="resolve-button" onClick={onResolve}>✓ Resolve thread</button>}
      <button type="button" className="thread-panel-resize" aria-label="Resize thread panel" onPointerDown={startResize} />
    </section>
  )
}
