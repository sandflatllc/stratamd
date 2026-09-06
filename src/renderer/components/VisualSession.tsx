import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import type { HoldVisualCommentInput, VisualAdjustmentView, VisualCaptureView, VisualDestinationView, VisualMarkView, VisualPointView, VisualRectView, VisualStrokeView } from '../../shared/contracts'
import { nextRegionLabel } from '../../core/visual-comments'
import { claimEscape, isEscapeClaimed } from '../escape'
import { arrowHeadPath, clampRect, CLICK_MARK_SIZE, DRAG_THRESHOLD, loadImage, rectContains, rectFromPoints, renderMarkedCapture, strokeExtent, strokeHit, strokePath } from '../visualImage'

export type VisualTool = 'mark' | 'draw' | 'arrow' | 'erase'

/** What Mark found when the owner clicked or boxed something; a page answers, an image never does. */
export interface VisualProposal {
  kind: VisualMarkView['kind']
  label: string
  rect: VisualRectView
  found: boolean | null
}

export interface VisualSessionProps {
  /** The capture the session opens on; a staged image is keyed by its staged id until Hold moves it. */
  capture: VisualCaptureView
  /** An existing comment's id when editing its draft; absent when opening over a staged image. */
  commentId?: string
  source?: { staged: string; name: string }
  projectId: string
  destination: VisualDestinationView
  /** The card's context line: the page or image and the size, in plain words. */
  place: string
  initial?: { text: string; marks: VisualMarkView[]; strokes: VisualStrokeView[]; adjustments: VisualAdjustmentView[] }
  /** Asks the live page what is at a point or in a box; absent for an image, where every mark is a region. */
  describe?(target: { point: VisualPointView } | { rect: VisualRectView }): Promise<VisualProposal | null>
  /** Adjustments on the selected mark (phase 4); absent until a page backs them. */
  adjustments?: React.ReactNode
  /** A plain notice when the live page changed under the session. */
  notice?: string | null
  onHold(input: HoldVisualCommentInput): Promise<string>
  onSend(id: string): Promise<void>
  onClose(): void
  onError(message: string): void
}

const TOOLS: Array<[VisualTool, string, string]> = [['mark', 'Mark', 'M'], ['draw', 'Draw', 'D'], ['arrow', 'Arrow', 'A'], ['erase', 'Erase', 'E']]

function inTextField(target: EventTarget | null): boolean {
  return target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement || (target instanceof HTMLElement && target.isContentEditable)
}

