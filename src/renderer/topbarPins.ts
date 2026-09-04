import type { DocumentTabView } from '../shared/contracts'

// The top bar (PRD §6.9, decided 2026-09-04) shows pinned documents and
// conversations as pills, the active one of each kind as a pill, and every
// other open item inside a Docs or Conversations dropdown. Pins are a
// preference of this window, kept in local storage; they never decide what is
// open. A pinned item that closes leaves the bar, and pins again when reopened.

export interface TopBarPins {
  documents: string[]
  conversations: string[]
}

export interface ConversationTabView {
  id: string
  name: string
  attention: number
  active: boolean
}

export interface StripGroup<T> {
  /** Pinned items in pin order, then the active item when it is not pinned. */
  pills: T[]
  /** Every open item in opening order, for the dropdown. */
  menu: T[]
  /** True while the active item shows as a pill (pinned or not). */
  activeShown: boolean
}

export interface TopBarStrip {
  documents: StripGroup<DocumentTabView>
  conversations: StripGroup<ConversationTabView>
}

export const PINS_KEY = 'stratamd.topbar-pins.v1'
const EMPTY: TopBarPins = { documents: [], conversations: [] }

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
}

export function readPins(storage: Pick<Storage, 'getItem'> | null = typeof localStorage === 'undefined' ? null : localStorage): TopBarPins {
  if (!storage) return EMPTY
  try {
    const value = JSON.parse(storage.getItem(PINS_KEY) ?? 'null') as Record<string, unknown> | null
    if (!value || typeof value !== 'object') return EMPTY
    return { documents: strings(value.documents), conversations: strings(value.conversations) }
  } catch {
    return EMPTY
  }
}

export function writePins(pins: TopBarPins, storage: Pick<Storage, 'setItem'> | null = typeof localStorage === 'undefined' ? null : localStorage): void {
  try { storage?.setItem(PINS_KEY, JSON.stringify(pins)) } catch { /* a full or disabled store loses only pins */ }
}

export function togglePin(pins: TopBarPins, kind: 'document' | 'conversation', id: string): TopBarPins {
  const key = kind === 'document' ? 'documents' : 'conversations'
  const current = pins[key]
  const next = current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]
  return { ...pins, [key]: next }
}

export function isPinned(pins: TopBarPins, kind: 'document' | 'conversation', id: string): boolean {
  return (kind === 'document' ? pins.documents : pins.conversations).includes(id)
}

function group<T>(items: readonly T[], pinnedIds: readonly string[], idOf: (item: T) => string, isActive: (item: T) => boolean): StripGroup<T> {
  const byId = new Map(items.map((item) => [idOf(item), item]))
  const pills = pinnedIds.flatMap((id) => { const item = byId.get(id); return item ? [item] : [] })
  const active = items.find(isActive)
  if (active && !pinnedIds.includes(idOf(active))) pills.push(active)
  return { pills, menu: [...items], activeShown: active !== undefined }
}

/** Lays the strip out: which items are pills and which live only in a dropdown. */
export function arrangeStrip(tabs: readonly DocumentTabView[], conversations: readonly ConversationTabView[], pins: TopBarPins, conversationActive: boolean): TopBarStrip {
  return {
    // A document is active only when no conversation holds the center.
    documents: group(tabs, pins.documents, (tab) => tab.path, (tab) => tab.active && !conversationActive),
    conversations: group(conversations, pins.conversations, (tab) => tab.id, (tab) => tab.active),
  }
}
