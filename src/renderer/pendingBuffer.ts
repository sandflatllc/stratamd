import type { BufferOrigin, BufferBlockRange, PrepareBufferBlockRanges } from '../shared/contracts'

// The newest editor content waiting for its 180 ms mirror to main lives here,
// outside React, so a root-level crash that unmounts App cannot take it down
// (docs/plans/completed/crash-hardening-plan.md §2). App owns the debounce timer; this module
// owns the value and the flush.

export interface PendingBuffer {
  path: string
  content: string
  origin: BufferOrigin
  prepareBlockRanges?: PrepareBufferBlockRanges
}

let pending: PendingBuffer | null = null

// Retain unacknowledged flushes, not just the newest one. An older push may
// reach React after a newer flush starts. Recognizing both keeps that older
// echo from replacing typing. Observing a newer echo releases earlier texts.
const lastFlushed = new Map<string, string[]>()

export function acknowledgeBufferEcho(path: string, content: string): boolean {
  const flushed = lastFlushed.get(path)
  const index = flushed?.lastIndexOf(content) ?? -1
  if (!flushed || index < 0) return false
  // Keep the matching value until a newer echo arrives, since views repeat it.
  flushed.splice(0, index)
  return true
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
  const flushed = lastFlushed.get(taken.path) ?? []
  if (flushed.at(-1) !== taken.content) flushed.push(taken.content)
  lastFlushed.set(taken.path, flushed)
  try {
    let blockRanges: readonly BufferBlockRange[] | undefined
    try { blockRanges = taken.prepareBlockRanges?.() } catch (error) {
      // Optional metadata must never prevent crash recovery from saving text.
      console.warn(`StrataMD could not prepare block ranges for ${taken.path}; sending the buffer without ranges`, error)
    }
    await window.strata.updateBuffer(taken.path, taken.content, taken.origin, blockRanges)
  } catch (error) {
    pending = pending ?? taken
    throw error
  }
}