export function VisualSession({ capture, commentId, source, projectId, destination, place, initial, describe, adjustments, notice, onHold, onSend, onClose, onError }: VisualSessionProps) {
  const [tool, setTool] = useState<VisualTool>('mark')
  const [text, setText] = useState(initial?.text ?? '')
  const [marks, setMarks] = useState<VisualMarkView[]>(initial?.marks ?? [])
  const [strokes, setStrokes] = useState<VisualStrokeView[]>(initial?.strokes ?? [])
  const [adjusted] = useState<VisualAdjustmentView[]>(initial?.adjustments ?? [])
  const [selectedMark, setSelectedMark] = useState<string | null>(null)
  const [drag, setDrag] = useState<{ from: VisualPointView; to: VisualPointView } | null>(null)
  const [live, setLive] = useState<VisualStrokeView | null>(null)
  const [busy, setBusy] = useState(false)
  const [scale, setScale] = useState(1)
  const stage = useRef<HTMLDivElement>(null)
  const surface = useRef<HTMLDivElement>(null)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const image = useRef<HTMLImageElement | null>(null)
  const pointerStart = useRef<VisualPointView | null>(null)
  const latest = useRef({ text, marks, strokes, busy })
  latest.current = { text, marks, strokes, busy }

  // The page fills the stage at Fit window: the capture scales down to the space it has and never up.
  useLayoutEffect(() => {
    const element = stage.current
    if (!element) return
    const fit = () => {
      const bounds = element.getBoundingClientRect()
      setScale(Math.min(1, (bounds.width - 32) / capture.width, (bounds.height - 32) / capture.height))
    }
    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(element)
    return () => observer.disconnect()
  }, [capture.width, capture.height])

  useEffect(() => {
    let cancelled = false
    void loadImage(capture.url).then((loaded) => { if (!cancelled) image.current = loaded }).catch(() => onError('The image could not be shown'))
    return () => { cancelled = true }
  }, [capture.url])

  const hasContent = () => latest.current.text.trim().length > 0 || latest.current.marks.length > 0 || latest.current.strokes.length > 0

  const hold = useCallback(async (): Promise<string | null> => {
    if (latest.current.busy) return null
    setBusy(true)
    try {
      const loaded = image.current ?? await loadImage(capture.url)
      const marked = await renderMarkedCapture(loaded, capture.width, capture.height, latest.current.marks, latest.current.strokes)
      const id = await onHold({
        ...(commentId ? { id: commentId } : {}),
        projectId,
        threadId: destination.threadId,
        ...(source ? { source: { staged: source.staged, name: source.name, width: capture.width, height: capture.height } } : {}),
        text: latest.current.text,
        marks: latest.current.marks,
        strokes: latest.current.strokes,
        adjustments: adjusted,
        marked: [{ captureId: capture.id, bytes: marked }],
      })
      return id
    } catch (error) {
      onError(error instanceof Error ? error.message : 'The comment could not be held')
      return null
    } finally { setBusy(false) }
  }, [adjusted, capture, commentId, destination.threadId, onError, onHold, projectId, source])

  const holdAndClose = useCallback(async () => {
    const id = await hold()
    if (id) onClose()
  }, [hold, onClose])

  const sendNow = useCallback(async () => {
    if (!latest.current.text.trim() && latest.current.marks.length === 0 && latest.current.strokes.length === 0) { onError('Mark something or write a note before sending'); return }
    const id = await hold()
    if (!id) return
    setBusy(true)
    try { await onSend(id); onClose() }
    catch (error) { onError(error instanceof Error ? error.message : 'The comment could not be sent'); onClose() }
    finally { setBusy(false) }
  }, [hold, onClose, onError, onSend])

  // Escape holds what is there and closes; the tool letters switch tools outside the note.
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (isEscapeClaimed(event)) return
        claimEscape(event)
        event.stopPropagation()
        if (hasContent()) void holdAndClose(); else onClose()
        return
      }
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); event.stopPropagation(); void sendNow(); return }
      if (event.ctrlKey || event.metaKey || event.altKey || inTextField(event.target)) return
      const next = TOOLS.find(([, , letter]) => letter.toLowerCase() === event.key.toLowerCase())
      if (next) { event.preventDefault(); setTool(next[0]) }
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [holdAndClose, onClose, sendNow])

  useEffect(() => { textarea.current?.focus({ preventScroll: true }) }, [])

  const pointFor = (event: ReactPointerEvent): VisualPointView => {
    const bounds = surface.current!.getBoundingClientRect()
    return { x: Math.max(0, Math.min(capture.width, (event.clientX - bounds.left) / scale)), y: Math.max(0, Math.min(capture.height, (event.clientY - bounds.top) / scale)) }
  }

  const propose = async (target: { point: VisualPointView } | { rect: VisualRectView }) => {
    const proposal = describe ? await describe(target).catch(() => null) : null
    const rect = proposal?.rect ?? ('rect' in target ? target.rect : clampRect({ x: target.point.x - CLICK_MARK_SIZE / 2, y: target.point.y - CLICK_MARK_SIZE / 2, width: CLICK_MARK_SIZE, height: CLICK_MARK_SIZE }, capture.width, capture.height))
    const mark: VisualMarkView = {
      id: `k_${crypto.randomUUID().slice(0, 8)}`,
      kind: proposal?.kind ?? 'region',
      label: proposal?.label ?? nextRegionLabel(latest.current.marks),
      captureId: capture.id,
      rect: clampRect(rect, capture.width, capture.height),
      found: proposal?.found ?? null,
    }
    setMarks((current) => [...current, mark])
    setSelectedMark(mark.id)
  }

  const down = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    const point = pointFor(event)
    pointerStart.current = point
    if (tool === 'erase') {
      const tolerance = 8 / scale
      const stroke = [...strokes].reverse().find((candidate) => strokeHit(candidate, point, tolerance))
      if (stroke) { setStrokes((current) => current.filter((candidate) => candidate.id !== stroke.id)); return }
      const mark = [...marks].reverse().find((candidate) => rectContains(candidate.rect, point))
      if (mark) setMarks((current) => current.filter((candidate) => candidate.id !== mark.id))
      return
    }
    if (tool === 'mark') { setDrag({ from: point, to: point }); return }
    setLive({ id: `s_${crypto.randomUUID().slice(0, 8)}`, tool: tool === 'draw' ? 'draw' : 'arrow', captureId: capture.id, points: [point] })
  }

  const move = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointerStart.current) return
    const point = pointFor(event)
    if (tool === 'mark') { setDrag((current) => current ? { ...current, to: point } : current); return }
    setLive((current) => {
      if (!current) return current
      const points = current.tool === 'draw' ? [...current.points, point] : [current.points[0]!, point]
      return { ...current, points }
    })
  }

  const up = () => {
    const start = pointerStart.current
    pointerStart.current = null
    if (tool === 'mark' && start && drag) {
      const box = rectFromPoints(drag.from, drag.to)
      setDrag(null)
      if (box.width > DRAG_THRESHOLD && box.height > DRAG_THRESHOLD) void propose({ rect: box })
      else void propose({ point: start })
      return
    }
    const stroke = live
    setLive(null)
    if (stroke && stroke.points.length > 1 && strokeExtent(stroke.points) > DRAG_THRESHOLD) setStrokes((current) => [...current, stroke])
  }

  const removeMark = (id: string) => setMarks((current) => current.filter((mark) => mark.id !== id))
  const summary = useMemo(() => {
    const arrows = strokes.filter((stroke) => stroke.tool === 'arrow').length
    const drawings = strokes.length - arrows
    return [...marks.map((mark) => ({ id: mark.id, label: mark.label, kind: mark.kind, found: mark.found, removable: true })), ...(arrows ? [{ id: 'arrows', label: arrows === 1 ? 'arrow' : `${arrows} arrows`, kind: 'stroke' as const, found: null, removable: false }] : []), ...(drawings ? [{ id: 'drawings', label: drawings === 1 ? 'drawing' : `${drawings} drawings`, kind: 'stroke' as const, found: null, removable: false }] : [])]
  }, [marks, strokes])
  const displayWidth = capture.width * scale
  const displayHeight = capture.height * scale
  const dragRect = drag ? rectFromPoints(drag.from, drag.to) : null

  return (
    <div className="visual-session" role="dialog" aria-modal="true" aria-label="Mark up the image" data-tool={tool}>
      <div className="visual-palette" role="toolbar" aria-label="Annotation tools">
        {TOOLS.map(([value, label, letter]) => <button type="button" key={value} aria-pressed={tool === value} onClick={() => setTool(value)}>{label} <kbd>{letter}</kbd></button>)}
        <span className="visual-palette-hint">Esc holds and closes</span>
      </div>
      <div className="visual-stage" ref={stage}>
        <div className="visual-surface" ref={surface} style={{ width: displayWidth, height: displayHeight }} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
          <img src={capture.url} alt="" width={displayWidth} height={displayHeight} draggable={false} />
          <svg className="visual-ink" viewBox={`0 0 ${capture.width} ${capture.height}`} width={displayWidth} height={displayHeight} aria-hidden="true">
            {[...strokes, ...(live ? [live] : [])].map((stroke) => <g key={stroke.id} className="visual-stroke" data-tool={stroke.tool}>
              <path d={strokePath(stroke)} vectorEffect="non-scaling-stroke" />
              {stroke.tool === 'arrow' && <path d={arrowHeadPath(stroke)} vectorEffect="non-scaling-stroke" />}
            </g>)}
            {marks.map((mark) => <g key={mark.id} className="visual-mark" data-kind={mark.kind} data-selected={selectedMark === mark.id || undefined} onClick={() => setSelectedMark(mark.id)}>
              <rect x={mark.rect.x} y={mark.rect.y} width={mark.rect.width} height={mark.rect.height} vectorEffect="non-scaling-stroke" />
            </g>)}
            {dragRect && <rect className="visual-drag" x={dragRect.x} y={dragRect.y} width={dragRect.width} height={dragRect.height} vectorEffect="non-scaling-stroke" />}
          </svg>
          {marks.map((mark) => <span key={mark.id} className="visual-mark-label" data-kind={mark.kind} style={{ left: mark.rect.x * scale, top: mark.rect.y * scale } as CSSProperties}>{mark.label}{mark.found && <i aria-label="found"> ✓</i>}</span>)}
        </div>
      </div>
      <form className="visual-card" data-pane="composer" onSubmit={(event) => { event.preventDefault(); void sendNow() }}>
        {notice && <p className="visual-notice" role="status">{notice}</p>}
        <textarea ref={textarea} aria-label="Visual comment" placeholder="What should change here?" value={text} disabled={busy} onChange={(event) => setText(event.target.value)} />
        {summary.length > 0 && <div className="visual-chips" aria-label="Marked things">
          {summary.map((chip) => <span key={chip.id} className="visual-chip" data-kind={chip.kind} data-selected={selectedMark === chip.id || undefined} onClick={() => chip.removable && setSelectedMark(chip.id)}>
            {chip.label}{chip.found && <b> ✓ found</b>}
            {chip.removable && <button type="button" aria-label={`Remove ${chip.label}`} onClick={(event) => { event.stopPropagation(); removeMark(chip.id) }}>×</button>}
          </span>)}
        </div>}
        {adjustments}
        <footer>
          <span className="visual-context">{place} · to <b>{destination.threadTitle}</b></span>
          <button type="button" className="quiet-button" disabled={busy} onClick={() => void holdAndClose()}>Hold</button>
          <button type="submit" className="primary-button" disabled={busy}>Send now</button>
        </footer>
      </form>
    </div>
  )
}
