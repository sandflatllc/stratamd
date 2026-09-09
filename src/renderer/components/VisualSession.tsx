import { holdConversationContext } from '../focusConversationComposer'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction, type MutableRefObject, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import type { HoldVisualCommentInput, VisualAdjustmentView, VisualCaptureView, VisualDestinationView, VisualMarkView, VisualPointView, VisualRectView, VisualStrokeView } from '../../shared/contracts'
import { nextRegionLabel } from '../../core/visual-comments'
import { VisualAdjustments } from './VisualAdjustments'
import { claimEscape, isEscapeClaimed } from '../escape'
import { arrowHeadPath, clampRect, CLICK_MARK_SIZE, DRAG_THRESHOLD, loadImage, rectContains, rectFromPoints, renderMarkedCapture, strokeExtent, strokeHit, strokePath } from '../visualImage'

export type VisualTool = 'mark' | 'draw' | 'arrow' | 'erase'

/** What Mark found when the owner clicked or boxed something; a page answers, an image never does. */
export interface VisualProposal {
  kind: VisualMarkView['kind']
  label: string
  rect: VisualRectView
  found: boolean | null
  identity?: VisualMarkView['identity']
}

export interface VisualSessionData {
  text: string
  marks: VisualMarkView[]
  strokes: VisualStrokeView[]
  adjusted: VisualAdjustmentView[]
  history: VisualAdjustmentView[][]
  requested: VisualCaptureView | null
  requestedFor: string | null
  selectedMark: string | null
  tool: VisualTool
  commentId: string | null
}
export function newVisualSession(initial?: VisualSessionProps['initial']): VisualSessionData {
  return { text: initial?.text ?? '', marks: initial?.marks ?? [], strokes: initial?.strokes ?? [], adjusted: initial?.adjustments ?? [], history: [], requested: initial?.requested ?? null, requestedFor: null, selectedMark: null, tool: 'mark', commentId: null }
}

export interface VisualSessionProps {
  sessionId?: string
  session?: VisualSessionData
  setSession?: Dispatch<SetStateAction<VisualSessionData>>
  closeRequest?: MutableRefObject<(() => Promise<void>) | null>

  /** The capture the session opens on; a staged image is keyed by its staged id until Hold moves it. */
  capture: VisualCaptureView
  /** Every capture the session holds when a page was captured at more than one scroll position; the last one is shown. */
  captures?: VisualCaptureView[]
  /** The page a session over a live page was opened on; rides with Hold so the record knows where the frames came from. */
  page?: NonNullable<HoldVisualCommentInput['page']>
  /** Scrolling over a page session scrolls the live page and takes another capture. */
  onScroll?: ((delta: VisualPointView) => Promise<void>) | undefined
  /** An existing comment's id when editing its draft; absent when opening over a staged image. */
  commentId?: string
  source?: { staged: string; name: string; windowCapture?: import('../../shared/window-capture').WindowCaptureContext }
  projectId: string
  destination: VisualDestinationView
  /** The card's context line: the page or image and the size, in plain words. */
  windowCapture?: import('../../shared/window-capture').WindowCaptureContext
  place: string
  initial?: { text: string; marks: VisualMarkView[]; strokes: VisualStrokeView[]; adjustments: VisualAdjustmentView[]; requested?: VisualCaptureView | undefined }
  /** Asks the live page what is at a point or in a box; absent for an image, where every mark is a region. */
  describe?: ((target: { point: VisualPointView } | { rect: VisualRectView }) => Promise<VisualProposal | null>) | undefined
  /**
   * Adjustments on the selected mark (phase 4): applies the whole set to the live page and returns the re-captured
   * frame, the requested appearance, or null once nothing is adjusted. Absent when no live page backs the session.
   */
  onAdjust?: ((adjustments: VisualAdjustmentView[], marks: VisualMarkView[]) => Promise<VisualCaptureView | null>) | undefined
  /** Whether the live page shows the adjustments right now, in plain words. */
  adjustStatus?: string | undefined
  /** A plain notice when the live page changed under the session. */
  notice?: string | null
  /** Question markup returns to its private answer draft, without a composer Send shortcut. */
  returnToComposer?: boolean
  onHold(input: HoldVisualCommentInput): Promise<string>
  /** Removes the original photo from its conversation draft when attachment is cancelled. */
  onCancelAttachment?(): Promise<void>
  onClose(): void
  onError(message: string): void
}

