import { Component, useState, type ErrorInfo, type ReactNode } from 'react'
import { flushPendingBuffer } from '../pendingBuffer'
import { sendErrorReport } from '../reportError'

// Containment for renderer failures (docs/plans/completed/crash-hardening-plan.md §3): a
// crash degrades to a card instead of unmounting the root. Mounted around
// <App> (root) and around each pane's contents. React requires a class here.

interface BoundaryProps {
  region: string
  /** The root boundary flushes the pending buffer so the card's promise holds. */
  root?: boolean
  children: ReactNode
}

interface BoundaryState {
  failed: boolean
}

export class Boundary extends Component<BoundaryProps, BoundaryState> {
  override state: BoundaryState = { failed: false }

  static getDerivedStateFromError(): BoundaryState {
    return { failed: true }
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    // The boundary is the one reporting owner for caught errors (§3); the
    // root's onCaughtError stays silent so nothing is recorded twice.
    if (this.props.root) void flushPendingBuffer().catch(() => undefined)
    const named = error instanceof Error ? error : undefined
    sendErrorReport(
      `boundary:${this.props.region}`,
      named?.message ?? String(error),
      named?.stack,
      info.componentStack ?? undefined
    )
  }

  readonly reload = async (): Promise<void> => {
    if (this.props.root) {
      // Bounded: a dead IPC channel must not wedge recovery.
      await Promise.race([
        flushPendingBuffer().catch(() => undefined),
        new Promise((resolve) => window.setTimeout(resolve, 1_000))
      ])
    }
    window.location.reload()
  }

  override render(): ReactNode {
    if (this.state.failed) {
      return (
        <div className="boundary-card" role="alert">
          <p>
            {this.props.root
              ? 'StrataMD hit a problem showing this window. Your documents and pending changes are safe.'
              : 'This part of the window hit a problem. Your document and its pending changes are safe.'}
          </p>
          <button type="button" onClick={() => void this.reload()}>Reload</button>
        </div>
      )
    }
    return (
      <>
        <CrashProbe region={this.props.region} />
        {this.props.children}
      </>
    )
  }
}

// The test seam (§4): a boundary cannot catch its own render, so the probe is
// a child that throws on the render after its hidden button is clicked. The
// preload exposes the flag; absent it, nothing renders.
function CrashProbe({ region }: { region: string }) {
  const [armed, setArmed] = useState(false)
  if ((globalThis as { strataCrashProbe?: unknown }).strataCrashProbe !== '1') return null
  if (armed) throw new Error(`Crash probe: ${region}`)
  return (
    <button type="button" className="crash-probe" onClick={() => setArmed(true)}>
      {`Crash probe: ${region}`}
    </button>
  )
}
