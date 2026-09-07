import { Component, createContext, createRef, useContext, useLayoutEffect, useRef, type ReactNode } from 'react'
import { engineStorage } from '../engineStorage'
import { TranscriptCoordinator, type NavigationOutcome, type TranscriptNavigation, type TranscriptRow } from '../transcriptCoordinator'
import { TranscriptGeometryStore } from '../transcriptGeometry'
import type { ReadingAnchor } from '../transcriptAnchors'

/** What a transcript row and the staging element reach the coordinator through; registrations before mount are queued. */
export interface TranscriptPort {
  register(row: TranscriptRow): () => void
  invalidate(id: string, reason: string): void
  refresh(): void
  setStaging(element: HTMLElement | null): void
}

export const TranscriptContext = createContext<TranscriptPort | null>(null)

/** The staging area where candidate editors lay out at the column's width without entering the transcript's flow. */
export function TranscriptStaging() {
  const port = useContext(TranscriptContext)
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    port?.setStaging(ref.current)
    return () => port?.setStaging(null)
  }, [port])
  return <div ref={ref} className="conversation-staging" aria-hidden="true" />
}

interface Props {
  active?: boolean
  target?: TranscriptNavigation | null | undefined
  streaming?: boolean
  messages?: readonly string[]
  /** Cache identity for measured heights; absent for plain scrollers without a staging element. */
  identity?: { engine: string; thread: string; placement: string; project?: string }
  onNavigation?(outcome: NavigationOutcome): void
  className: string
  children: ReactNode
}
type ReadingPosition = 'bottom' | { element: HTMLElement; top: number; scrollTop: number }

const flag = (name: string): boolean => (globalThis as Record<string, unknown>)[name] !== '0'
let geometryStore: TranscriptGeometryStore | null | undefined

/** One persistent height store per renderer; absent when the switch is off, and memory-only when storage fails. */
function sharedGeometry(): TranscriptGeometryStore | null {
  if (geometryStore !== undefined) return geometryStore
  geometryStore = flag('strataTranscriptCache') ? new TranscriptGeometryStore({ storage: engineStorage, schedule: (write) => {
    const idleWrite = () => {
      if (document.querySelector('[data-scroll-active]')) { setTimeout(idleWrite, 250); return }
      write()
    }
    if (typeof requestIdleCallback === 'function') requestIdleCallback(idleWrite); else setTimeout(idleWrite, 500)
  } }) : null
  return geometryStore
}

/**
 * The transcript viewport. Follows the bottom or preserves the visible row when
 * rows resize for legitimate reasons (streaming, folds, disclosures), and owns
 * the coordinator that prepares rich editors outside the flow and publishes
 * them, passage-preserving, when the reader is not scrolling (§6.15).
 */
export class ConversationHistory extends Component<Props, Record<string, never>, ReadingPosition | null> {
  private viewport = createRef<HTMLDivElement>()
  private spacer = createRef<HTMLDivElement>()
  private observer: ResizeObserver | undefined
  private mutation: MutationObserver | undefined
  private position: ReadingPosition | null = null
  private lastScrollTop = 0
  private coordinator: TranscriptCoordinator | null = null
  private staging: HTMLElement | null = null
  private queued: Array<{ row: TranscriptRow; release: { current: (() => void) | null }; cancelled: boolean }> = []
  private remember = () => { this.position = this.capturePosition(); this.lastScrollTop = this.viewport.current!.scrollTop }
  readonly port: TranscriptPort = {
    register: (row) => {
      if (this.coordinator) return this.coordinator.register(row)
      const entry = { row, release: { current: null as (() => void) | null }, cancelled: false }
      this.queued.push(entry)
      return () => { entry.cancelled = true; entry.release.current?.() }
    },
    invalidate: (id, reason) => this.coordinator?.invalidate(id, reason),
    refresh: () => this.coordinator?.refresh(),
    setStaging: (element) => { this.staging = element; if (element && this.viewport.current && !this.coordinator) this.createCoordinator() },
  }

  private write(top: number, reason: string) {
    if (this.coordinator) this.coordinator.scrollTo(top, reason)
    else this.viewport.current!.scrollTop = top
  }

  isAtBottom = () => {
    const viewport = this.viewport.current
    return Boolean(viewport && viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= 24)
  }

  scrollToBottom = () => {
    this.coordinator?.cancel('newest')
    this.spacer.current!.style.height = '0px'
    this.write(this.viewport.current!.scrollHeight, 'bottom')
    this.remember()
  }

  /** The exact passage at the reading edge, for Back to reading. */
  captureReading = (): ReadingAnchor | null => this.coordinator?.captureReading() ?? null

  releaseReading = () => this.coordinator?.releaseReading()

  restoreReading = (anchor: ReadingAnchor): boolean => this.coordinator?.restoreReading(anchor) ?? false

  /** Centers an arbitrary transcript element, such as an agent's spawn row, through the coordinator's write path. */
  centerElement = (element: HTMLElement) => {
    this.coordinator?.cancel('agent-row')
    const viewport = this.viewport.current!
    const rect = element.getBoundingClientRect()
    this.write(viewport.scrollTop + rect.top - viewport.getBoundingClientRect().top - (viewport.clientHeight - rect.height) / 2, 'center-element')
    this.remember()
  }

