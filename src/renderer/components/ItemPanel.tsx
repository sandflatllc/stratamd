import { useEffect, useRef, useState, type RefObject } from 'react'
import type { AgentIdentity, AnnotationView } from '../../shared/contracts'
import { absoluteTime, AGENT_COLORS, threadTime, USER_ANNOTATION_COLOR } from '../model'
import { ConversationHistory } from './ConversationHistory'
import { InlineMarkdown } from '../inlineMarkdown'
import { useClock } from '../useClock'
import { claimEscape, isEscapeClaimed } from '../escape'
import { hasPrimaryModifier } from '../../shared/primary-modifier'

// Anchored item detail shown inside Conversation when a document item is active.

interface ItemPanelProps {
  annotation: AnnotationView
  visible: boolean
  /** Keys the reply draft, so a draft survives closing and reopening the item while the app runs. */
  documentPath: string
  onReply(text: string): void
  onResolve(): void
  onAnswer(answer: { option: string | null; other?: string }): void
  onReopen(): void
  /** Accept or reject an open suggestion item (PRD §6.5). */
  onAccept(): void
  onReject(): void
  onClose(): void
  /** What opened the item, captured before the jump moved focus into the editor. */
  opener?: RefObject<HTMLElement | null>
}

/** Unsent replies per item, kept while the app runs (PRD §6.9 drafts). */
const replyDrafts = new Map<string, string>()

export function replyDraftKey(documentPath: string, annotationId: string): string {
  return `${documentPath}\n${annotationId}`
}

/** Drop item reply drafts for documents that are no longer open (§5.16). */
export function forgetReplyDrafts(openPaths: ReadonlySet<string>): void {
  for (const key of replyDrafts.keys()) if (!openPaths.has(key.split('\n')[0]!)) replyDrafts.delete(key)
}

function authorName(author: 'user' | AgentIdentity): string {
  return author === 'user' ? 'you' : author.name
}

function authorColor(author: 'user' | AgentIdentity): string {
  return author === 'user' ? USER_ANNOTATION_COLOR : AGENT_COLORS[author.color]
}

function ItemTime({ time, now }: { time: number | undefined; now: number }) {
  const relative = threadTime(time, now)
  if (!relative) return null
  return <time className="thread-time" dateTime={new Date(time!).toISOString()} title={absoluteTime(time!)}>{relative}</time>
}

