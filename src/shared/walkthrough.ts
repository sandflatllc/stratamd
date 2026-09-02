import type { HeadingReference } from './contracts'

export interface HeadingLike {
  level: number
  text: string
}

export interface ReferencedHeading<T extends HeadingLike = HeadingLike> {
  heading: T
  reference: HeadingReference
}

export function normalizeHeadingText(text: string): string {
  return text.trim().replace(/\s+/gu, ' ')
}

export function referenceKey(reference: HeadingReference): string {
  return JSON.stringify(reference)
}

export function referencedHeadings<T extends HeadingLike>(headings: readonly T[]): Array<ReferencedHeading<T>> {
  const normalized = headings.map((heading) => normalizeHeadingText(heading.text))
  const output: Array<ReferencedHeading<T>> = []
  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index]!
    if (heading.level < 1 || heading.level > 6) continue
    let parentText: string | null = null
    for (let parent = index - 1; parent >= 0; parent -= 1) {
      if (headings[parent]!.level < heading.level) {
        parentText = normalized[parent] ?? null
        break
      }
    }
    output.push({
      heading,
      reference: {
        level: heading.level as HeadingReference['level'],
        text: normalized[index]!,
        parentText,
        previousText: index > 0 ? normalized[index - 1]! : null,
        nextText: index + 1 < headings.length ? normalized[index + 1]! : null,
      },
    })
  }
  return output
}

export function referencedWalkthroughHeadings<T extends HeadingLike>(headings: readonly T[]): Array<ReferencedHeading<T>> {
  return referencedHeadings(headings).filter(({ reference }) => reference.level === 2 || reference.level === 3)
}

/** Relocate only when context or uniqueness identifies exactly one heading. */
export function resolveHeadingReference<T extends HeadingLike>(reference: HeadingReference, headings: readonly T[]): ReferencedHeading<T> | null {
  const referenced = referencedHeadings(headings)
  const base = referenced.filter(({ reference: candidate }) => candidate.level === reference.level && candidate.text === normalizeHeadingText(reference.text))
  if (base.length === 1) return base[0]!
  const exact = base.filter(({ reference: candidate }) =>
    candidate.parentText === reference.parentText
    && candidate.previousText === reference.previousText
    && candidate.nextText === reference.nextText,
  )
  return exact.length === 1 ? exact[0]! : null
}
