import { flushSync } from 'react-dom'
import { LayoutReadiness, type StrataEditorHandle } from '../editor'
import { allocateTranscriptEditors, idleCandidate, TRANSCRIPT_EDITOR_LIMIT } from './transcriptAllocator'
import { firstTextPoint, lightweightRectForSourceOffset, lightweightSourceOffsetAtPoint, type ReadingAnchor } from './transcriptAnchors'
import { transcriptDiagnostics } from './transcriptDiagnostics'
import { fingerprint, TRANSCRIPT_LAYOUT_VERSION, type GeometryIdentity, type TranscriptGeometryStore } from './transcriptGeometry'

/**
 * The transcript's preparation and navigation coordinator
 * (docs/plans/open/transcript-scroll-stability-2026-09-07-plan.md §3).
 *
 * Each completed answer starts as lightweight Markdown. Its rich editor is
 * built in a staging area outside the transcript's flow, with the row's width
 * and typography, and waits there until its images, diagrams, and fonts have
 * settled and its height has held for two frames. While the reader scrolls
 * nothing is constructed, published, or compensated. When the gesture ends,
 * every ready candidate is published in one transaction that captures the
 * passage at the reading edge first and corrects the scroll position before
 * paint so that passage stays put. Navigation goes through the same
 * coordinator so it waits for a ready destination and scrolls exactly once.
 */
export type RowDisplay = 'lightweight' | 'placeholder' | 'rich'

export interface TranscriptRow {
  id: string
  element: HTMLElement
  source: string
  displayedSource(): string
  /** An active selection, an open discussion, or the current navigation target keeps the editor. */
  protected(): boolean
  pinned(): boolean
  /** The effective heading folds, serialized, for the geometry identity. */
  folds(): string
  /** True while the row is the navigation target with its folds temporarily revealed; its measurements are transient. */
  transient(): boolean
  /** The element the published editor host lives in; present only while the display is rich. */
  slot(): HTMLElement | null
  /** The source-mapped lightweight rendering; present only while the display is lightweight. */
  lightweight(): HTMLElement | null
  createEditor(host: HTMLElement, readiness: LayoutReadiness): StrataEditorHandle
  /** Applies a display change synchronously; called inside a layout transaction. */
  setDisplay(display: RowDisplay, reserved: number | null): void
  /** The editor was published into the slot, or removed from it. */
  published(handle: StrataEditorHandle | null): void
  /** Image source to file version, as the editor's resolver observed them. */
  imageVersions(): Record<string, string>
  /** Resolves an image source to its current file version, for validating a cached height. */
  imageVersion(source: string): Promise<string | null>
}

export interface TranscriptNavigation {
  serial: number
  message: string
  from: number
  to: number
  align?: 'start'
  annotation?: string
  pending?: boolean
}

export type NavigationOutcome = { target: TranscriptNavigation; outcome: 'landed' } | { target: TranscriptNavigation; outcome: 'failed'; reason: string } | { target: TranscriptNavigation; outcome: 'cancelled'; reason: string }

export interface TranscriptCoordinatorOptions {
  viewport: HTMLElement
  staging: HTMLElement
  column(): HTMLElement | null
  /** The history's explicit bottom-follow state. */
  atBottom(): boolean
  /** The history re-captures its reading position after a coordinator write. */
  remember(): void
  /** Aligns a message row at the reading inset with the spacer the history owns. */
  alignStart(row: HTMLElement): void
  identity: { engine: string; thread: string; placement: string; project?: string }
  geometry: TranscriptGeometryStore | null
  /** Idle preparation of unmeasured answers; off leaves stability and navigation intact. */
  sweep: boolean
  onNavigation?(outcome: NavigationOutcome): void
}

interface Candidate {
  source: string
  handle: StrataEditorHandle
  host: HTMLElement
  box: HTMLElement
  wrapper: HTMLElement
  readiness: LayoutReadiness
  controller: AbortController
  staged: boolean
  ready: boolean
  measureOnly: boolean
  started: number
  deadline: number | null
  unwatch: () => void
  waiting: boolean
}

interface RowState {
  row: TranscriptRow
  editor: Candidate | null
  measured: number | null
  hint: number | null
  lastVisible: number
  /** The passage at the reading edge could not be mapped; wait until the row leaves the viewport. */
  deferred: boolean
  deadlines: number
  invalidated: boolean
  rect: { top: number; bottom: number } | null
}

interface CapturedAnchor {
  kind: 'row-top' | 'passage'
  element: HTMLElement
  message: string | null
  offset: number | null
  top: number
}

const QUIET_MS = 250
const READY_DEADLINE_MS = 5000
const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '])

const frame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()))

export class TranscriptCoordinator {
  private readonly options: TranscriptCoordinatorOptions
  private readonly viewport: HTMLElement
  private rows = new Map<string, RowState>()
  private disposed = false
  private active = true
  private readingPin: string | null = null
  private scrolling = false
  private lastActivity = -Infinity
  private pointerActive = false
  private selecting = false
  private quietTimer: number | null = null
  private lastScrollTop: number
  private direction: -1 | 0 | 1 = 0
  private programmatic: number | null = null
  private frameHandle: number | null = null
  private nextTimer: number | null = null
  private idleHandle: number | null = null
  private streaming = false
  private width = 0
  private context: { zoom: number; typography: string } | null = null
  private navigation: { generation: number; target: TranscriptNavigation; controller: AbortController; started: number } | null = null
  private navigationGeneration = 0
  private pendingHints = new Set<string>()
  private awaitingRelease = false
  private readonly resize: ResizeObserver
  private readonly styleObserver: MutationObserver
  private readonly listeners: Array<() => void> = []

