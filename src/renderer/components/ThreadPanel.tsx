import { useEffect, useRef, useState, type RefObject } from 'react'
import type { AgentIdentity, AnnotationView } from '../../shared/contracts'
import { absoluteTime, AGENT_COLORS, threadTime, USER_ANNOTATION_COLOR } from '../model'
import { InlineMarkdown } from '../inlineMarkdown'
import { useClock } from '../useClock'
import { claimEscape, isEscapeClaimed } from '../escape'
import { hasPrimaryModifier } from '../../shared/primary-modifier'

// The one thread surface (PRD §6.9): the Thread tab of the left window, filled
// by rail rows and in-editor highlight clicks alike. The left window widens to
// the thread width while the tab is selected; the span it belongs to is
// centered and highlighted in the editor, so the thread needs no position.

interface ThreadPanelProps {
  annotation: AnnotationView
  /** Keys the reply draft, so a draft survives closing and reopening the thread while the app runs. */
  documentPath: string
  onReply(text: string): void
  onResolve(): void
  onAnswer(answer: { option: string | null; other?: string }): void
  onReopen(): void
  /** Accept or reject an open suggestion from the thread (PRD §6.5). */
  onAccept(): void
  onReject(): void
  onClose(): void
  /** What opened the thread (a rail row, a key), captured before the jump moved focus into the editor (§5.11). */
  opener?: RefObject<HTMLElement | null>
}

/** Unsent replies per thread, kept while the app runs (PRD §6.9 drafts). */
const replyDrafts = new Map<string, string>()

export function replyDraftKey(documentPath: string, annotationId: string): string {
  return `${documentPath}\n${annotationId}`
}

/** Drop reply drafts for documents that are no longer open (§5.16). */
export function forgetReplyDrafts(openPaths: ReadonlySet<string>): void {
  for (const key of replyDrafts.keys()) if (!openPaths.has(key.split('\n')[0]!)) replyDrafts.delete(key)
}

function authorName(author: 'user' | AgentIdentity): string {
  return author === 'user' ? 'you' : author.name
}

function authorColor(author: 'user' | AgentIdentity): string {
  return author === 'user' ? USER_ANNOTATION_COLOR : AGENT_COLORS[author.color]
}

function ThreadTime({ time, now }: { time: number | undefined; now: number }) {
  const relative = threadTime(time, now)
  if (!relative) return null
  return <time className="thread-time" dateTime={new Date(time!).toISOString()} title={absoluteTime(time!)}>{relative}</time>
}

export function ThreadPanel({ annotation, documentPath, onReply, onResolve, onAnswer, onReopen, onAccept, onReject, onClose, opener }: ThreadPanelProps) {
  const draftKey = replyDraftKey(documentPath, annotation.id)
  const [reply, setReply] = useState(() => replyDrafts.get(draftKey) ?? '')
  const [choice, setChoice] = useState('')
  const [other, setOther] = useState('')
  const replyBox = useRef<HTMLTextAreaElement>(null)
  const now = useClock()

  // The reply box takes focus on open; whatever opened the thread gets it back
  // on close (§5.11). The focus waits a frame: the editor's jump to the span
  // runs in the same commit, after this effect, and would otherwise win.
  useEffect(() => {
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const restoreTo = opener?.current ?? active
    const frame = window.requestAnimationFrame(() => replyBox.current?.focus({ preventScroll: true }))
    return () => {
      window.cancelAnimationFrame(frame)
      if (restoreTo?.isConnected) restoreTo.focus({ preventScroll: true })
    }
    // Captured once per thread; the opener is fixed at open time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
        <ThreadTime time={annotation.createdAt} now={now} />
        <button type="button" className="popover-close" aria-label="Close thread" onClick={onClose}>×</button>
      </header>
      <div className="thread-panel-scroll">
        {orphaned && (
          <blockquote className="thread-panel-quote">
            <InlineMarkdown text={annotation.quote} />
          </blockquote>
        )}
        <p><InlineMarkdown text={annotation.text} /></p>
        {annotation.replies.map((item) => (
          <div className="reply" style={{ borderColor: authorColor(item.author) }} key={item.id}>
            <strong style={{ color: authorColor(item.author) }}>{authorName(item.author)}<ThreadTime time={item.createdAt} now={now} /></strong>
            <span><InlineMarkdown text={item.text} /></span>
          </div>
        ))}
        {decision?.answers.map((answer) => (
          <div className="reply decision-answer" style={{ borderColor: USER_ANNOTATION_COLOR }} key={answer.seq}>
            <strong style={{ color: USER_ANNOTATION_COLOR }}>you<ThreadTime time={answer.answeredAt} now={now} /></strong>
            <span>{answer.option === null ? <>answered Other: <InlineMarkdown text={answer.other ?? ''} /></> : <>chose “<InlineMarkdown text={answer.option} />”</>}</span>
          </div>
        ))}
      </div>
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
