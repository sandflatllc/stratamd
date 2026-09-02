import { useEffect, useRef } from 'react'
import { findCountLabel, type FindResult } from '../../editor/find'
import { claimEscape } from '../escape'

interface FindBarProps {
  query: string
  result: FindResult
  /** Bumped to pull focus back into the field while the bar is already open. */
  focusToken: number
  onQuery(query: string): void
  onStep(direction: 1 | -1): void
  onClose(): void
}

/** The find bar (PRD §6.1): Enter and Shift+Enter step, Escape closes and hands focus back to the editor. */
export function FindBar({ query, result, focusToken, onQuery, onStep, onClose }: FindBarProps) {
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [focusToken])
  return (
    <div className="find-bar" role="search" aria-label="Find in document">
      <input
        ref={input}
        value={query}
        placeholder="Find…"
        aria-label="Find in document"
        spellCheck={false}
        onChange={(event) => onQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            onStep(event.shiftKey ? -1 : 1)
          } else if (event.key === 'Escape') {
            claimEscape(event.nativeEvent)
            onClose()
          }
        }}
      />
      <span className="find-count" aria-live="polite">{findCountLabel(query, result)}</span>
      <button type="button" aria-label="Previous match" title="Previous match · Shift+Enter" onClick={() => onStep(-1)}>↑</button>
      <button type="button" aria-label="Next match" title="Next match · Enter" onClick={() => onStep(1)}>↓</button>
      <button type="button" aria-label="Close find" title="Close · Esc" onClick={onClose}>×</button>
    </div>
  )
}