  constructor(options: TranscriptCoordinatorOptions) {
    this.options = options
    this.viewport = options.viewport
    this.lastScrollTop = this.viewport.scrollTop
    const on = <K extends keyof HTMLElementEventMap>(target: HTMLElement | Window | Document, type: K | string, listener: (event: never) => void, init?: AddEventListenerOptions) => {
      target.addEventListener(type, listener as EventListener, init)
      this.listeners.push(() => target.removeEventListener(type, listener as EventListener, init))
    }
    on(this.viewport, 'strata-reading-retention', () => this.refresh())
    on(document, 'focusin', () => this.refresh())
    on(document, 'focusout', () => this.refresh())
    on(this.viewport, 'scroll', () => this.onScroll(), { passive: true })
    on(this.viewport, 'scrollend', () => this.onQuiet(), { passive: true })
    on(this.viewport, 'wheel', () => this.intent('wheel'), { passive: true })
    on(this.viewport, 'pointerdown', () => { this.pointerActive = true; this.intent('pointer') })
    on(window, 'pointerup', () => { this.pointerActive = false; this.restartQuiet() })
    on(window, 'pointercancel', () => { this.pointerActive = false; this.restartQuiet() })
    on(this.viewport, 'touchstart', () => this.intent('touch'), { passive: true })
    on(this.viewport, 'touchmove', () => this.intent('touch'), { passive: true })
    on(window, 'keydown', (event: KeyboardEvent) => {
      if (!SCROLL_KEYS.has(event.key)) return
      const active = document.activeElement
      if (active === document.body || (active && this.viewport.contains(active))) this.intent('key')
    }, { capture: true })
    on(document, 'selectionchange', () => {
      const selection = window.getSelection()
      this.selecting = Boolean(selection && !selection.isCollapsed && selection.anchorNode && this.viewport.contains(selection.anchorNode)) && this.pointerActive
    })
    this.resize = new ResizeObserver(() => this.onResize())
    const column = options.column()
    if (column) this.resize.observe(column)
    this.width = column?.clientWidth ?? 0
    this.styleObserver = new MutationObserver(() => {
      this.context = null
      for (const state of this.rows.values()) if (state.editor?.staged) this.release(state, 'typography')
      this.schedule('typography')
    })
    for (let ancestor: HTMLElement | null = this.viewport; ancestor; ancestor = ancestor.parentElement) {
      this.styleObserver.observe(ancestor, { attributes: true, attributeFilter: ['style', 'class', 'data-theme', 'data-placement'] })
    }
  }

  // ---- rows

  register(row: TranscriptRow): () => void {
    const state: RowState = { row, editor: null, measured: null, hint: null, lastVisible: -Infinity, deferred: false, deadlines: 0, invalidated: false, rect: null }
    this.rows.set(row.id, state)
    this.applyHint(state)
    this.schedule('register')
    return () => {
      const current = this.rows.get(row.id)
      if (current !== state) return
      // The row is leaving React's tree; no display update can be flushed from its cleanup.
      this.release(state, 'unmount', false)
      this.rows.delete(row.id)
    }
  }

  /** The row's inputs changed in a way that invalidates its candidate: source, root, or fold state. */
  invalidate(id: string, reason: string): void {
    const state = this.rows.get(id)
    if (!state) return
    state.deadlines = 0
    state.measured = null
    state.hint = null
    state.invalidated = true
    this.pendingHints.delete(id)
    if (state.editor?.staged) this.release(state, `invalidate:${reason}`)
    this.schedule('invalidate')
  }

  /** A pin changed; the allocator reconsiders on the next pass. */
  refresh(): void { this.schedule('refresh') }

  setStreaming(value: boolean): void {
    if (this.streaming === value) return
    this.streaming = value
    this.schedule('streaming')
  }

  liveEditors(): number {
    let count = 0
    for (const state of this.rows.values()) if (state.editor) count += 1
    return count
  }

  // ---- scroll intent

  private onScroll(): void {
    const top = this.viewport.scrollTop
    if (this.programmatic !== null && Math.abs(top - this.programmatic) < 1) {
      this.programmatic = null
      this.lastScrollTop = top
      return
    }
    this.programmatic = null
    this.direction = top > this.lastScrollTop ? 1 : top < this.lastScrollTop ? -1 : this.direction
    this.lastScrollTop = top
    this.markScrolling('scroll')
  }

  private intent(source: string): void {
    this.markScrolling(source)
  }

  private markScrolling(source: string): void {
    this.lastActivity = performance.now()
    if (!this.scrolling) transcriptDiagnostics.record('scroll-start', { source, top: this.viewport.scrollTop, height: this.viewport.scrollHeight, viewport: this.viewport.clientHeight })
    this.scrolling = true
    this.viewport.dataset.scrollActive = 'true'
    this.cancelNavigation('reader-scrolled')
    if (this.idleHandle !== null) { cancelIdleCallback(this.idleHandle); this.idleHandle = null }
    this.restartQuiet()
  }

