import { createHash } from 'node:crypto'
import { structuredPatch } from 'diff'

export interface TextRange {
  from: number
  to: number
}

export interface TextEdit extends TextRange {
  insert: string
}

/** A zero-context Myers line hunk with offsets in both inputs. */
export interface TextHunk {
  oldStartLine: number
  newStartLine: number
  removedLines: number
  addedLines: number
  before: TextRange
  after: TextRange
  removed: string
  added: string
}

export function contentHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

function lineStarts(text: string): number[] {
  const starts = [0]
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') starts.push(index + 1)
  }
  if (starts.at(-1) !== text.length) starts.push(text.length)
  return starts
}

function lineOffset(starts: readonly number[], lineIndex: number, textLength: number): number {
  if (lineIndex <= 0) return 0
  return starts[lineIndex] ?? textLength
}

/**
 * Computes deterministic, contiguous line hunks. jsdiff's structuredPatch uses
 * its Myers implementation; context is deliberately zero so adjacent changes
 * are not widened by presentation context.
 */
export function computeHunks(before: string, after: string): TextHunk[] {
  const patch = structuredPatch('before', 'after', before, after, undefined, undefined, {
    context: 0,
  })
  const beforeStarts = lineStarts(before)
  const afterStarts = lineStarts(after)

  return patch.hunks.map((hunk) => {
    const beforeFrom = lineOffset(beforeStarts, hunk.oldStart - 1, before.length)
    const beforeTo = lineOffset(beforeStarts, hunk.oldStart - 1 + hunk.oldLines, before.length)
    const afterFrom = lineOffset(afterStarts, hunk.newStart - 1, after.length)
    const afterTo = lineOffset(afterStarts, hunk.newStart - 1 + hunk.newLines, after.length)

    return {
      oldStartLine: hunk.oldStart,
      newStartLine: hunk.newStart,
      removedLines: hunk.oldLines,
      addedLines: hunk.newLines,
      before: { from: beforeFrom, to: beforeTo },
      after: { from: afterFrom, to: afterTo },
      removed: before.slice(beforeFrom, beforeTo),
      added: after.slice(afterFrom, afterTo),
    }
  })
}

export function applyTextEdit(text: string, edit: TextEdit): string {
  assertRange(edit, text.length)
  return text.slice(0, edit.from) + edit.insert + text.slice(edit.to)
}

/** Applies hunks produced from the same source text. */
export function applyHunks(source: string, hunks: readonly TextHunk[]): string {
  let result = source
  for (const hunk of [...hunks].sort((left, right) => right.before.from - left.before.from)) {
    if (source.slice(hunk.before.from, hunk.before.to) !== hunk.removed) {
      throw new Error('Hunk does not match its source text')
    }
    result = applyTextEdit(result, {
      from: hunk.before.from,
      to: hunk.before.to,
      insert: hunk.added,
    })
  }
  return result
}

export function reverseHunks(source: string, hunks: readonly TextHunk[]): string {
  let result = source
  for (const hunk of [...hunks].sort((left, right) => right.after.from - left.after.from)) {
    if (source.slice(hunk.after.from, hunk.after.to) !== hunk.added) {
      throw new Error('Hunk does not match its source text')
    }
    result = applyTextEdit(result, {
      from: hunk.after.from,
      to: hunk.after.to,
      insert: hunk.removed,
    })
  }
  return result
}

export function rangesTouch(left: TextRange, right: TextRange): boolean {
  if (left.from === left.to) return right.from <= left.from && left.from <= right.to
  if (right.from === right.to) return left.from <= right.from && right.from <= left.to
  return left.from < right.to && right.from < left.to
}

export function rangeContains(outer: TextRange, inner: TextRange): boolean {
  return outer.from <= inner.from && inner.to <= outer.to
}

/** Maps a position through one replacement, matching ProseMirror-style association. */
export function mapPosition(position: number, edit: TextEdit, association: -1 | 1): number {
  const insertedEnd = edit.from + edit.insert.length
  if (position < edit.from) return position
  if (position > edit.to) return position + edit.insert.length - (edit.to - edit.from)
  if (edit.from !== edit.to) {
    if (position === edit.from) return edit.from
    if (position === edit.to) return insertedEnd
  }
  if (position === edit.from && association < 0) return edit.from
  if (position === edit.to && association > 0) return insertedEnd
  return association < 0 ? edit.from : insertedEnd
}

/** Boundary insertions join the range, which is how review marks stay attached. */
export function mapRange(range: TextRange, edit: TextEdit): TextRange {
  return {
    from: mapPosition(range.from, edit, -1),
    to: mapPosition(range.to, edit, 1),
  }
}

/** Maps an offset in the old side of a diff to the corresponding new offset. */
export function mapOldPositionToNew(
  position: number,
  hunks: readonly TextHunk[],
  association: -1 | 1,
): number {
  let mapped = position
  for (const hunk of hunks) {
    if (position < hunk.before.from) break
    if (position > hunk.before.to) {
      mapped += hunk.added.length - hunk.removed.length
      continue
    }
    if (hunk.before.from !== hunk.before.to) {
      if (position === hunk.before.from) return hunk.after.from
      if (position === hunk.before.to) return hunk.after.to
    }
    if (position === hunk.before.from && association < 0) return hunk.after.from
    if (position === hunk.before.to && association > 0) return hunk.after.to
    return association < 0 ? hunk.after.from : hunk.after.to
  }
  return mapped
}

export function mapOldRangeToNew(range: TextRange, hunks: readonly TextHunk[]): TextRange {
  return {
    from: mapOldPositionToNew(range.from, hunks, -1),
    to: mapOldPositionToNew(range.to, hunks, 1),
  }
}

/** Maps an offset in the new side of a diff back to the old side. */
export function mapNewPositionToOld(
  position: number,
  hunks: readonly TextHunk[],
  association: -1 | 1,
): number {
  let mapped = position
  for (const hunk of hunks) {
    if (position < hunk.after.from) break
    if (position > hunk.after.to) {
      mapped += hunk.removed.length - hunk.added.length
      continue
    }
    if (hunk.after.from !== hunk.after.to) {
      if (position === hunk.after.from) return hunk.before.from
      if (position === hunk.after.to) return hunk.before.to
    }
    if (position === hunk.after.from && association < 0) return hunk.before.from
    if (position === hunk.after.to && association > 0) return hunk.before.to
    return association < 0 ? hunk.before.from : hunk.before.to
  }
  return mapped
}

export function mapNewRangeToOld(range: TextRange, hunks: readonly TextHunk[]): TextRange {
  return {
    from: mapNewPositionToOld(range.from, hunks, -1),
    to: mapNewPositionToOld(range.to, hunks, 1),
  }
}

export function assertRange(range: TextRange, textLength: number): void {
  if (
    !Number.isInteger(range.from) ||
    !Number.isInteger(range.to) ||
    range.from < 0 ||
    range.to < range.from ||
    range.to > textLength
  ) {
    throw new RangeError(`Invalid text range ${range.from}..${range.to} for length ${textLength}`)
  }
}
