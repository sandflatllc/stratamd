import { Component, createRef, type ReactNode } from 'react'

interface Props { active?: boolean; navigation?: number | undefined; className: string; children: ReactNode }
type ReadingPosition = 'top' | { element: HTMLElement; top: number; scrollTop: number }

/** Capture before React changes the DOM, so prepended messages cannot move the reader. */
export class ConversationHistory extends Component<Props, Record<string, never>, ReadingPosition | null> {
  private viewport = createRef<HTMLDivElement>()
  private observer: ResizeObserver | undefined
  private mutation: MutationObserver | undefined
  private position: ReadingPosition | null = null
  private remember = () => { this.position = this.capturePosition() }

  componentDidMount() {
    const viewport = this.viewport.current!
    let visible = viewport.clientHeight > 0
    this.observer = new ResizeObserver(() => {
      const nextVisible = viewport.clientHeight > 0
      if (nextVisible && !visible) viewport.scrollTop = 0
      visible = nextVisible
      if (this.position !== 'top' && this.position?.element.isConnected && Math.abs(viewport.scrollTop - this.position.scrollTop) < 1) viewport.scrollTop += this.position.element.getBoundingClientRect().top - this.position.top
      this.remember()
    })
    this.observer.observe(viewport)
    const observeRows = () => { for (const row of viewport.querySelectorAll('[data-history-row]')) this.observer?.observe(row) }
    observeRows()
    this.mutation = new MutationObserver(observeRows)
    this.mutation.observe(viewport, { childList: true, subtree: true })
    viewport.addEventListener('scroll', this.remember, { passive: true })
    this.remember()
  }

  componentWillUnmount() { this.observer?.disconnect(); this.mutation?.disconnect(); this.viewport.current?.removeEventListener('scroll', this.remember) }

  getSnapshotBeforeUpdate(previous: Props): ReadingPosition | null {
    return previous.navigation !== this.props.navigation ? null : this.capturePosition()
  }

  private capturePosition(): ReadingPosition | null {
    const viewport = this.viewport.current!
    if (!viewport.clientHeight) return null
    if (viewport.scrollTop <= 1) return 'top'
    const top = viewport.getBoundingClientRect().top
    const element = Array.from(viewport.querySelectorAll<HTMLElement>('[data-history-row]'))
      .find((row) => row.getBoundingClientRect().bottom > top)
    return element ? { element, top: element.getBoundingClientRect().top, scrollTop: viewport.scrollTop } : null
  }

  componentDidUpdate(_previous: Props, _state: Record<string, never>, position: ReadingPosition | null) {
    if (_previous.active === false && this.props.active !== false) {
      this.viewport.current!.scrollTop = 0
    } else if (position === 'top') {
      this.viewport.current!.scrollTop = 0
    } else if (position?.element.isConnected) {
      this.viewport.current!.scrollTop += position.element.getBoundingClientRect().top - position.top
    }
    this.remember()
  }

  render() {
    return <div ref={this.viewport} className={this.props.className} style={{ overflowAnchor: 'none' }}>{this.props.children}</div>
  }
}