  private restartQuiet(): void {
    if (this.quietTimer !== null) window.clearTimeout(this.quietTimer)
    this.quietTimer = window.setTimeout(() => { this.quietTimer = null; this.onQuiet() }, QUIET_MS)
  }

  private onQuiet(): void {
    if (this.pointerActive || this.selecting || performance.now() - this.lastActivity < QUIET_MS) { this.restartQuiet(); return }
    if (!this.scrolling) return
    this.scrolling = false
    delete this.viewport.dataset.scrollActive
    transcriptDiagnostics.record('scroll-end', { top: this.viewport.scrollTop })
    this.schedule('idle')
  }

  setActive(active: boolean): void {
    this.active = active
    if (!active) {
      this.cancelNavigation('hidden')
      for (const state of this.rows.values()) if (state.editor?.staged) this.release(state, 'hidden')
    } else this.schedule('shown')
  }

  cancel(reason: string): void { this.cancelNavigation(reason) }

  releaseReading(): void { this.readingPin = null; this.schedule('reading-release') }

  private onResize(): void {
    const column = this.options.column()
    const width = column?.clientWidth ?? 0
    if (width === this.width) return
    this.width = width
    this.context = null
    // Staged candidates measured the old width; published editors reflow in place, which is a legitimate change.
    for (const state of this.rows.values()) if (state.editor?.staged) this.release(state, 'width')
    for (const state of this.rows.values()) if (!state.editor) this.applyHint(state)
    this.schedule('resize')
  }

  /** Every transcript scroll write goes through here so the next scroll event is known to be ours. */
  scrollTo(top: number, reason: string): void {
    const clamped = Math.max(0, Math.min(top, this.viewport.scrollHeight - this.viewport.clientHeight))
    if (Math.abs(this.viewport.scrollTop - clamped) < 0.5) return
    this.programmatic = clamped
    this.viewport.scrollTop = clamped
    this.lastScrollTop = this.viewport.scrollTop
    transcriptDiagnostics.counters.scrollWrites += 1
    transcriptDiagnostics.record('scroll-write', { reason, top: Math.round(clamped * 100) / 100, scrolling: this.scrolling })
  }

  isScrolling(): boolean { return this.scrolling }

  // ---- passes

  private schedule(reason: string): void {
    if (this.disposed || this.frameHandle !== null) return
    this.frameHandle = requestAnimationFrame(() => { this.frameHandle = null; this.pass(reason) })
  }

  private measure(): void {
    const viewportRect = this.viewport.getBoundingClientRect()
    const scrollTop = this.viewport.scrollTop
    const now = performance.now()
    const bottom = scrollTop + this.viewport.clientHeight
    for (const state of this.rows.values()) {
      const rect = state.row.element.getBoundingClientRect()
      const top = rect.top - viewportRect.top + scrollTop
      state.rect = { top, bottom: top + rect.height }
      const visible = state.rect.bottom > scrollTop && state.rect.top < bottom
      if (visible) state.lastVisible = now
      else if (state.deferred) state.deferred = false
    }
  }

  private pass(reason: string): void {
    if (this.disposed || !this.active) return
    if (this.scrolling || this.navigation) return
    this.measure()
    const scrollTop = this.viewport.scrollTop
    for (const state of this.rows.values()) {
      if (state.invalidated && state.editor && !state.row.pinned() && state.row.id !== this.readingPin && (state.rect!.bottom <= scrollTop || state.rect!.top >= scrollTop + this.viewport.clientHeight)) this.release(state, 'invalidated-offscreen')
    }
    const plan = allocateTranscriptEditors({
      rows: [...this.rows.values()].map((state) => ({ id: state.row.id, pinned: state.row.pinned() || this.readingPin === state.row.id || this.navigation?.target.message === state.row.id, top: state.rect!.top, bottom: state.rect!.bottom, editor: state.editor !== null, lastVisible: state.lastVisible })),
      viewportTop: scrollTop,
      viewportHeight: this.viewport.clientHeight,
      direction: this.direction,
      limit: TRANSCRIPT_EDITOR_LIMIT,
    })
    if (plan.overflow) transcriptDiagnostics.record('pin-overflow', { pinned: plan.keep.length })
    for (const id of plan.release) { const state = this.rows.get(id); if (state) this.release(state, 'allocator') }
    // A measure-only candidate gives its slot to demand work.
    for (const id of plan.prepare) { const state = this.rows.get(id); if (state?.editor?.measureOnly) this.release(state, 'demand') }
    const next = plan.prepare.find((id) => !this.rows.get(id)?.editor)
    if (next) {
      this.prepare(next, false)
      if (plan.prepare.some((id) => id !== next && !this.rows.get(id)?.editor)) this.scheduleNext()
    }
    this.publish(reason, null, { force: false })
    if (!next && this.options.sweep && !this.streaming) this.scheduleIdle(plan.keep.length)
  }

  private scheduleNext(): void {
    if (this.nextTimer !== null) return
    // One construction per task so a wheel event between two answers is seen.
    this.nextTimer = window.setTimeout(() => { this.nextTimer = null; this.schedule('prepare-next') }, 0)
  }