export function ItemPanel({ annotation, visible, documentPath, onReply, onResolve, onAnswer, onReopen, onAccept, onReject, onClose, opener }: ItemPanelProps) {
  const draftKey = replyDraftKey(documentPath, annotation.id)
  const [reply, setReply] = useState(() => replyDrafts.get(draftKey) ?? '')
  const [choice, setChoice] = useState('')
  const [other, setOther] = useState('')
  const replyBox = useRef<HTMLTextAreaElement>(null)
  const now = useClock()

  // Capture the opener once; it receives focus when the item closes (§5.11).
  useEffect(() => {
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const restoreTo = opener?.current ?? active
    return () => {
      if (restoreTo?.isConnected) restoreTo.focus({ preventScroll: true })
    }
    // Captured once per item; the opener is fixed at open time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Opening an item mounts it before the navigation-tab update returns over
  // IPC. A hidden textarea ignores focus, so wait for Conversation to show.
  // The next frame also follows the editor's jump to the annotated span.
  useEffect(() => {
    if (!visible) return
    const frame = window.requestAnimationFrame(() => replyBox.current?.focus({ preventScroll: true }))
    return () => window.cancelAnimationFrame(frame)
  }, [visible])

  useEffect(() => {
    if (reply) replyDrafts.set(draftKey, reply)
    else replyDrafts.delete(draftKey)
  }, [draftKey, reply])

  // Escape closes the thread unless a surface above it (the annotate menu, the
  // find bar, a dialog, the theme panel) already claimed the key.
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || isEscapeClaimed(event)) return
      claimEscape(event)
      onClose()
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [onClose])

  const submit = () => {
    const clean = reply.trim()
    if (!clean) return
    onReply(clean)
    setReply('')
  }

  const orphaned = annotation.status === 'orphaned'
  const openSuggestion = annotation.kind === 'suggestion' && annotation.status === 'open'
  const decision = annotation.kind === 'decision' ? annotation.decision : undefined
  return (
    <section className="thread-panel" aria-label={`${annotation.kind} thread`}>
      <header className="thread-panel-header">
        <span className={`annotation-chip chip-${orphaned ? 'orphaned' : annotation.kind}`} title={orphaned ? 'The text this was attached to was removed' : undefined}>
          {orphaned ? 'text removed' : annotation.kind} · {authorName(annotation.author)}
        </span>
        <ItemTime time={annotation.createdAt} now={now} />
        <button type="button" className="popover-close" aria-label="Close thread" onClick={onClose}>×</button>
      </header>
      <ConversationHistory key={draftKey} className="thread-panel-scroll">
        <p data-history-row><InlineMarkdown text={annotation.text} links /></p>
        {[
          ...annotation.replies.map((item) => ({ time: item.createdAt ?? 0, node: <div className="reply" data-history-row style={{ borderColor: authorColor(item.author) }} key={item.id}>
            <strong style={{ color: authorColor(item.author) }}>{authorName(item.author)}<ItemTime time={item.createdAt} now={now} /></strong>
            <span><InlineMarkdown text={item.text} links /></span>
          </div> })),
          ...(decision?.answers ?? []).map((answer) => ({ time: answer.answeredAt, node: <div className="reply decision-answer" data-history-row style={{ borderColor: USER_ANNOTATION_COLOR }} key={`answer-${answer.seq}`}>
            <strong style={{ color: USER_ANNOTATION_COLOR }}>you<ItemTime time={answer.answeredAt} now={now} /></strong>
            <span>{answer.option === null ? <>answered Other: <InlineMarkdown text={answer.other ?? ''} /></> : <>chose “<InlineMarkdown text={answer.option} />”</>}</span>
          </div> })),
        ].sort((a, b) => a.time - b.time).map((entry) => entry.node)}
        {orphaned && <blockquote className="thread-panel-quote"><InlineMarkdown text={annotation.quote} /></blockquote>}
      </ConversationHistory>
      {decision && annotation.status !== 'resolved' && (
        <fieldset className="decision-answer-form">
          <legend>Choose one</legend>
          {decision.options.map((option) => (
            <label key={option}><input type="radio" name={`decision-${annotation.id}`} value={option} checked={choice === option} onChange={() => setChoice(option)} /><span><InlineMarkdown text={option} /></span></label>
          ))}
          <label><input type="radio" name={`decision-${annotation.id}`} value="__other__" checked={choice === '__other__'} onChange={() => setChoice('__other__')} /><span>Other</span></label>
          {choice === '__other__' && <input aria-label="Other answer" value={other} onChange={(event) => setOther(event.target.value)} placeholder="Your answer" />}
          <button type="button" className="keep-button" disabled={!choice || (choice === '__other__' && !other.trim())} onClick={() => {
            onAnswer(choice === '__other__' ? { option: null, other: other.trim() } : { option: choice })
            setChoice('')
            setOther('')
          }}>Answer decision</button>
        </fieldset>
      )}
      <div className="reply-box">
        <textarea
          ref={replyBox}
          rows={1}
          value={reply}
          onChange={(event) => setReply(event.target.value)}
          onKeyDown={(event) => {
            // Enter and Ctrl+Enter send; Shift+Enter makes a new line. Ctrl+Enter
            // stops here so the window's Send shortcut never fires underneath (§5.2).
            if (event.key === 'Enter' && hasPrimaryModifier(event)) {
              event.preventDefault()
              event.stopPropagation()
              submit()
              return
            }
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              submit()
            }
          }}
          placeholder="Reply… (Shift+Enter for a new line)"
          aria-label="Reply"
        />
        <button type="button" aria-label="Send reply" onClick={submit}>↵</button>
      </div>
      {openSuggestion && (
        <div className="thread-panel-actions">
          <button type="button" className="keep-button" onClick={onAccept}>Accept</button>
          <button type="button" className="revert-button" onClick={onReject}>Reject</button>
        </div>
      )}
      {annotation.kind === 'decision' && annotation.status === 'resolved' && <button type="button" className="resolve-button" onClick={onReopen}>↺ Reopen decision</button>}
      {annotation.kind !== 'decision' && annotation.status !== 'resolved' && <button type="button" className="resolve-button" onClick={onResolve}>✓ Resolve thread</button>}
    </section>
  )
}