  private alignStart(row: HTMLElement) {
    const viewport = this.viewport.current!
    this.spacer.current!.style.height = '0px'
    const inset = Number.parseFloat(getComputedStyle(viewport).paddingTop)
    const top = viewport.scrollTop + row.getBoundingClientRect().top - viewport.getBoundingClientRect().top - inset
    // Short answers need room below them to reach the top. Leave a small gap
    // from the bottom so incoming text does not resume following while reading.
    this.spacer.current!.style.height = `${Math.max(0, top + viewport.clientHeight - viewport.scrollHeight + 32)}px`
    this.write(top, 'navigation-start')
    this.position = null
    this.remember()
  }

  private createCoordinator() {
    const viewport = this.viewport.current!
    const geometry = sharedGeometry()
    if (this.props.identity && this.props.messages) geometry?.prune(this.props.identity, new Set(this.props.messages))
    this.coordinator = new TranscriptCoordinator({
      viewport,
      staging: this.staging!,
      column: () => viewport.querySelector<HTMLElement>('.conversation-column'),
      atBottom: () => this.capturePosition() === 'bottom',
      remember: this.remember,
      alignStart: (row) => this.alignStart(row),
      identity: this.props.identity ?? { engine: '', thread: '', placement: '' },
      geometry,
      sweep: flag('strataTranscriptSweep'),
      onNavigation: (outcome) => this.props.onNavigation?.(outcome),
    })
    this.coordinator.setActive(this.props.active !== false)
    this.coordinator.setStreaming(this.props.streaming ?? false)
    for (const entry of this.queued.splice(0)) if (!entry.cancelled) entry.release.current = this.coordinator.register(entry.row)
  }

  componentDidMount() {
    const viewport = this.viewport.current!
    let visible = viewport.clientHeight > 0
    if (this.staging && !this.coordinator) this.createCoordinator()
    this.scrollToBottom()
    this.observer = new ResizeObserver(() => {
      const nextVisible = viewport.clientHeight > 0
      if (nextVisible && !visible) this.scrollToBottom()
      visible = nextVisible
      if (this.position === 'bottom') {
        // A passage jump can run before its scroll event. Respect that move.
        if (this.capturePosition() === 'bottom') this.write(viewport.scrollHeight, 'bottom-follow')
      } else if (this.position?.element.isConnected && Math.abs(viewport.scrollTop - this.position.scrollTop) < 1) {
        const delta = this.position.element.getBoundingClientRect().top - this.position.top
        if (Math.abs(delta) >= 0.5) this.write(viewport.scrollTop + delta, 'row-resize')
      }
      this.remember()
    })
    this.observer.observe(viewport)
    // The content wrapper also catches changes outside individual history rows.
    const observeRows = () => { for (const row of viewport.querySelectorAll('[data-history-row], .conversation-column')) this.observer?.observe(row) }
    observeRows()
    this.mutation = new MutationObserver(observeRows)
    this.mutation.observe(viewport, { childList: true, subtree: true })
    viewport.addEventListener('scroll', this.remember, { passive: true })
  }

  componentWillUnmount() {
    this.observer?.disconnect()
    this.mutation?.disconnect()
    this.viewport.current?.removeEventListener('scroll', this.remember)
    this.coordinator?.dispose()
    this.coordinator = null
  }

  getSnapshotBeforeUpdate(previous: Props): ReadingPosition | null {
    return previous.target?.serial !== this.props.target?.serial ? null : this.capturePosition()
  }

  private capturePosition(): ReadingPosition | null {
    const viewport = this.viewport.current!
    if (!viewport.clientHeight) return null
    if (viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= 24 || this.position === 'bottom' && Math.abs(viewport.scrollTop - this.lastScrollTop) < 1) return 'bottom'
    const top = viewport.getBoundingClientRect().top
    const element = Array.from(viewport.querySelectorAll<HTMLElement>('[data-history-row]'))
      .find((row) => row.getBoundingClientRect().bottom > top)
    return element ? { element, top: element.getBoundingClientRect().top, scrollTop: viewport.scrollTop } : null
  }

  componentDidUpdate(previous: Props, _state: Record<string, never>, position: ReadingPosition | null) {
    if (previous.messages !== this.props.messages && this.props.identity && this.props.messages) sharedGeometry()?.prune(this.props.identity, new Set(this.props.messages))
    if (previous.active !== this.props.active) this.coordinator?.setActive(this.props.active !== false)
    if (previous.streaming !== this.props.streaming) this.coordinator?.setStreaming(this.props.streaming ?? false)
    if (previous.active === false && this.props.active !== false) {
      this.scrollToBottom()
    } else if (previous.target?.serial !== this.props.target?.serial && this.props.target) {
      if (this.coordinator) this.coordinator.navigate(this.props.target)
      else if (this.props.target.align === 'start') {
        const row = this.viewport.current!.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(this.props.target.message)}"]`)
        if (row) this.alignStart(row)
      }
    } else if (previous.target?.serial === this.props.target?.serial && previous.target?.pending !== this.props.target?.pending) {
      this.coordinator?.refresh()
    } else if (position === 'bottom') {
      this.write(this.viewport.current!.scrollHeight, 'bottom-update')
    } else if (position?.element.isConnected) {
      const delta = position.element.getBoundingClientRect().top - position.top
      if (Math.abs(delta) >= 0.5) this.write(this.viewport.current!.scrollTop + delta, 'row-update')
    }
    this.remember()
  }

  render() {
    return <TranscriptContext.Provider value={this.port}>
      <div ref={this.viewport} className={this.props.className} style={{ overflowAnchor: 'none' }}>{this.props.children}<div ref={this.spacer} aria-hidden="true" /></div>
    </TranscriptContext.Provider>
  }
}
