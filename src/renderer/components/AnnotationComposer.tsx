import { useEffect, useRef, useState, type CSSProperties } from 'react'
import type { AnnotationKind, AttachmentView, DraftKind, PanelSize, SpellingContext } from '../../shared/contracts'
import type { EditorSelection } from '../editorAdapter'
import { COMPOSER_LIMITS, spellingForSelection } from '../model'
import { claimEscape, isEscapeClaimed } from '../escape'
import { hasPrimaryModifier } from '../../shared/primary-modifier'
import { AGENT_COLORS, defaultRecipientIds } from '../model'

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
  attachments: AttachmentView[]
  leadAgentId: string | null
  activeConversationId: string | null
  onHold(kind: DraftKind, text: string, recipients: string[]): void
  onSend(kind: DraftKind, text: string, recipients: string[]): void
  onReplaceWord(suggestion: string): void
  onAddToDictionary(word: string): void
  /** Edit actions on a right-click selection (§5.15). */
  onCut?(): void
  onCopy?(): void
  onPaste?(): void
  onSelectAll?(): void
}

interface AnnotationTextKeyEvent {
  key: string
  shiftKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  nativeEvent: { isComposing?: boolean }
  preventDefault(): void
  stopPropagation(): void
}

type AnnotationSubmit = (kind: AnnotationKind, text: string, options?: string[]) => void

export function submitAnnotation(
  kind: AnnotationKind,
  text: string,
  options: readonly string[],
  onSubmit: AnnotationSubmit,
): boolean {
  const choices = options.map((option) => option.trim()).filter(Boolean)
  if (kind === 'decision' && (text.trim().length === 0 || choices.length < 2 || new Set(choices).size !== choices.length)) return false
  onSubmit(kind, text, kind === 'decision' ? choices : undefined)
  return true
}

export function handleAnnotationTextKey(
  event: AnnotationTextKeyEvent,
  kind: AnnotationKind,
  text: string,
  options: readonly string[],
  recipients: readonly string[],
  onSubmit: AnnotationSubmit,
  onSend: (kind: DraftKind, text: string, recipients: string[]) => void,
): void {
  if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
  if (kind === 'decision' && !hasPrimaryModifier(event)) return
  event.preventDefault()
  event.stopPropagation()
  if (kind === 'decision') {
    submitAnnotation(kind, text, options, onSubmit)
    return
  }
  if (text.trim() && recipients.length > 0) onSend(kind, text, [...recipients])
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

export function AnnotationComposer({ selection, spelling, size, zoom, onSize, onDismiss, onSubmit, attachments, leadAgentId, activeConversationId, onHold, onSend, onReplaceWord, onAddToDictionary, onCut, onCopy, onPaste, onSelectAll }: AnnotationComposerProps) {
  const [kind, setKind] = useState<AnnotationKind | null>(null)
  const [text, setText] = useState('')
  const [options, setOptions] = useState(['', ''])
  const [recipients, setRecipients] = useState<string[]>([])
  const textarea = useRef<HTMLTextAreaElement>(null)
  const form = useRef<HTMLFormElement>(null)
  const pill = useRef<HTMLDivElement>(null)
  const attachmentIds = attachments.map((attachment) => attachment.agent.id).join('\0')
  const outsideState = useRef({ kind, text, recipients, onHold, onDismiss })
  outsideState.current = { kind, text, recipients, onHold, onDismiss }

  useEffect(() => {
    setKind(selection?.annotationKind ?? null)
    setText('')
    setOptions(['', ''])
  }, [selection])
  useEffect(() => {
    setRecipients(defaultRecipientIds(attachments, leadAgentId, activeConversationId))
  }, [activeConversationId, attachmentIds, leadAgentId, selection?.from, selection?.to])
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
  useEffect(() => {
    if (!kind) return
    const outside = (event: PointerEvent) => {
      if (form.current?.contains(event.target as Node)) return
      // A screenshot pin can emit the same anchored selection again on click.
      // Keep the empty composer alive so that click refreshes it instead of
      // dismissing and then being mistaken for the selection just dismissed.
      if (event.target instanceof Element && event.target.closest('.strata-screenshot-pin')) return
      const latest = outsideState.current
      if (latest.kind !== 'decision' && latest.kind !== null && latest.text.trim()) latest.onHold(latest.kind, latest.text, latest.recipients)
      else latest.onDismiss()
    }
    window.addEventListener('pointerdown', outside, true)
    return () => window.removeEventListener('pointerdown', outside, true)
  }, [kind])

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
      submitAnnotation(kind, text, options, onSubmit)
    }}>
      <div className="annotation-kinds" role="radiogroup" aria-label="Comment kind">
        {([['comment', 'Comment'], ['question', 'Question'], ['suggestion', 'Suggest'], ['decision', 'Decision']] as const).map(([value, label]) => (
          <button type="button" role="radio" aria-checked={kind === value} disabled={value === 'suggestion' && !selection.singleBlock} key={value} onClick={() => setKind(value)}>{label}</button>
        ))}
      </div>
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
      {kind !== 'decision' && attachments.length > 0 && (
        <fieldset className="composer-recipients"><legend>Recipients</legend>{attachments.map((attachment) => {
          const checked = recipients.includes(attachment.agent.id)
          const color = AGENT_COLORS[attachment.agent.color]
          return <label key={attachment.agent.id} data-selected={checked} style={{ '--recipient-color': color } as CSSProperties}><input type="checkbox" checked={checked} onChange={() => setRecipients((current) => checked ? current.filter((id) => id !== attachment.agent.id) : [...current, attachment.agent.id])} /><i />{attachment.agent.name}</label>
        })}</fieldset>
      )}
      <textarea
        ref={textarea}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => handleAnnotationTextKey(event, kind, text, options, recipients, onSubmit, onSend)}
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
      {kind === 'decision'
        ? <div className="composer-actions"><button type="button" className="quiet-button" onClick={onDismiss}>Cancel</button><button type="submit" className="primary-button">Add</button></div>
        : <><div className="composer-hint">Esc discards · Shift+Enter new line</div><div className="composer-actions"><button type="button" className="quiet-button" disabled={!text.trim()} onClick={() => onHold(kind, text, recipients)}>Hold</button><button type="button" className="primary-button" disabled={!text.trim() || recipients.length === 0} onClick={() => onSend(kind, text, recipients)}>Send</button></div></>}
      <button type="button" className="composer-resize" aria-label="Resize annotation composer" onPointerDown={startResize} />
    </form>
  )
}
