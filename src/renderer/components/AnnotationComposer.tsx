import { useEffect, useRef, useState, type CSSProperties } from 'react'
import type { AnnotationKind, PanelSize, SpellingContext } from '../../shared/contracts'
import type { EditorSelection } from '../editorAdapter'
import { COMPOSER_LIMITS, spellingForSelection } from '../model'
import { claimEscape, isEscapeClaimed } from '../escape'
import { hasPrimaryModifier } from '../../shared/primary-modifier'

interface AnnotationComposerProps {
  selection: EditorSelection | null
  /** The latest right-click misspelling; shown only when it is exactly the selection. */
  spelling: SpellingContext | null
  /** Persisted size; height -1 keeps the default content sizing. */
  size: PanelSize
  /** The editor pane's zoom factor; body text tracks the editor's body size. */
  zoom: number
  onSize(size: PanelSize, commit: boolean): void
  onDismiss(): void
  onSubmit(kind: AnnotationKind, text: string, options?: string[]): void
  onReplaceWord(suggestion: string): void
  onAddToDictionary(word: string): void
  /** Edit actions on a right-click selection (§5.15). */
  onCut?(): void
  onCopy?(): void
  onPaste?(): void
  onSelectAll?(): void
}

/**
 * Whether the pill's bare C, Q, S, and D keys apply (§5.1): the selection came
 * from the pointer, or the pill itself has focus. A keyboard selection keeps
 * typing-to-replace, so an S over Shift+Arrow text replaces the text.
 */
export function bareHotkeysApply(selection: { pointer?: boolean } | null, pillHasFocus: boolean): boolean {
  if (!selection) return false
  return pillHasFocus || selection.pointer !== false
}

export function isAnnotationDismissKey(key: string): boolean {
  return key === 'Escape'
}

/**
 * True when the keystroke is headed into a text field outside the editor, which
 * owns its letters (the thread-panel reply, the send note). The editor's own
 * surfaces — the visual editor and the source textarea — keep the pill's
 * advertised C/Q/S keys.
 */
function claimedByTextField(target: EventTarget | null): boolean {
  if (!(target instanceof Element) || target.closest('[data-prosemirror-host]')) return false
  return target instanceof HTMLInputElement
    || target instanceof HTMLTextAreaElement
    || target instanceof HTMLSelectElement
    || (target instanceof HTMLElement && target.isContentEditable)
}

