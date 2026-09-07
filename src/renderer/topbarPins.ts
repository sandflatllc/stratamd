import { engineStorage } from './engineStorage'

// Pins sort open items to the top of each dropdown. They are a window
// preference and never determine which items are open.
export type PinKind = 'document' | 'conversation' | 'preview'
const PIN_KEYS = { document: 'documents', conversation: 'conversations', preview: 'previews' } as const

export interface TopBarPins {
  documents: string[]
  conversations: string[]
  previews: string[]
}

export interface ConversationTabView {
  id: string
  name: string
  attention: number
  active: boolean
}

export const PINS_KEY = 'stratamd.topbar-pins.v1'
const EMPTY: TopBarPins = { documents: [], conversations: [], previews: [] }

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
}

export function readPins(storage: Pick<Storage, 'getItem'> | null = typeof localStorage === 'undefined' ? null : engineStorage): TopBarPins {
  if (!storage) return EMPTY
  try {
    const value = JSON.parse(storage.getItem(PINS_KEY) ?? 'null') as Record<string, unknown> | null
    if (!value || typeof value !== 'object') return EMPTY
    return { documents: strings(value.documents), conversations: strings(value.conversations), previews: strings(value.previews) }
  } catch {
    return EMPTY
  }
}

export function writePins(pins: TopBarPins, storage: Pick<Storage, 'setItem'> | null = typeof localStorage === 'undefined' ? null : engineStorage): void {
  try { storage?.setItem(PINS_KEY, JSON.stringify(pins)) } catch { /* a full or disabled store loses only pins */ }
}

export function togglePin(pins: TopBarPins, kind: PinKind, id: string): TopBarPins {
  const key = PIN_KEYS[kind]
  const current = pins[key]
  const next = current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]
  return { ...pins, [key]: next }
}

export function isPinned(pins: TopBarPins, kind: PinKind, id: string): boolean {
  return pins[PIN_KEYS[kind]].includes(id)
}

/** Pinned items in pin order, then the remaining open items in opening order. */
export function orderPinned<T extends { id: string }>(items: readonly T[], pins: TopBarPins, kind: PinKind): T[] {
  const ids = pins[PIN_KEYS[kind]]
  const byId = new Map(items.map((item) => [item.id, item]))
  const pinned = new Set(ids)
  return [...ids.flatMap((id) => { const item = byId.get(id); return item ? [item] : [] }), ...items.filter((item) => !pinned.has(item.id))]
}