const TOOLS: Array<[VisualTool, string, string]> = [['mark', 'Mark', 'M'], ['draw', 'Draw', 'D'], ['arrow', 'Arrow', 'A'], ['erase', 'Erase', 'E']]

function inTextField(target: EventTarget | null): boolean {
  return target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement || (target instanceof HTMLElement && target.isContentEditable)
}

export function VisualSession({ sessionId, session: controlled, setSession: setControlled, closeRequest, capture: opened, captures: all, commentId, source, page, onScroll, projectId, destination, windowCapture, place, initial, describe, onAdjust, adjustStatus, notice, returnToComposer = true, onHold, onCancelAttachment, onClose, onError }: VisualSessionProps) {
  const captures = all && all.length ? all : [opened]
  const capture = captures[captures.length - 1]!
  const [local, setLocal] = useState(() => { const data = newVisualSession(initial); if (data.requested) data.requestedFor = JSON.stringify([data.adjusted, data.marks, data.strokes, captures.map(frame => frame.id)]); return data })
  const session = controlled ?? local
  const setSession = setControlled ?? setLocal
  const field = <K extends keyof VisualSessionData,>(key: K): [VisualSessionData[K], Dispatch<SetStateAction<VisualSessionData[K]>>] => [session[key], next => setSession(current => ({ ...current, [key]: typeof next === 'function' ? (next as (value: VisualSessionData[K]) => VisualSessionData[K])(current[key]) : next }))]
  const [tool, setTool] = field('tool')
  const [text, setText] = field('text')
  const [marks, setMarks] = field('marks')
  const [strokes, setStrokes] = field('strokes')
  const [adjusted, setAdjusted] = field('adjusted')
  const [history, setHistory] = field('history')
  const [requested, setRequested] = field('requested')
  const [selectedMark, setSelectedMark] = field('selectedMark')
  const [adjusting, setAdjusting] = useState(false)
  const ending = useRef(false)
  const owner = useRef(sessionId ?? `visual-session-${crypto.randomUUID()}`)
  const adjustmentJob = useRef<Promise<void> | null>(null)
  const holding = useRef(false)
  const liveApplied = useRef(false)
  const signature = (data: VisualSessionData) => JSON.stringify([data.adjusted, data.marks, data.strokes, captures.map(frame => frame.id)])
  const [drag, setDrag] = useState<{ from: VisualPointView; to: VisualPointView } | null>(null)
  const [live, setLive] = useState<VisualStrokeView | null>(null)
  const [busy, setBusy] = useState(false)
  const [scale, setScale] = useState(1)
  const stage = useRef<HTMLDivElement>(null)
  const surface = useRef<HTMLDivElement>(null)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const image = useRef<HTMLImageElement | null>(null)
  const pointerStart = useRef<VisualPointView | null>(null)
  /** The drag in progress, kept beside the state so pointer up reads it even when no render has happened since pointer down. */
  const dragRef = useRef<{ from: VisualPointView; to: VisualPointView } | null>(null)
  const wheel = useRef<{ x: number; y: number; timer: number }>({ x: 0, y: 0, timer: 0 })
  const [scrolling, setScrolling] = useState(false)
  const latest = useRef({ ...session, busy, captures, capture, page, destination })
  useLayoutEffect(() => { latest.current = { ...session, busy, captures, capture, page, destination } })
  const ownedIds = [...new Set([...captures.map(frame => frame.id), ...(requested ? [requested.id] : [])])].filter(id => id.startsWith('e_')).join(',')
  useEffect(() => {
    if (ending.current) return
    const ids = ownedIds ? ownedIds.split(',') : []
    void window.strata.retainVisualEvidence?.(owner.current, ids).catch(error => onError(String(error)))
  }, [ownedIds])
  const finishSession = async () => {
    if (ending.current) return
    ending.current = true
    const data = latest.current
    const ids = [...data.captures.map(frame => frame.id), ...(data.requested ? [data.requested.id] : [])].filter(id => id.startsWith('e_'))
    try { await window.strata.retainVisualEvidence?.(owner.current, ids); await window.strata.retainVisualEvidence?.(owner.current, []); onClose() }
    catch (error) { ending.current = false; onError(String(error)) }
  }


  // The page fills the stage at Fit window: the capture scales down to the space it has and never up.
  useLayoutEffect(() => {
    const element = stage.current
    if (!element) return
    const fit = () => {
      // The room is the stage's content box: the padding keeps the palette and the card off the picture.
      const style = window.getComputedStyle(element)
      const width = element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
      const height = element.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)
      setScale(Math.max(0.05, Math.min(1, width / capture.width, height / capture.height)))
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

  // Scrolling over a page: the live page scrolls by the same amount once the wheel rests, and a new frame joins the session.
  useEffect(() => () => { if (wheel.current.timer) window.clearTimeout(wheel.current.timer) }, [])
  const onWheel = onScroll ? (event: React.WheelEvent) => {
    if (scrolling) return
    wheel.current.x += event.deltaX
    wheel.current.y += event.deltaY
    if (wheel.current.timer) window.clearTimeout(wheel.current.timer)
    wheel.current.timer = window.setTimeout(() => {
      const delta = { x: Math.round(wheel.current.x), y: Math.round(wheel.current.y) }
      wheel.current = { x: 0, y: 0, timer: 0 }
      if (delta.x === 0 && delta.y === 0) return
      setScrolling(true)
      void onScroll(delta).catch((error: unknown) => onError(error instanceof Error ? error.message : 'The page could not be scrolled')).finally(() => setScrolling(false))
    }, 120)
  } : undefined

  const hasContent = () => latest.current.text.trim().length > 0 || latest.current.marks.length > 0 || latest.current.strokes.length > 0

  const hold = useCallback(async (): Promise<string | null> => {
    if (holding.current) return null
    holding.current = true
    if (adjustmentJob.current) await adjustmentJob.current
    setBusy(true)
    try {
      let data = latest.current
      if (data.adjusted.length && (!data.requested || data.requestedFor !== signature(data))) {
        if (!onAdjust) throw new Error('The requested image is out of date. Reopen the matching page to refresh it before sending.')
        const frame = await onAdjust(data.adjusted, data.marks)
        if (!frame) throw new Error('The requested appearance could not be captured. Your note is kept.')
        data = { ...data, requested: frame, requestedFor: signature(data) }
        latest.current = data
        setSession(current => ({ ...current, requested: frame, requestedFor: signature(data) }))
      }
      // Every capture with something drawn on it gets its marked version; the rest travel clean or not at all.
      const marked: Array<{ captureId: string; bytes: Uint8Array }> = []
      for (const frame of data.captures) {
        const marksHere = data.marks.filter((mark) => mark.captureId === frame.id)
        const strokesHere = data.strokes.filter((stroke) => stroke.captureId === frame.id)
        if (marksHere.length === 0 && strokesHere.length === 0 && frame.id !== capture.id) continue
        const loaded = await loadImage(frame.url)
        marked.push({ captureId: frame.id, bytes: await renderMarkedCapture(loaded, frame.width, frame.height, marksHere, strokesHere) })
      }
      const id = await onHold({
        ...((data.commentId ?? commentId) ? { id: (data.commentId ?? commentId)! } : {}),
        projectId,
        threadId: data.destination.threadId,
        ...(source && !data.commentId && !commentId ? { source: { staged: source.staged, name: source.name, ...(source.windowCapture ? { windowCapture: source.windowCapture } : {}), width: capture.width, height: capture.height } } : {}),
        ...(data.page ? { page: { ...data.page, captures: [...data.page.captures, ...(data.requested && data.adjusted.length ? [{ id: data.requested.id, width: data.requested.width, height: data.requested.height, scroll: data.requested.scroll ?? { x: 0, y: 0 }, scale: data.requested.scale ?? 1, requested: true }] : [])] } } : {}),
        text: data.text,
        marks: data.marks,
        strokes: data.strokes,
        adjustments: data.adjusted,
        marked,
      })
      setSession(current => ({ ...current, commentId: id }))
      return id
    } catch (error) {
      onError(error instanceof Error ? error.message : 'The comment could not be held')
      return null
    } finally { holding.current = false; setBusy(false) }
  }, [adjusted, capture, captures, commentId, destination.threadId, onError, onHold, page, projectId, requested, source])

  // Each adjustment step goes to the live page and comes back as a fresh frame; Undo and Reset walk the same path.
  const applyAdjustments = async (next: VisualAdjustmentView[], remember = true) => {
    if (!onAdjust || adjustmentJob.current) return
    setAdjusting(true)
    const job = (async () => {
      try {
        const frame = await onAdjust(next, latest.current.marks)
        const data = { ...latest.current, adjusted: next, requested: next.length ? frame : null }
        data.requestedFor = signature(data)
        latest.current = data
        setSession(current => ({ ...current, adjusted: next, requested: next.length ? frame : null, requestedFor: data.requestedFor, history: remember ? [...current.history, current.adjusted] : current.history }))
        liveApplied.current = true
      } catch (error) { onError(error instanceof Error ? error.message : 'The adjustment could not be shown') }
      finally { setAdjusting(false); adjustmentJob.current = null }
    })()
    adjustmentJob.current = job
    await job
  }
  useEffect(() => {
    if (onAdjust && latest.current.adjusted.length && !liveApplied.current) void applyAdjustments(latest.current.adjusted, false)
  }, [])
  const undoAdjustment = async () => {
    const previous = history.at(-1)
    if (!previous) return
    setHistory((current) => current.slice(0, -1))
    await applyAdjustments(previous, false)
  }
  const resetAdjustments = async () => { setHistory([]); await applyAdjustments([], false) }

  const holdAndClose = useCallback(async () => {
    const action = async () => {
      if (!hasContent()) { await finishSession(); return }
      const id = await hold()
      if (!id) return false
      await finishSession()
    }
    if (returnToComposer) await holdConversationContext(action)
    else await action()
  }, [hold, onClose, returnToComposer])

  const cancel = async () => {
    if (holding.current || latest.current.busy || ending.current) return
    holding.current = true
    setBusy(true)
    try {
      if (adjustmentJob.current) await adjustmentJob.current
      const id = latest.current.commentId ?? commentId
      if (id) await window.strata.actVisualComment(id, 'discard')
      else if (onCancelAttachment) await onCancelAttachment()
      await finishSession()
    } catch (error) { onError(error instanceof Error ? error.message : 'Could not cancel the attachment') }
    finally { holding.current = false; setBusy(false) }
  }

  const actions = useRef({ holdAndClose, finishSession })
  useLayoutEffect(() => { actions.current = { holdAndClose, finishSession }; if (closeRequest) closeRequest.current = holdAndClose; return () => { if (closeRequest?.current === holdAndClose) closeRequest.current = null } })

  // Escape holds what is there and closes; the tool letters switch tools outside the note.
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (isEscapeClaimed(event)) return
        claimEscape(event)
        event.stopPropagation()
        if (hasContent()) void actions.current.holdAndClose(); else void actions.current.finishSession()
        return
      }
      if (event.key === 'Enter' && (holding.current || ending.current)) return
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && (inTextField(event.target) || event.ctrlKey || event.metaKey)) { event.preventDefault(); event.stopPropagation(); void actions.current.holdAndClose(); return }
      if (event.ctrlKey || event.metaKey || event.altKey || inTextField(event.target)) return
      const next = TOOLS.find(([, , letter]) => letter.toLowerCase() === event.key.toLowerCase())
      if (next) { event.preventDefault(); setTool(next[0]) }
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [])

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
      label: proposal && proposal.kind === 'element' ? proposal.label : nextRegionLabel(latest.current.marks),
      captureId: capture.id,
      rect: clampRect(rect, capture.width, capture.height),
      found: proposal?.found ?? null,
      ...(proposal?.identity ? { identity: proposal.identity } : {}),
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
    if (tool === 'mark') { dragRef.current = { from: point, to: point }; setDrag(dragRef.current); return }
    setLive({ id: `s_${crypto.randomUUID().slice(0, 8)}`, tool: tool === 'draw' ? 'draw' : 'arrow', captureId: capture.id, points: [point] })
  }

  const move = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointerStart.current) return
    const point = pointFor(event)
    if (tool === 'mark') { if (dragRef.current) dragRef.current = { ...dragRef.current, to: point }; setDrag(dragRef.current); return }
    setLive((current) => {
      if (!current) return current
      const points = current.tool === 'draw' ? [...current.points, point] : [current.points[0]!, point]
      return { ...current, points }
    })
  }

  const up = () => {
    const start = pointerStart.current
    pointerStart.current = null
    const dragging = dragRef.current
    if (tool === 'mark' && start && dragging) {
      const box = rectFromPoints(dragging.from, dragging.to)
      dragRef.current = null
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
    return [...marks.map((mark) => ({ id: mark.id, label: mark.label, kind: mark.kind, found: mark.found, removable: true, elsewhere: mark.captureId !== capture.id })), ...(arrows ? [{ id: 'arrows', label: arrows === 1 ? 'arrow' : `${arrows} arrows`, kind: 'stroke' as const, found: null, removable: false, elsewhere: false }] : []), ...(drawings ? [{ id: 'drawings', label: drawings === 1 ? 'drawing' : `${drawings} drawings`, kind: 'stroke' as const, found: null, removable: false, elsewhere: false }] : [])]
  }, [marks, strokes, capture.id])
  const shownMarks = marks.filter((mark) => mark.captureId === capture.id)
  const shownStrokes = strokes.filter((stroke) => stroke.captureId === capture.id)
  const displayWidth = capture.width * scale
  const displayHeight = capture.height * scale
  const dragRect = drag ? rectFromPoints(drag.from, drag.to) : null

  return (
    <div className="visual-session" role="dialog" aria-modal="true" aria-label={page ? 'Mark up the page' : 'Mark up the image'} data-tool={tool} data-page={page ? '' : undefined} data-captures={captures.length}>
      <div className="visual-palette" role="toolbar" aria-label="Annotation tools">
        {TOOLS.map(([value, label, letter]) => <button type="button" key={value} aria-pressed={tool === value} onClick={() => setTool(value)}>{label} <kbd>{letter}</kbd></button>)}
        <span className="visual-palette-hint">Esc holds and closes</span>
      </div>
      <div className="visual-stage" ref={stage} onWheel={onWheel} data-scrolling={scrolling || undefined}>
        <div className="visual-surface" ref={surface} style={{ width: displayWidth, height: displayHeight }} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
          <img src={requested && session.requestedFor === signature(session) && adjusted.length && requested.width === capture.width && requested.height === capture.height ? requested.url : capture.url} alt="" width={displayWidth} height={displayHeight} draggable={false} data-requested={requested && session.requestedFor === signature(session) && adjusted.length ? '' : undefined} />
          <svg className="visual-ink" viewBox={`0 0 ${capture.width} ${capture.height}`} width={displayWidth} height={displayHeight} aria-hidden="true">
            {[...shownStrokes, ...(live ? [live] : [])].map((stroke) => <g key={stroke.id} className="visual-stroke" data-tool={stroke.tool}>
              <path d={strokePath(stroke)} vectorEffect="non-scaling-stroke" />
              {stroke.tool === 'arrow' && <path d={arrowHeadPath(stroke)} vectorEffect="non-scaling-stroke" />}
            </g>)}
            {shownMarks.map((mark) => <g key={mark.id} className="visual-mark" data-kind={mark.kind} data-selected={selectedMark === mark.id || undefined} onClick={() => setSelectedMark(mark.id)}>
              <rect x={mark.rect.x} y={mark.rect.y} width={mark.rect.width} height={mark.rect.height} vectorEffect="non-scaling-stroke" />
            </g>)}
            {dragRect && <rect className="visual-drag" x={dragRect.x} y={dragRect.y} width={dragRect.width} height={dragRect.height} vectorEffect="non-scaling-stroke" />}
          </svg>
          {shownMarks.map((mark) => <span key={mark.id} className="visual-mark-label" data-kind={mark.kind} style={{ left: mark.rect.x * scale, top: mark.rect.y * scale } as CSSProperties}>{mark.label}{mark.found && <i aria-label="found"> ✓</i>}</span>)}
        </div>
      </div>
      <form className="visual-card" data-pane="composer" onSubmit={(event) => { event.preventDefault(); void holdAndClose() }}>
        {(source?.windowCapture ?? windowCapture) && <header><h3>{source?.name ?? (windowCapture?.app ? `${windowCapture.title} · ${windowCapture.app}` : windowCapture?.title)}</h3><p>{place}</p></header>}
        {notice && <p className="visual-notice" role="status">{notice}</p>}
        <textarea ref={textarea} aria-label="Visual comment" placeholder="What should change here?" value={text} disabled={busy} onChange={(event) => setText(event.target.value)} />
        {summary.length > 0 && <div className="visual-chips" aria-label="Marked things">
          {summary.map((chip) => <span key={chip.id} className="visual-chip" data-kind={chip.kind} data-selected={selectedMark === chip.id || undefined} data-elsewhere={chip.elsewhere || undefined} title={chip.elsewhere ? 'Marked at another scroll position' : undefined} >
            {chip.removable ? <button type="button" aria-label={`Select ${chip.label}`} aria-pressed={selectedMark === chip.id} onClick={() => setSelectedMark(chip.id)}>{chip.label}{chip.found && <b> ✓ found</b>}</button> : chip.label}
            {chip.removable && <button type="button" aria-label={`Remove ${chip.label}`} onClick={(event) => { event.stopPropagation(); removeMark(chip.id) }}>×</button>}
          </span>)}
        </div>}
        {onAdjust && (() => { const mark = marks.find((candidate) => candidate.id === selectedMark && candidate.kind === 'element' && candidate.identity); return mark ? <VisualAdjustments mark={mark} adjustments={adjusted} status={liveApplied.current ? adjustStatus ?? 'shown live' : 'not shown yet'} busy={busy || adjusting} canUndo={history.length > 0} onChange={(next) => void applyAdjustments(next)} onUndo={() => void undoAdjustment()} onReset={() => void resetAdjustments()} /> : null })()}
        {!onAdjust && adjusted.length > 0 && <p className="visual-adjustment-summary">{adjusted.map((adjustment) => adjustment.label).join(' · ')}</p>}
        <footer>
          <span className="visual-context" title={`${place} · ${destination.threadTitle}`}>{source?.windowCapture || windowCapture ? `Hold for ${destination.threadTitle}` : 'Send to this conversation'}</span>
          <button type="button" className="quiet-button" disabled={busy} onClick={() => void cancel()}>{source ? 'Cancel attachment' : 'Discard'}</button>
          <button type="submit" className="primary-button" disabled={busy}>Hold</button>
        </footer>
      </form>
    </div>
  )
}