  private scheduleIdle(keepCount: number): void {
    if (this.idleHandle !== null || typeof requestIdleCallback !== 'function') return
    this.idleHandle = requestIdleCallback(() => {
      this.idleHandle = null
      if (this.disposed || this.scrolling || this.streaming) return
      this.measure()
      const unmeasured = new Set([...this.rows.values()].filter((state) => state.measured === null && state.hint === null && !state.row.transient()).map((state) => state.row.id))
      const id = idleCandidate({
        rows: [...this.rows.values()].map((state) => ({ id: state.row.id, pinned: state.row.pinned() || this.readingPin === state.row.id || this.navigation?.target.message === state.row.id, top: state.rect!.top, bottom: state.rect!.bottom, editor: state.editor !== null, lastVisible: state.lastVisible })),
        viewportTop: this.viewport.scrollTop, viewportHeight: this.viewport.clientHeight, direction: this.direction, limit: TRANSCRIPT_EDITOR_LIMIT, unmeasured, keepCount,
      })
      if (id) this.prepare(id, true)
    }, { timeout: 2000 })
  }

  // ---- preparation

  private prepare(id: string, measureOnly: boolean): void {
    const state = this.rows.get(id)
    if (!state || state.editor || !this.active || this.scrolling || state.deadlines > 0) return
    if (this.liveEditors() >= TRANSCRIPT_EDITOR_LIMIT) return
    const wrapper = document.createElement('article')
    wrapper.className = 'conversation-message assistant conversation-staged'
    wrapper.setAttribute('aria-hidden', 'true')
    wrapper.inert = true
    const body = document.createElement('div')
    const inner = document.createElement('div')
    inner.className = 'conversation-rich-message'
    inner.dataset.richMounted = measureOnly ? 'measuring' : 'staged'
    inner.dataset.stagedMessage = id
    const host = document.createElement('div')
    host.className = 'prosemirror-host'
    host.dataset.prosemirrorHost = ''
    const box = document.createElement('div')
    box.className = 'conversation-editor-slot'
    box.append(host)
    inner.append(box)
    body.append(inner)
    wrapper.append(body)
    this.options.staging.append(wrapper)
    const readiness = new LayoutReadiness((kind) => transcriptDiagnostics.gate(kind))
    const started = performance.now()
    let handle: StrataEditorHandle
    try {
      handle = state.row.createEditor(host, readiness)
    } catch (error) {
      wrapper.remove()
      transcriptDiagnostics.record('mount-failed', { id, error: error instanceof Error ? error.message : String(error) })
      return
    }
    const constructionMs = performance.now() - started
    transcriptDiagnostics.mounted()
    transcriptDiagnostics.record('mount', { id, ms: Math.round(constructionMs), measureOnly, live: transcriptDiagnostics.counters.live })
    state.invalidated = false
    state.editor = { source: state.row.source, handle, host, box, wrapper, readiness, controller: new AbortController(), staged: true, ready: false, measureOnly, started, deadline: null, unwatch: () => {}, waiting: false }
    const candidate = state.editor
    candidate.unwatch = readiness.onChange(snapshot => {
      if (state.editor !== candidate || !candidate.staged) return
      if (snapshot.pending > 0) { candidate.ready = false; void this.awaitReady(state, candidate) }
    })
    candidate.deadline = window.setTimeout(() => {
      if (state.editor !== candidate || candidate.ready) return
      transcriptDiagnostics.counters.deadlines += 1
      transcriptDiagnostics.record('deadline', { id, pending: readiness.snapshot().labels })
      state.deadlines += 1
      this.release(state, 'deadline')
      if (this.navigation?.target.message === id) this.failNavigation('deadline')
      this.schedule('deadline')
    }, READY_DEADLINE_MS)
    void this.awaitReady(state, state.editor)
  }

  private async awaitReady(state: RowState, candidate: Candidate): Promise<void> {
    if (candidate.waiting) return
    candidate.waiting = true
    try {
      const signal = candidate.controller.signal
      while (!signal.aborted && state.editor === candidate) {
        try { await candidate.readiness.whenSettled() } catch { return }
        await document.fonts.ready
        if (signal.aborted || state.editor !== candidate) return
        const first = (candidate.staged ? candidate.box : state.row.slot() ?? candidate.host).getBoundingClientRect().height
        await frame()
        if (signal.aborted || state.editor !== candidate) return
        const second = (candidate.staged ? candidate.box : state.row.slot() ?? candidate.host).getBoundingClientRect().height
        await frame()
        if (signal.aborted || state.editor !== candidate) return
        const third = (candidate.staged ? candidate.box : state.row.slot() ?? candidate.host).getBoundingClientRect().height
        if (candidate.readiness.pending === 0 && third > 0 && Math.abs(first - second) < 0.5 && Math.abs(second - third) < 0.5) {
          candidate.ready = true
          if (candidate.deadline !== null) window.clearTimeout(candidate.deadline)
          candidate.deadline = null
          state.measured = third
          const waited = performance.now() - candidate.started
          transcriptDiagnostics.counters.resourceWaitMs += waited
          transcriptDiagnostics.record('ready', { id: state.row.id, ms: Math.round(waited), height: Math.round(third), measureOnly: candidate.measureOnly })
          if (candidate.measureOnly) {
            // The sweep only measures: record the height, reserve it, and free the slot.
            this.recordGeometry(state)
            this.release(state, 'measured')
            state.hint = third
            this.pendingHints.add(state.row.id)
          }
          this.schedule('ready')
          return
        }

      }
    } finally { candidate.waiting = false }
  }

