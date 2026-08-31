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
  try {
    await window.strata.updateBuffer(taken.path, taken.content, taken.origin)
  } catch (error) {
    pending = pending ?? taken
    throw error
  }
}
