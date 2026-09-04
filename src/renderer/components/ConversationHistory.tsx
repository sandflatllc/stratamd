import { Component, createRef, type ReactNode } from 'react'

interface Props { className: string; children: ReactNode }
type ReadingPosition = 'top' | { element: HTMLElement; top: number }

/** Capture before React changes the DOM, so prepended messages cannot move the reader. */
export class ConversationHistory extends Component<Props, Record<string, never>, ReadingPosition | null> {
  private viewport = createRef<HTMLDivElement>()
  private observer: ResizeObserver | undefined

  componentDidMount() {
    const viewport = this.viewport.current!
    let visible = viewport.clientHeight > 0
    this.observer = new ResizeObserver(() => {
      const nextVisible = viewport.clientHeight > 0
      if (nextVisible && !visible) viewport.scrollTop = 0
      visible = nextVisible
    })
    this.observer.observe(viewport)
  }

  componentWillUnmount() { this.observer?.disconnect() }

  getSnapshotBeforeUpdate(): ReadingPosition | null {
    const viewport = this.viewport.current!
    if (!viewport.clientHeight) return null
    if (viewport.scrollTop <= 1) return 'top'
    const top = viewport.getBoundingClientRect().top
    const element = Array.from(viewport.querySelectorAll<HTMLElement>('[data-history-row]'))
      .find((row) => row.getBoundingClientRect().bottom > top)
    return element ? { element, top: element.getBoundingClientRect().top } : null
  }

  componentDidUpdate(_previous: Props, _state: Record<string, never>, position: ReadingPosition | null) {
    if (position === 'top') {
      this.viewport.current!.scrollTop = 0
    } else if (position?.element.isConnected) {
      this.viewport.current!.scrollTop += position.element.getBoundingClientRect().top - position.top
    }
  }

  render() {
    return <div ref={this.viewport} className={this.props.className} style={{ overflowAnchor: 'none' }}>{this.props.children}</div>
  }
}
