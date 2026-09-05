import { Component, createRef, type ReactNode } from 'react'

interface Props { active?: boolean; navigation?: number | undefined; startMessage?: string | undefined; className: string; children: ReactNode }
type ReadingPosition = 'bottom' | { element: HTMLElement; top: number; scrollTop: number }

/** Follow the bottom, or preserve the visible row when messages and editors resize. */
export class ConversationHistory extends Component<Props, Record<string, never>, ReadingPosition | null> {
  private viewport = createRef<HTMLDivElement>()
  private spacer = createRef<HTMLDivElement>()
  private observer: ResizeObserver | undefined
  private mutation: MutationObserver | undefined
  private position: ReadingPosition | null = null
  private lastScrollTop = 0
  private remember = () => { this.position = this.capturePosition(); this.lastScrollTop = this.viewport.current!.scrollTop }

  scrollToBottom = () => {
    this.spacer.current!.style.height = '0px'
    this.viewport.current!.scrollTop = this.viewport.current!.scrollHeight
    this.remember()
  }

  private scrollToResponseStart() {
    const viewport = this.viewport.current!
    const row = viewport.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(this.props.startMessage!)}"]`)
    if (!row) return
    this.spacer.current!.style.height = '0px'
    const header = row.closest('.conversation-turn')?.querySelector('.conversation-exchange-header')
    const inset = (header?.getBoundingClientRect().height ?? 0) + Number.parseFloat(getComputedStyle(viewport).paddingTop)
    const top = viewport.scrollTop + row.getBoundingClientRect().top - viewport.getBoundingClientRect().top - inset
    // Short answers need room below them to reach the top. Leave a small gap
    // from the bottom so incoming text does not resume following while reading.
    this.spacer.current!.style.height = `${Math.max(0, top + viewport.clientHeight - viewport.scrollHeight + 32)}px`
    viewport.scrollTop = top
    this.position = null
    this.remember()
  }

  componentDidMount() {
    const viewport = this.viewport.current!
    let visible = viewport.clientHeight > 0
    this.scrollToBottom()
    this.observer = new ResizeObserver(() => {
      const nextVisible = viewport.clientHeight > 0
      if (nextVisible && !visible) this.scrollToBottom()
      visible = nextVisible
      if (this.position === 'bottom') {
        // A passage jump can run before its scroll event. Respect that move.
        if (this.capturePosition() === 'bottom') viewport.scrollTop = viewport.scrollHeight
      } else if (this.position?.element.isConnected && Math.abs(viewport.scrollTop - this.position.scrollTop) < 1) viewport.scrollTop += this.position.element.getBoundingClientRect().top - this.position.top
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

  componentWillUnmount() { this.observer?.disconnect(); this.mutation?.disconnect(); this.viewport.current?.removeEventListener('scroll', this.remember) }

  getSnapshotBeforeUpdate(previous: Props): ReadingPosition | null {
    return previous.navigation !== this.props.navigation ? null : this.capturePosition()
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
    if (previous.active === false && this.props.active !== false) {
      this.scrollToBottom()
    } else if (previous.navigation !== this.props.navigation && this.props.startMessage) {
      this.scrollToResponseStart()
    } else if (position === 'bottom') {
      this.viewport.current!.scrollTop = this.viewport.current!.scrollHeight
    } else if (position?.element.isConnected) {
      this.viewport.current!.scrollTop += position.element.getBoundingClientRect().top - position.top
    }
    this.remember()
  }

  render() {
    return <div ref={this.viewport} className={this.props.className} style={{ overflowAnchor: 'none' }}>{this.props.children}<div ref={this.spacer} aria-hidden="true" /></div>
  }
}
