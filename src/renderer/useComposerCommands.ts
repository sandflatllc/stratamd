import { useId, useLayoutEffect, useState, type KeyboardEvent, type RefObject, type SyntheticEvent } from 'react'
import type { ProviderCommandSnapshot } from '../shared/provider-commands'
import type { CompactContextAction } from './useContextCompaction'
import { composerCommandItems, composerCommandQuery, replaceCommandQuery, type CommandQuery, type ComposerCommandItem } from './composerCommands'

export function useComposerCommands({ text, snapshot, compact, input, active, onOpenChange, onChange }: {
  text: string
  snapshot: ProviderCommandSnapshot | undefined
  compact: CompactContextAction
  input: RefObject<HTMLTextAreaElement | null>
  active: boolean
  onOpenChange(open: boolean): void
  onChange(text: string): void
}) {
  const listId = useId()
  const [query, setQuery] = useState<CommandQuery | null>(null)
  const [highlight, setHighlight] = useState<string | null>(null)
  const [caret, setCaret] = useState<number | null>(null)
  const items = query ? composerCommandItems(snapshot, query) : []
  const preferred = query?.query ? items.find(item => item.name.toLowerCase() === query.query.toLowerCase()) ?? items[0] : items.find(item => item.kind === 'skill') ?? items[0]
  const selected = items.find(item => item.id === highlight) ?? preferred
  const close = () => onOpenChange(false)
  const updateSelection = (event: SyntheticEvent<HTMLTextAreaElement>) => {
    const element = event.currentTarget
    const next = composerCommandQuery(element.value, element.selectionStart, element.selectionEnd)
    if (next?.query !== query?.query || next?.from !== query?.from) setHighlight(null)
    setQuery(next); onOpenChange(next !== null)
  }
  useLayoutEffect(() => {
    if (caret === null || !input.current) return
    input.current.focus(); input.current.setSelectionRange(caret, caret); setCaret(null)
  }, [caret, input])
  const select = (item: ComposerCommandItem) => {
    if (!query) return
    // The same action as the context meter owns capability, in-flight and failure state.
    const immediate = item.kind === 'command' && item.name === compact.name
    if (immediate && compact.disabledReason) return
    const replacement = replaceCommandQuery(text, query, immediate ? '' : item.token)
    onChange(replacement.text); setCaret(replacement.caret); setQuery(null); setHighlight(null); close()
    if (immediate) void compact.execute()
  }
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!active || event.nativeEvent.isComposing) return false
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return true }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); event.stopPropagation()
      const index = items.findIndex(item => item.id === selected?.id)
      if (items.length) setHighlight(items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]!.id)
      return true
    }
    if (event.key === 'Tab' && (event.shiftKey || !selected || selected.kind === 'command' && selected.name === compact.name && compact.disabledReason)) { close(); return false }
    if (event.key === 'Enter' && !selected) { close(); return false }
    if ((event.key === 'Enter' && !event.shiftKey) || (event.key === 'Tab' && selected)) {
      event.preventDefault(); event.stopPropagation()
      if (selected) select(selected)
      return true
    }
    return false
  }
  return { listId, query, items, selectedId: selected?.id, select, updateSelection, handleKeyDown, close,
    clearSearch() {
      if (!query) return
      const replacement = replaceCommandQuery(text, query, query.skillsOnly ? '$' : '/')
      // A bare trigger remains open, with the caret directly after it.
      const next = replacement.text.slice(0, replacement.caret - 1) + replacement.text.slice(replacement.caret)
      onChange(next); setCaret(replacement.caret - 1); setQuery({ ...query, to: query.from + 1, query: '' }); setHighlight(null)
    },
  }
}