export function AnnotationComposer({ selection, spelling, size, zoom, onSize, onDismiss, onSubmit, onReplaceWord, onAddToDictionary, onCut, onCopy, onPaste, onSelectAll }: AnnotationComposerProps) {
  const [kind, setKind] = useState<AnnotationKind | null>(null)
  const [text, setText] = useState('')
  const [options, setOptions] = useState(['', ''])
  const textarea = useRef<HTMLTextAreaElement>(null)
  const form = useRef<HTMLFormElement>(null)
  const pill = useRef<HTMLDivElement>(null)

  useEffect(() => { setKind(selection?.annotationKind ?? null); setText(''); setOptions(['', '']) }, [selection])
  useEffect(() => { if (kind) textarea.current?.focus() }, [kind])
  useEffect(() => {
    if (!selection) return
    const key = (event: KeyboardEvent) => {
      if (isAnnotationDismissKey(event.key)) {
        // One surface per Escape (PRD §6.9): a thread panel that already took
        // this key keeps the pill up for the next one.
        if (isEscapeClaimed(event)) return
        claimEscape(event)
        onDismiss()
        return
      }
      if (kind) return
      // Bare letters only: Ctrl+C over the selection is the platform copy and
      // Ctrl+S the save, never the pill's hotkeys.
      if (event.ctrlKey || event.metaKey || event.altKey) return
      if (claimedByTextField(event.target)) return
      if (!bareHotkeysApply(selection, pill.current?.contains(document.activeElement) ?? false)) return
      const next = event.key.toLowerCase()
      if (next === 'c' || next === 'q' || next === 's' || next === 'd') {
        if (next === 's' && !selection.singleBlock) return
        event.preventDefault()
        setKind(next === 'c' ? 'comment' : next === 'q' ? 'question' : next === 's' ? 'suggestion' : 'decision')
      }
    }
    // Capture phase: the pill sits above the thread panel and the toast, which
    // both yield when Escape is already claimed.
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [kind, onDismiss, selection])

  const startResize = (event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    const bounds = form.current?.getBoundingClientRect()
    const origin = { x: event.clientX, y: event.clientY, width: bounds?.width ?? size.width, height: bounds?.height ?? 220 }
    let latest = size
    const move = (next: PointerEvent) => {
      latest = {
        width: Math.round(Math.max(COMPOSER_LIMITS.minWidth, Math.min(COMPOSER_LIMITS.maxWidth, origin.width + next.clientX - origin.x))),
        height: Math.round(Math.max(COMPOSER_LIMITS.minHeight, Math.min(COMPOSER_LIMITS.maxHeight, origin.height + next.clientY - origin.y))),
      }
      onSize(latest, false)
    }
    const finish = () => {
      window.removeEventListener('pointermove', move)
      onSize(latest, true)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', finish, { once: true })
  }

  if (!selection) return null
  const style = { left: Math.max(12, selection.left - 150), top: Math.max(8, selection.top - 54) }
  if (!kind) {
    const spellingColumn = spellingForSelection(spelling, selection)
    return (
      <div ref={pill} className={spellingColumn || selection.explicit ? 'selection-menu has-spelling' : 'selection-menu'} style={style} role="menu" aria-label="Annotate selection">
        {([['comment', 'Comment', 'C'], ['question', 'Question', 'Q'], ['suggestion', 'Suggest', 'S'], ['decision', 'Decision', 'D']] as const).map(([value, label, key]) => (
          <button
            type="button"
            role="menuitem"
            key={value}
            disabled={value === 'suggestion' && !selection.singleBlock}
            title={value === 'suggestion' && !selection.singleBlock ? 'Suggestions must stay within one paragraph or block' : undefined}
            onClick={() => setKind(value)}
          >{label} <kbd>{key}</kbd></button>
        ))}
        {selection.explicit && (onCut || onCopy || onPaste || onSelectAll) && (
          // The right-click menu's edit row (§5.15). Mousedown keeps focus in the
          // editor so cut and copy still see the selection.
          <div className="edit-options" role="group" aria-label="Edit" onMouseDown={(event) => event.preventDefault()}>
            {onCut && <button type="button" role="menuitem" onClick={onCut}>Cut</button>}
            {onCopy && <button type="button" role="menuitem" onClick={onCopy}>Copy</button>}
            {onPaste && <button type="button" role="menuitem" onClick={onPaste}>Paste</button>}
            {onSelectAll && <button type="button" role="menuitem" onClick={onSelectAll}>Select all</button>}
          </div>
        )}
        {spellingColumn && (
          // Mousedown must not move focus: collapsing the editor selection
          // here would leave the replacement with nothing to replace.
          <div className="spelling-options" role="group" aria-label="Spelling" onMouseDown={(event) => event.preventDefault()}>
            {spellingColumn.suggestions.map((suggestion) => (
              <button type="button" role="menuitem" key={suggestion} onClick={() => onReplaceWord(suggestion)}>{suggestion}</button>
            ))}
            <button type="button" role="menuitem" className="spelling-learn" onClick={() => onAddToDictionary(spellingColumn.word)}>
              Add “{spellingColumn.word}” to dictionary
            </button>
          </div>
        )}
      </div>
    )
  }
  const formStyle: CSSProperties = {
    left: Math.max(12, selection.left - 160),
    top: selection.top + 42,
    width: size.width,
    ...(size.height >= 0 ? { height: size.height } : {}),
    '--zoom': zoom,
  } as CSSProperties
  return (
    <form ref={form} className="annotation-composer" style={formStyle} onSubmit={(event) => {
      event.preventDefault()
      const choices = options.map((option) => option.trim()).filter(Boolean)
      if (kind === 'decision' && (text.trim().length === 0 || choices.length < 2 || new Set(choices).size !== choices.length)) return
      onSubmit(kind, text, kind === 'decision' ? choices : undefined)
    }}>
      <div className="annotation-kind">{kind}</div>
      <blockquote>{selection.quote}</blockquote>
      {selection.annotationContext && (
        <div className="annotation-context">
          {selection.annotationContext.kind === 'screenshot-pin'
            ? `AnnotatedScreenshot line ${selection.annotationContext.componentLine} · Pin ${selection.annotationContext.pin} · ${selection.annotationContext.image}`
            : <>
                {selection.annotationContext.heading ? `${selection.annotationContext.heading} · ` : ''}
                {selection.annotationContext.column ? `Column ${selection.annotationContext.column.index + 1}: ${selection.annotationContext.column.label}` : 'Complete table row'}
              </>}
        </div>
      )}
      <textarea
        ref={textarea}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          // Ctrl+Enter adds this note; it must not open Send underneath (§5.2).
          if (event.key !== 'Enter' || !hasPrimaryModifier(event)) return
          event.preventDefault()
          event.stopPropagation()
          const choices = options.map((option) => option.trim()).filter(Boolean)
          if (kind === 'decision' && (text.trim().length === 0 || choices.length < 2 || new Set(choices).size !== choices.length)) return
          onSubmit(kind, text, kind === 'decision' ? choices : undefined)
        }}
        placeholder={kind === 'suggestion' ? 'Replacement markdown…' : kind === 'decision' ? 'What needs to be decided?' : 'Your note…'}
        aria-label={kind === 'suggestion' ? 'Replacement markdown' : kind === 'decision' ? 'Decision prompt' : 'Annotation text'}
      />
      {kind === 'decision' && (
        <div className="decision-options" role="group" aria-label="Decision choices">
          {options.map((option, index) => (
            <label key={index}><span>Choice {index + 1}</span><input aria-label={`Choice ${index + 1}`} value={option} onChange={(event) => setOptions((current) => current.map((value, choice) => choice === index ? event.target.value : value))} /></label>
          ))}
          <div className="decision-other-note">Other is always available.</div>
          <button type="button" className="text-action" onClick={() => setOptions((current) => [...current, ''])}>Add choice</button>
        </div>
      )}
      <div className="composer-actions"><button type="button" className="quiet-button" onClick={onDismiss}>Cancel</button><button type="submit" className="primary-button">Add</button></div>
      <button type="button" className="thread-panel-resize" aria-label="Resize annotation composer" onPointerDown={startResize} />
    </form>
  )
}