  private release(state: RowState, reason: string, updateDisplay = true): void {
    const editor = state.editor
    if (!editor) return
    editor.unwatch()
    editor.controller.abort()
    if (editor.deadline !== null) window.clearTimeout(editor.deadline)
    if (!editor.staged) {
      state.measured = (state.row.slot() ?? editor.host).getBoundingClientRect().height || state.measured
      state.row.published(null)
    }
    if (!editor.staged && updateDisplay) {
      // Measured height keeps the row's geometry through the swap back to Markdown.
      flushSync(() => state.row.setDisplay('placeholder', state.measured))
    }
    // Reserve the old height before removing its editor. An empty row, even
    // within one task, can clamp scrollTop near the end of the transcript.
    editor.handle.destroy()
    editor.wrapper.remove()
    editor.host.remove()
    state.editor = null
    transcriptDiagnostics.unmounted()
    transcriptDiagnostics.record('unmount', { id: state.row.id, reason, staged: editor.staged, live: transcriptDiagnostics.counters.live })
  }

  // ---- publication

  private publish(reason: string, only: ReadonlySet<string> | null, options: { force: boolean; anchor?: boolean }): void {
    if (this.disposed) return
    if (this.scrolling && !options.force) return
    if (transcriptDiagnostics.isHeld('publish')) {
      // A test holds publication; resume the pass when it releases.
      if (!this.awaitingRelease) {
        this.awaitingRelease = true
        void transcriptDiagnostics.gate('publish').then(() => { this.awaitingRelease = false; this.schedule('released') })
      }
      return
    }
    const ready = [...this.rows.values()].filter((state) => state.editor?.staged && state.editor.source === state.row.source && state.editor.ready && !state.editor.measureOnly && !state.deferred && state.row.id !== this.readingPin && !state.row.protected() && (only === null || only.has(state.row.id)) && state.row.slot() === null)
    const hints = [...this.pendingHints].map((id) => this.rows.get(id)).filter((state): state is RowState => Boolean(state) && !state!.editor)
    const bounds = this.viewport.getBoundingClientRect()
    for (let index = hints.length - 1; index >= 0; index -= 1) {
      const rect = hints[index]!.row.element.getBoundingClientRect()
      if (rect.bottom > bounds.top && rect.top < bounds.bottom) hints.splice(index, 1)
    }
    for (const state of hints) this.pendingHints.delete(state.row.id)
    if (ready.length === 0 && hints.length === 0) return
    const following = options.anchor !== false && this.options.atBottom()
    const viewportRect = this.viewport.getBoundingClientRect()
    let anchor: CapturedAnchor | null = null
    if (!following && options.anchor !== false) {
      let replacing = new Set(ready.map((state) => state.row.id))
      anchor = this.captureAnchor(replacing)
      if (anchor?.kind === 'passage' && (anchor.offset === null || this.rows.get(anchor.message!)?.row.displayedSource() !== this.rows.get(anchor.message!)?.row.source || !this.rows.get(anchor.message!)?.editor?.handle.coordsForSourceOffset(anchor.offset))) {
        // The passage at the reading edge cannot be mapped (an image, a diagram, unmatched text). Keep that
        // row as it is until it leaves the viewport and anchor the others on its top edge instead.
        const deferred = ready.find((state) => state.row.id === anchor!.message)
        if (deferred) {
          deferred.deferred = true
          transcriptDiagnostics.counters.deferred += 1
          transcriptDiagnostics.record('deferred', { id: deferred.row.id })
          ready.splice(ready.indexOf(deferred), 1)
        }
        replacing = new Set(ready.map((state) => state.row.id))
        anchor = ready.length === 0 && hints.length === 0 ? null : this.captureAnchor(replacing)
        if (ready.length === 0 && hints.length === 0) return
      }
    }
    flushSync(() => {
      for (const state of ready) state.row.setDisplay('rich', null)
      for (const state of hints) state.row.setDisplay(state.hint === null ? 'lightweight' : 'placeholder', state.hint)
    })
    const published: RowState[] = []
    for (const state of ready) {
      const editor = state.editor
      const slot = state.row.slot()
      if (!editor || !slot) continue
      slot.append(editor.host)
      const actualHeight = slot.getBoundingClientRect().height
      if (state.measured !== null && Math.abs(actualHeight - state.measured) > 0.5) transcriptDiagnostics.record('geometry-mismatch', { id: state.row.id, prepared: state.measured, published: actualHeight })
      state.measured = actualHeight
      editor.wrapper.remove()
      editor.staged = false
      state.row.published(editor.handle)
      published.push(state)
      transcriptDiagnostics.counters.publications += 1
      this.recordGeometry(state)
    }
    let correction = 0
    let anchorLost = false
    if (following) {
      this.scrollTo(this.viewport.scrollHeight, 'bottom-follow')
    } else if (anchor) {
      const resolved = this.resolveAnchor(anchor, viewportRect)
      if (resolved === null) {
        anchorLost = true
        transcriptDiagnostics.record('anchor-lost', { message: anchor.message, offset: anchor.offset })
        // Leave the position unchanged and record a correctness failure; never guess a row offset.
        correction = 0
      } else correction = resolved - anchor.top
      if (Math.abs(correction) >= 0.5) {
        transcriptDiagnostics.counters.corrections += 1
        this.scrollTo(this.viewport.scrollTop + correction, 'publication-correction')
      }
    }
    this.options.remember()
    this.schedule('published')
    transcriptDiagnostics.record('publish', { reason, rows: published.map((state) => state.row.id), hints: hints.map((state) => state.row.id), anchor: anchor ? { kind: anchor.kind, message: anchor.message, offset: anchor.offset } : following ? 'bottom' : null, correction: Math.round(correction * 100) / 100, anchorLost, live: transcriptDiagnostics.counters.live })
  }

