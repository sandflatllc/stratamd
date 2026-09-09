import { useLayoutEffect, useRef } from 'react'
import type { ComposerCommandItem } from '../composerCommands'
import type { CompactContextAction } from '../useContextCompaction'
import './composer-commands.css'

export function commandOptionId(listId: string, id: string): string { return `${listId}-${encodeURIComponent(id)}` }
export function ComposerCommandMenu({ listId, items, selectedId, query, compact, available, onSelect, onClear }: {
  listId: string
  items: ComposerCommandItem[]
  selectedId: string | undefined
  query: string
  compact: CompactContextAction
  available: boolean
  onSelect(item: ComposerCommandItem): void
  onClear(): void
}) {
  const list = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => { list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }) }, [selectedId])
  if (!items.length) return <>
    <h3>{available ? 'No matching command or skill' : 'Commands and skills unavailable'}</h3>
    <p role="status">{available ? `No results for "${query}". Try another name.` : 'This agent has not reported commands or skills for this workspace.'}</p>
    {query && <button type="button" onClick={onClear}>Clear search</button>}
  </>
  return <>
    <div ref={list} role="listbox" id={listId} aria-label="Commands and skills">
      {(['command', 'skill'] as const).map(kind => {
        const entries = items.filter(item => item.kind === kind)
        return entries.length > 0 && <div role="group" aria-label={kind === 'command' ? 'Commands' : 'Skills'} key={kind}>
          <h3>{kind === 'command' ? 'Commands' : 'Skills'}</h3>
          {entries.map(item => {
            const immediate = item.kind === 'command' && item.name === compact.name
            const disabled = immediate ? compact.disabledReason : null
            return <button type="button" role="option" id={commandOptionId(listId, item.id)} key={item.id} aria-selected={item.id === selectedId} aria-disabled={Boolean(disabled)} title={disabled ?? undefined} onMouseDown={event => event.preventDefault()} onClick={() => onSelect(item)}>
              <span><strong>{item.kind === 'skill' ? '$' : '/'}{item.name}</strong><small>{disabled ?? (immediate ? compact.description : item.description)}</small></span><kbd aria-hidden="true">↵</kbd>
            </button>
          })}
        </div>
      })}
    </div>
    <p>Skills are inserted into your draft. Nothing is sent yet.</p>
  </>
}
