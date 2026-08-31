import type { AppView, DocumentView } from './contracts'

/**
 * One engine-to-window state update. Either a complete view (`full`) or a
 * patch listing only the sections that changed since `base`. A patch never
 * guesses: the encoder diffs against the exact view it last sent, and the
 * window applies a patch only when `base` matches the seq it holds —
 * anything else triggers a full resync, so the worst case is one extra
 * full message, never a stale screen.
 */
export interface SyncedView {
  seq: number
  view: AppView
}

export interface ViewUpdate {
  seq: number
  full?: AppView
  base?: number
  sections?: {
    tabs?: AppView['tabs']
    explorer?: AppView['explorer']
    settings?: AppView['settings']
    activeDocument?: ActiveDocumentSection | null
  }
  /** Present in verify mode: the complete view the merged result must equal. */
  verify?: AppView
}

export interface ContentSplice {
  /** Bytes kept from the start and end of the previous content. */
  prefix: number
  suffix: number
  insert: string
  /** Expected length of the spliced result; any mismatch forces a resync. */
  length: number
}

export interface ActiveDocumentSection {
  document: Omit<DocumentView, 'content'>
  content: { text: string } | { unchanged: true } | { splice: ContentSplice }
}

/** Longest common prefix and suffix, so one edit region travels instead of the document. */
export function spliceContent(previous: string, next: string): ContentSplice {
  const shortest = Math.min(previous.length, next.length)
  let prefix = 0
  while (prefix < shortest && previous[prefix] === next[prefix]) prefix += 1
  let suffix = 0
  while (suffix < shortest - prefix && previous[previous.length - 1 - suffix] === next[next.length - 1 - suffix]) {
    suffix += 1
  }
  return { prefix, suffix, insert: next.slice(prefix, next.length - suffix), length: next.length }
}

export function applyContentSplice(previous: string, splice: ContentSplice): string | null {
  if (splice.prefix + splice.suffix > previous.length) return null
  const result = previous.slice(0, splice.prefix) + splice.insert + previous.slice(previous.length - splice.suffix)
  return result.length === splice.length ? result : null
}

export function encodeViewUpdate(previous: SyncedView | null, seq: number, next: AppView, verify: boolean): ViewUpdate {
  if (previous === null) return { seq, full: next }
  const sections: NonNullable<ViewUpdate['sections']> = {}
  if (next.tabs !== previous.view.tabs) sections.tabs = next.tabs
  if (next.explorer !== previous.view.explorer) sections.explorer = next.explorer
  if (next.settings !== previous.view.settings) sections.settings = next.settings
  if (next.activeDocument !== previous.view.activeDocument) {
    if (next.activeDocument === null) {
      sections.activeDocument = null
    } else {
      const { content, ...document } = next.activeDocument
      const previousContent = previous.view.activeDocument?.content
      let encoded: ActiveDocumentSection['content']
      if (previousContent === content) {
        encoded = { unchanged: true }
      } else if (previousContent === undefined) {
        encoded = { text: content }
      } else {
        const splice = spliceContent(previousContent, content)
        encoded = splice.insert.length < content.length / 2 ? { splice } : { text: content }
      }
      sections.activeDocument = { document, content: encoded }
    }
  }
  return { seq, base: previous.seq, sections, ...(verify ? { verify: next } : {}) }
}

export type ApplyResult =
  | { status: 'applied'; synced: SyncedView }
  | { status: 'resync' }

export function applyViewUpdate(current: SyncedView | null, update: ViewUpdate): ApplyResult {
  if (update.full !== undefined) {
    return { status: 'applied', synced: { seq: update.seq, view: update.full } }
  }
  if (current === null || update.base !== current.seq || update.sections === undefined) {
    return { status: 'resync' }
  }
  const sections = update.sections
  let activeDocument = current.view.activeDocument
  if ('activeDocument' in sections) {
    const section = sections.activeDocument
    if (section === null || section === undefined) {
      activeDocument = null
    } else if ('text' in section.content) {
      activeDocument = { ...section.document, content: section.content.text }
    } else if (current.view.activeDocument === null) {
      return { status: 'resync' }
    } else if ('splice' in section.content) {
      const spliced = applyContentSplice(current.view.activeDocument.content, section.content.splice)
      if (spliced === null) return { status: 'resync' }
      activeDocument = { ...section.document, content: spliced }
    } else {
      activeDocument = { ...section.document, content: current.view.activeDocument.content }
    }
  }
  const view: AppView = {
    tabs: sections.tabs ?? current.view.tabs,
    explorer: sections.explorer ?? current.view.explorer,
    settings: sections.settings ?? current.view.settings,
    activeDocument,
  }
  return { status: 'applied', synced: { seq: update.seq, view } }
}

export function sameJson(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false
  if (Array.isArray(left) !== Array.isArray(right)) return false
  const leftRecord = left as Record<string, unknown>
  const rightRecord = right as Record<string, unknown>
  const keys = Object.keys(leftRecord)
  if (keys.length !== Object.keys(rightRecord).length) return false
  return keys.every((key) => key in rightRecord && sameJson(leftRecord[key], rightRecord[key]))
}

export function isViewUpdate(value: unknown): value is ViewUpdate {
  if (!value || typeof value !== 'object') return false
  const update = value as Partial<ViewUpdate>
  if (typeof update.seq !== 'number') return false
  if (update.full !== undefined) return true
  return typeof update.base === 'number' && typeof update.sections === 'object' && update.sections !== null
}