  /** The reading anchor: the row at the reading edge, and the passage inside it when that row itself is being replaced. */
  private captureAnchor(replacing: ReadonlySet<string>): CapturedAnchor | null {
    const viewportRect = this.viewport.getBoundingClientRect()
    const edge = viewportRect.top + this.readingInset()
    const rows = Array.from(this.viewport.querySelectorAll<HTMLElement>('[data-history-row]'))
    const element = rows.find((row) => row.getBoundingClientRect().bottom > edge)
    if (!element) return null
    const rect = element.getBoundingClientRect()
    const message = element.dataset.messageId ?? null
    if (rect.top >= edge - 1 || message === null || !replacing.has(message)) return { kind: 'row-top', element, message, offset: null, top: rect.top }
    const state = this.rows.get(message)
    const container = state?.row.lightweight()
    if (!state || !container) return { kind: 'row-top', element, message, offset: null, top: rect.top }
    const atomic = [...container.querySelectorAll<HTMLElement>('[data-atomic]')].some(node => { const box = node.getBoundingClientRect(); return box.top <= edge && box.bottom > edge })
    if (atomic) return { kind: 'passage', element, message, offset: null, top: rect.top }
    const point = firstTextPoint(rect, edge, (left, top) => lightweightSourceOffsetAtPoint(container, state.row.displayedSource(), left, top))
    if (!point) return { kind: 'passage', element, message, offset: null, top: rect.top }
    return { kind: 'passage', element, message, offset: point.offset, top: point.top }
  }

  /** The anchored text's client top after the transaction, or null when it cannot be found. */
  private resolveAnchor(anchor: CapturedAnchor, _viewportRect: DOMRect): number | null {
    if (anchor.kind === 'row-top' || anchor.offset === null) return anchor.element.getBoundingClientRect().top
    const state = anchor.message ? this.rows.get(anchor.message) : null
    if (!state) return null
    if (state.editor && !state.editor.staged) return state.editor.handle.coordsForSourceOffset(anchor.offset)?.top ?? null
    const container = state.row.lightweight()
    if (!container) return null
    return lightweightRectForSourceOffset(container, state.row.displayedSource(), anchor.offset)?.top ?? null
  }

  private readingInset(): number {
    return Number.parseFloat(getComputedStyle(this.viewport).paddingTop) || 0
  }

  // ---- reading anchors for Back to reading

  /** Preserve the reading passage while an already mounted editor changes decorations. */
  updateReadingContent(update: () => void): void {
    if (this.navigation || !this.active || this.disposed) { update(); return }
    const following = this.options.atBottom()
    const anchor = following ? null : this.captureReadingAnchor()
    const pin = this.readingPin
    update()
    if (following) this.scrollTo(this.viewport.scrollHeight, 'annotation-bottom')
    else if (anchor) { this.restoreReading(anchor); this.readingPin = pin }
    this.options.remember()
  }

  captureReading(): ReadingAnchor | null {
    const anchor = this.captureReadingAnchor()
    this.readingPin = anchor?.message ?? null
    return anchor
  }

  private captureReadingAnchor(): ReadingAnchor | null {
    const viewportRect = this.viewport.getBoundingClientRect()
    const edge = viewportRect.top + this.readingInset()
    const rows = Array.from(this.viewport.querySelectorAll<HTMLElement>('[data-message-id]'))
    const element = rows.find((row) => row.getBoundingClientRect().bottom > edge)
    if (!element) return null
    const message = element.dataset.messageId!
    const rect = element.getBoundingClientRect()
    if (rect.top >= edge - 1) return { message, offset: null, viewportOffset: rect.top - viewportRect.top }
    const state = this.rows.get(message)
    if (state?.editor && !state.editor.staged) {
      const handle = state.editor.handle
      const point = firstTextPoint(rect, edge, (left, top) => {
        const offset = handle.sourceOffsetAtPoint(left, top)
        if (offset === null) return null
        const coords = handle.coordsForSourceOffset(offset)
        return coords ? { offset, top: coords.top } : null
      })
      if (point) return { message, offset: point.offset, viewportOffset: point.top - viewportRect.top }
    } else if (state) {
      const container = state.row.lightweight()
      const point = container ? firstTextPoint(rect, edge, (left, top) => lightweightSourceOffsetAtPoint(container, state.row.displayedSource(), left, top)) : null
      if (point) return { message, offset: point.offset, viewportOffset: point.top - viewportRect.top }
    }
    return { message, offset: null, viewportOffset: rect.top - viewportRect.top }
  }

