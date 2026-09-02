import type { BufferOrigin } from '../shared/contracts'

// The newest editor content waiting for its 180 ms mirror to main lives here,
// outside React, so a root-level crash that unmounts App cannot take it down
// (docs/plans/completed/crash-hardening-plan.md §2). App owns the debounce timer; this module
// owns the value and the flush.

export interface PendingBuffer {
  path: string
  content: string
  origin: BufferOrigin
}

let pending: PendingBuffer | null = null

// The newest content handed to main per path, recorded when the flush starts
// (§5.3). A view push that equals it is this editor's own echo, not news.
const lastFlushed = new Map<string, string>()

export function lastFlushedContent(path: string): string | undefined {
  return lastFlushed.get(path)
}

/** Drop flush records for documents that are no longer open. */
export function forgetFlushed(openPaths: ReadonlySet<string>): void {
  for (const path of lastFlushed.keys()) if (!openPaths.has(path)) lastFlushed.delete(path)
}

export function setPendingBuffer(next: PendingBuffer): void {
  pending = next
}

export function peekPendingBuffer(): PendingBuffer | null {
  return pending
}

export function takePendingBuffer(): PendingBuffer | null {
  const taken = pending
  pending = null
  return taken
}

/**
 * Push whatever is pending to main. A failure puts the value back and
 * rethrows; callers on error paths (the root boundary) must catch.
 */
export async function flushPendingBuffer(): Promise<void> {
  const taken = takePendingBuffer()
  if (!taken) return
  lastFlushed.set(taken.path, taken.content)
  try {
    await window.strata.updateBuffer(taken.path, taken.content, taken.origin)
  } catch (error) {
    pending = pending ?? taken
    throw error
  }
}
