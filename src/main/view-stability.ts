/**
 * Returns the previous value whenever the next value is deep-equal to it, and
 * otherwise rebuilds the next value reusing every unchanged child. Published
 * views keep stable object identity for unchanged sections, so "did this
 * section change" is a pointer comparison and never a guess.
 */
export function stableValue<T>(previous: T, next: T): T {
  if (Object.is(previous, next)) return next
  if (previous === null || next === null || typeof previous !== 'object' || typeof next !== 'object') return next
  if (Array.isArray(previous) !== Array.isArray(next)) return next
  if (Array.isArray(next)) {
    const previousItems = previous as readonly unknown[]
    const merged = (next as readonly unknown[]).map((item, index) =>
      index < previousItems.length ? stableValue(previousItems[index], item) : item,
    )
    const identical = merged.length === previousItems.length
      && merged.every((item, index) => item === previousItems[index])
    return (identical ? previous : merged) as T
  }
  const previousRecord = previous as Record<string, unknown>
  const nextRecord = next as Record<string, unknown>
  const keys = Object.keys(nextRecord)
  const merged: Record<string, unknown> = {}
  let identical = keys.length === Object.keys(previousRecord).length
  for (const key of keys) {
    const value = key in previousRecord ? stableValue(previousRecord[key], nextRecord[key]) : nextRecord[key]
    merged[key] = value
    if (!Object.is(value, previousRecord[key])) identical = false
  }
  return (identical ? previous : merged) as T
}

const lineStartsCache: { text: string; starts: number[] }[] = []

function lineStartsOf(text: string): number[] {
  for (const entry of lineStartsCache) {
    if (entry.text.length === text.length && entry.text === text) return entry.starts
  }
  const starts = [0]
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') starts.push(index + 1)
  }
  if (lineStartsCache.length >= 8) lineStartsCache.shift()
  lineStartsCache.push({ text, starts })
  return starts
}

export function lineAt(text: string, offset: number): number {
  const starts = lineStartsOf(text)
  let low = 0
  let high = starts.length - 1
  while (low < high) {
    const middle = (low + high + 1) >> 1
    if (starts[middle]! <= offset) low = middle
    else high = middle - 1
  }
  return low + 1
}