  restoreReading(anchor: ReadingAnchor): boolean {
    const element = this.viewport.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(anchor.message)}"]`)
    if (!element) return false
    transcriptDiagnostics.record('restore-reading', { ...anchor, scrollTop: this.viewport.scrollTop })
    this.cancelNavigation('back-to-reading')
    this.readingPin = null
    const viewportRect = this.viewport.getBoundingClientRect()
    let top: number | null = null
    const state = this.rows.get(anchor.message)
    if (anchor.offset !== null && state) {
      if (state.editor && !state.editor.staged) top = state.editor.handle.coordsForSourceOffset(anchor.offset)?.top ?? null
      else { const container = state.row.lightweight(); top = container ? lightweightRectForSourceOffset(container, state.row.displayedSource(), anchor.offset)?.top ?? null : null }
    }
    if (top === null) top = element.getBoundingClientRect().top
    this.scrollTo(this.viewport.scrollTop + (top - viewportRect.top) - anchor.viewportOffset, 'back-to-reading')
    this.options.remember()
    this.schedule('back-to-reading')
    return true
  }

  // ---- navigation

  navigate(target: TranscriptNavigation): void {
    this.cancelNavigation('superseded')
    const generation = ++this.navigationGeneration
    const controller = new AbortController()
    this.navigation = { generation, target, controller, started: performance.now() }
    transcriptDiagnostics.counters.navigations += 1
    transcriptDiagnostics.record('navigate', { serial: target.serial, message: target.message, align: target.align ?? null, annotation: target.annotation ?? null })
    // An explicit navigation ends any scroll gesture; the reader asked to go somewhere.
    if (this.quietTimer !== null) { window.clearTimeout(this.quietTimer); this.quietTimer = null }
    this.scrolling = false
    delete this.viewport.dataset.scrollActive
    const element = this.viewport.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(target.message)}"]`)
    if (!element) { this.failNavigation('missing-row'); return }
    const state = this.rows.get(target.message)
    if (!state) {
      if (target.align === 'start') { this.options.alignStart(element); this.finishNavigation(generation); return }
      const rect = element.getBoundingClientRect()
      const viewportRect = this.viewport.getBoundingClientRect()
      this.scrollTo(this.viewport.scrollTop + rect.top - viewportRect.top - (this.viewport.clientHeight - rect.height) / 2, 'navigation-row')
      this.options.remember()
      this.finishNavigation(generation)
      return
    }
    // History receives navigation during React's commit. Start after that
    // commit so the placeholder's flushSync completes before editor removal.
    queueMicrotask(() => {
      if (!controller.signal.aborted) void this.navigateToPassage(state, target, generation, controller)
    })
  }

  private async navigateToPassage(state: RowState, target: TranscriptNavigation, generation: number, controller: AbortController): Promise<void> {
    const signal = controller.signal
    const timeout = window.setTimeout(() => {
      if (this.navigation?.generation === generation) this.failNavigation('deadline')
    }, READY_DEADLINE_MS)
    try {
      if (state.editor && (state.invalidated || state.editor.source !== state.row.source)) {
        if (state.row.protected()) { this.failNavigation('selection-active'); return }
        this.release(state, 'navigation-invalidated')
      }
      state.deadlines = 0 // An explicit request is also a retry.
      state.deferred = false
      this.measure()
      // All editor admission, including navigation, shares the same budget.
      const plan = allocateTranscriptEditors({
        rows: [...this.rows.values()].map(row => ({ id: row.row.id, pinned: row.row.id === target.message || this.readingPin === row.row.id || row.row.pinned(), top: row.rect!.top, bottom: row.rect!.bottom, editor: row.editor !== null, lastVisible: row.lastVisible })),
        viewportTop: this.viewport.scrollTop, viewportHeight: this.viewport.clientHeight, direction: this.direction,
      })
      for (const id of plan.release) { const row = this.rows.get(id); if (row) this.release(row, 'navigation-admission') }
      if (state.editor?.measureOnly) this.release(state, 'navigation-demand')
      if (!state.editor) this.prepare(state.row.id, false)
      if (!state.editor) { this.failNavigation('capacity'); return }
      // Reveal first. Fold/table changes can start new resource work.
      if (target.align !== 'start') state.editor.handle.revealAnnotation(target.annotation ?? 'conversation-jump', false) ?? state.editor.handle.revealSource(target.from, target.to)
      state.editor.ready = false
      void this.awaitReady(state, state.editor)
      while (!signal.aborted && state.editor && !state.editor.ready) await frame()
      if (signal.aborted || this.navigation?.generation !== generation) return
      if (!state.editor) { this.failNavigation('not-ready'); return }
      const coords = target.align === 'start' ? null : state.editor.handle.revealAnnotation(target.annotation ?? 'conversation-jump') ?? state.editor.handle.revealSource(target.from, target.to)
      if (target.align !== 'start' && !coords) { this.failNavigation('unmapped'); return }
      if (state.editor.staged) this.publish('navigation', new Set([state.row.id]), { force: true, anchor: false })
      if (this.navigation?.generation !== generation) return
      const editor = state.editor
      if (!editor || editor.staged) { this.failNavigation('not-published'); return }
      if (target.align === 'start') this.options.alignStart(state.row.element)
      else {
        const destination = editor.handle.revealAnnotation(target.annotation ?? 'conversation-jump') ?? editor.handle.revealSource(target.from, target.to)
        if (!destination) { this.failNavigation('unmapped'); return }
        const viewportRect = this.viewport.getBoundingClientRect()
        this.scrollTo(this.viewport.scrollTop + destination.top - viewportRect.top - this.viewport.clientHeight / 2, 'navigation-passage')
      }
      this.options.remember()
      this.finishNavigation(generation)
      this.schedule('navigation')
    } finally { window.clearTimeout(timeout) }
  }

  private finishNavigation(generation: number): void {
    const navigation = this.navigation
    if (!navigation || navigation.generation !== generation) return
    this.navigation = null
    navigation.controller.abort()
    transcriptDiagnostics.record('navigated', { serial: navigation.target.serial, ms: Math.round(performance.now() - navigation.started) })
    this.options.onNavigation?.({ target: navigation.target, outcome: 'landed' })
  }

  private failNavigation(reason: string): void {
    const navigation = this.navigation
    if (!navigation) return
    this.navigation = null
    navigation.controller.abort()
    transcriptDiagnostics.counters.navigationFailures += 1
    transcriptDiagnostics.record('navigation-failed', { serial: navigation.target.serial, reason })
    this.options.onNavigation?.({ target: navigation.target, outcome: 'failed', reason })
  }

  private cancelNavigation(reason: string): void {
    const navigation = this.navigation
    if (!navigation) return
    this.navigation = null
    navigation.controller.abort()
    transcriptDiagnostics.record('navigation-cancelled', { serial: navigation.target.serial, reason })
    this.options.onNavigation?.({ target: navigation.target, outcome: 'cancelled', reason })
  }

  // ---- geometry cache

  private identity(state: RowState): GeometryIdentity | null {
    const column = this.options.column()
    if (!column || this.width === 0) return null
    if (!this.context) {
      const style = getComputedStyle(column)
      this.context = { zoom: Number.parseFloat(style.getPropertyValue('--zoom')) || 1, typography: `${style.fontFamily}|${style.fontSize}|${style.lineHeight}|${style.letterSpacing}|${style.getPropertyValue('--font-code').trim()}|${getComputedStyle(this.viewport).getPropertyValue('--zoom')}` }
    }
    return { engine: this.options.identity.engine, thread: this.options.identity.thread, project: this.options.identity.project ?? '', message: state.row.id, source: fingerprint(state.row.source), width: this.width, placement: this.options.identity.placement, zoom: this.context.zoom, typography: this.context.typography, folds: state.row.folds(), layoutVersion: TRANSCRIPT_LAYOUT_VERSION }
  }

  private recordGeometry(state: RowState): void {
    if (!this.options.geometry || state.measured === null || state.row.transient() || state.editor?.source !== state.row.source) return
    const identity = this.identity(state)
    if (identity) this.options.geometry.set(identity, { height: state.measured, images: state.row.imageVersions(), measuredAt: Date.now() })
  }

  private applyHint(state: RowState): void {
    if (!this.options.geometry || state.editor || state.measured !== null) return
    const identity = this.identity(state)
    const entry = identity ? this.options.geometry.get(identity) : null
    if (!entry) { if (state.hint !== null) { state.hint = null; this.pendingHints.add(state.row.id) } return }
    state.hint = entry.height
    this.pendingHints.add(state.row.id)
    transcriptDiagnostics.record('hint', { id: state.row.id, height: entry.height, images: Object.keys(entry.images).length })
    const sources = Object.entries(entry.images)
    if (sources.length === 0) return
    // A hint is provisional until the images it was measured with still match.
    void Promise.all(sources.map(async ([source, version]) => (await state.row.imageVersion(source)) === version)).then((matches) => {
      if (this.disposed || this.rows.get(state.row.id) !== state || state.hint !== entry.height || matches.every(Boolean)) return
      state.hint = null
      this.pendingHints.add(state.row.id)
      transcriptDiagnostics.record('hint-invalid', { id: state.row.id })
      this.schedule('hint-invalid')
    }).catch(() => {
      if (this.disposed || this.rows.get(state.row.id) !== state) return
      state.hint = null
      this.pendingHints.add(state.row.id)
      this.schedule('hint-failed')
    })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.cancelNavigation('disposed')
    if (this.quietTimer !== null) window.clearTimeout(this.quietTimer)
    if (this.frameHandle !== null) cancelAnimationFrame(this.frameHandle)
    if (this.nextTimer !== null) window.clearTimeout(this.nextTimer)
    if (this.idleHandle !== null) cancelIdleCallback(this.idleHandle)
    for (const listener of this.listeners) listener()
    this.resize.disconnect()
    this.styleObserver.disconnect()
    delete this.viewport.dataset.scrollActive
    for (const state of this.rows.values()) {
      const editor = state.editor
      if (!editor) continue
      editor.unwatch()
    editor.controller.abort()
    if (editor.deadline !== null) window.clearTimeout(editor.deadline)
      editor.handle.destroy()
      editor.wrapper.remove()
      state.editor = null
      transcriptDiagnostics.unmounted()
    }
    this.rows.clear()
    // Writes are already queued for idle time; disposal must not force storage I/O during input.
  }
}
