import { createPortal } from 'react-dom'
import { readDraft } from '../conversationDrafts'
import { InlineMarkdown } from '../inlineMarkdown'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { claimEscape, isEscapeClaimed } from '../escape'
import type { ConversationInput, DraftKind, EngineThreadView, HeadingReference, VisualCommentView } from '../../shared/contracts'
import type { EditorSelection } from '../../editor/types'
import { conversationDelivery, renderConversationDelivery, resolveMessageAnchor, isOwnerComment } from '../../core/conversation-delivery'
import { conversationMatches, readConversationReading, writeConversationReading } from '../conversationReading'
import type { ConversationMarker } from '../conversationNavigation'
import { AnnotationComposer } from './AnnotationComposer'
import type { PassageTarget } from './ConversationMessage'
import type { ConversationHistory } from './ConversationHistory'
import type { NavigationOutcome } from '../transcriptCoordinator'
import type { ReadingAnchor } from '../transcriptAnchors'

export function useConversationWorkspace(thread: EngineThreadView | undefined, onStart: (id: string, input: ConversationInput) => Promise<void>, panel: RefObject<HTMLElement | null>, visual: { comments: VisualCommentView[]; onOpen(id: string): void } = { comments: [], onOpen: () => undefined }, transcript?: RefObject<ConversationHistory | null>) {
  const [selection, setSelection] = useState<{ message: string; range: EditorSelection; id?: string } | null>(null)
  const [discussion, setDiscussion] = useState<string | null>(null)
  const returnPosition = useRef<ReadingAnchor | null>(null)
  const [navigationFailure, setNavigationFailure] = useState<{ target: PassageTarget; reason: string } | null>(null)
  const [replyDraft, setReplyDraft] = useState<{ itemId: string; text: string } | null>(null)
  const answerDrafts = useRef(new Map<string, string>())
  const answerKey = (id: string) => `${thread?.engineIdentity ?? ''}\0${thread?.id ?? ''}\0${id}`
  const replyItem = replyDraft?.itemId ?? null
  const reply = replyDraft?.text ?? ''
  const setReply = (text: string) => setReplyDraft(current => current ? { ...current, text } : null)
  const [target, setTarget] = useState<PassageTarget | null>(null)
  const [excluded, setExcluded] = useState<string[]>([])
  const [reading, setReading] = useState<Record<string, string>>({})
  const [menu, setMenu] = useState<'items' | null>(null)
  const findField = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [matchIndex, setMatchIndex] = useState(0)
  const [error, setError] = useState('')
  const [previewId, setPreviewId] = useState(() => readDraft(`thread:${thread?.id}`).messageId ?? crypto.randomUUID())
  useEffect(() => { returnPosition.current = null; setReading(readConversationReading(thread?.id ?? '')); setSelection(null); setDiscussion(null); setMenu(null); setQuery(''); setTarget(null); setNavigationFailure(null); setReplyDraft(null); setExcluded([]); setPreviewId(readDraft(`thread:${thread?.id}`).messageId ?? crypto.randomUUID()) }, [thread?.id])
  useEffect(() => { const refresh = () => setReading(readConversationReading(thread?.id ?? '')); window.addEventListener('conversation-reading', refresh); return () => window.removeEventListener('conversation-reading', refresh) }, [thread?.id])
  const remember = (key: string, value: string) => { if (thread) writeConversationReading(thread.id, { ...readConversationReading(thread.id), [key]: value }) }
  const attempt = async (action: () => Promise<unknown>) => { try { await action(); setError('') } catch (error) { setError(error instanceof Error ? error.message : String(error)) } }
  const comments = thread?.comments ?? []
  const held = comments.filter(comment => comment.state === 'held')
  const queued = (thread?.items ?? []).filter(item => item.draftReply !== undefined)
  const selectedComments = held.filter(comment => !excluded.includes(comment.id))
  const selectedReplies = Object.fromEntries(queued.filter(item => !excluded.includes(item.id)).map(item => [item.id, { text: item.draftReply! }]))
  const outgoing = thread ? { comments: Object.fromEntries(selectedComments.map(comment => [comment.id, comment.revision])), replies: Object.fromEntries(Object.entries(selectedReplies).map(([id, reply]) => [id, reply.text])) } : {}
  let preview = ''
  try { if (thread && (selectedComments.length || Object.keys(selectedReplies).length || thread.outcomes?.length)) preview = renderConversationDelivery(conversationDelivery(thread.id, previewId, selectedComments, selectedReplies, thread.messages, thread.outcomes ?? [])) } catch (error) { preview = String(error) }
  // Every destination goes through the transcript's coordinator, which waits for
  // a ready editor and scrolls once; nothing here writes the scroll position.
  const jump = (message: string, from: number, to: number, align?: 'start', annotation?: string) => {
    // A navigation reveal leaves the owner's persisted fold choices intact.
    setNavigationFailure(null)
    setTarget(previous => ({ message, from, to, ...(align ? { align } : {}), ...(annotation ? { annotation } : {}), serial: (previous?.serial ?? 0) + 1 }))
  }
  const onNavigation = (outcome: NavigationOutcome) => {
    setTarget(current => current?.serial === outcome.target.serial ? { ...current, pending: false } : current)
    if (outcome.outcome === 'failed') setNavigationFailure({ target: outcome.target as PassageTarget, reason: outcome.reason })
  }
  const retryNavigation = () => { const failed = navigationFailure; if (failed) jump(failed.target.message, failed.target.from, failed.target.to, failed.target.align, failed.target.annotation) }
  const open = (id: string, reveal = true) => {
    const comment = comments.find(comment => comment.id === id)
    if (!comment) {
      const ask = thread?.items?.find(item => item.id === id && item.inferred)
      if (reveal && ask?.askRange && ask.messageId) jump(ask.messageId, ask.askRange.from, ask.askRange.to, undefined, ask.id)
      focusReply(id); return
    }
    const message = thread?.messages.find(message => message.id === comment.anchor.message)
    const range = resolveMessageAnchor(comment, message)
    if (discussion !== id && comment.state !== 'held') {
      // The passage at the reading edge, so Back to reading lands on the same text even after the row's rendering changed.
      const captured = transcript?.current?.captureReading()
      if (captured) returnPosition.current = captured
      else {
        const viewport = panel.current?.querySelector('.conversation-messages')
        const top = viewport?.getBoundingClientRect().top ?? 0
        const row = Array.from(viewport?.querySelectorAll<HTMLElement>('[data-message-id]') ?? []).find(row => row.getBoundingClientRect().bottom > top)
        returnPosition.current = row ? { message: row.dataset.messageId!, offset: null, viewportOffset: row.getBoundingClientRect().top - top } : null
      }
    }
    setDiscussion(comment.state === 'held' ? null : id)
    if (comment.state !== 'held') setSelection(null)
    if (range) {
      jump(comment.anchor.message, range.from, range.to, undefined, comment.id)
      if (comment.state === 'held') setSelection({ message: comment.anchor.message, id, range: { ...range, quote: comment.selection, singleBlock: true, left: window.innerWidth / 2, top: window.innerHeight / 2, annotationKind: comment.kind } })
    }
  }
  const hold = async (kind: DraftKind, text: string, send: boolean) => {
    if (!thread || !selection) return
    const id = await window.strata.holdMessageComment(thread.id, { ...(selection.id ? { id: selection.id } : {}), messageId: selection.message, from: selection.range.from, to: selection.range.to, kind, text })
    const revision = (comments.find(comment => comment.id === id)?.revision ?? 0) + 1
    setSelection(null)
    if (send) await onStart(thread.id, { text: '', model: thread.model, instanceId: thread.providerInstanceId, effort: thread.effort, access: thread.access, comments: { [id]: revision } })
  }
  const matches = useMemo(() => {
    if (!query.trim()) return []
    return (thread?.messages ?? []).flatMap(message => conversationMatches(message.id, message.prose ?? message.text, query).map(range => ({ message: message.id, ...range })))
  }, [query, thread?.messages])
  const findStep = (index: number) => { if (!matches.length) return; const next = (index + matches.length) % matches.length; setMatchIndex(next); const match = matches[next]!; jump(match.message, match.from, match.to) }
  // Find as you type: the first match comes into view as soon as the query has one.
  useEffect(() => { if (query.trim() && matches.length) findStep(0) }, [query])
  const activeComment = comments.find(comment => comment.id === discussion)
  const discussionRoot = useRef<HTMLElement>(null)
  const discussionState = useRef({ open: false, editing: false })
  useLayoutEffect(() => { discussionState.current = { open: Boolean(activeComment), editing: Boolean(selection) } })
  useEffect(() => {
    const dismissOutside = (event: PointerEvent) => {
      if (!discussionState.current.open || discussionState.current.editing || discussionRoot.current?.contains(event.target as Node)) return
      if (event.target instanceof Element && event.target.closest('.web-link-picker, .link-context-menu')) return
      setDiscussion(null)
    }
    const dismissKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || isEscapeClaimed(event) || !discussionState.current.open || discussionState.current.editing) return
      claimEscape(event)
      setDiscussion(null)
    }
    window.addEventListener('pointerdown', dismissOutside, true)
    window.addEventListener('keydown', dismissKey)
    return () => { window.removeEventListener('pointerdown', dismissOutside, true); window.removeEventListener('keydown', dismissKey) }
  }, [])
  useEffect(() => { if (discussion === null) transcript?.current?.releaseReading() }, [discussion])
  const removeHeld = async (id: string) => {
    if (!thread) return
    if (held.some(comment => comment.id === id)) await window.strata.actMessageComment(thread.id, id, 'discard')
    else {
      await window.strata.discardItemReply(thread.id, id)
      answerDrafts.current.delete(answerKey(id))
      setReplyDraft(current => current?.itemId === id ? null : current)
    }
    setSelection(current => current?.id === id ? null : current)
    setDiscussion(current => current === id ? null : current)
    setExcluded(current => current.filter(candidate => candidate !== id))
  }
  const backToReading = () => {
    setDiscussion(null)
    const position = returnPosition.current
    if (!position) return
    // The saved-comment card is an overlay, so returning needs no deferred
    // layout. A queued restoration could otherwise override the next jump.
    if (transcript?.current?.restoreReading(position)) return
    const viewport = panel.current?.querySelector('.conversation-messages')
    const row = viewport?.querySelector(`[data-message-id="${CSS.escape(position.message)}"]`)
    if (viewport && row) viewport.scrollTop += row.getBoundingClientRect().top - viewport.getBoundingClientRect().top - position.viewportOffset
  }
  const replyRecord = thread?.items?.find(item => item.id === replyItem)
  const focusReply = (id: string) => setReplyDraft({ itemId: id, text: answerDrafts.current.get(answerKey(id)) ?? thread?.items?.find(item => item.id === id)?.answerDraft ?? thread?.items?.find(item => item.id === id)?.draftReply ?? '' })
  const latestResponse = thread?.messages.findLast(message => message.role === 'assistant')
  const openItems = (thread?.items ?? []).filter(item => !isOwnerComment(item) && item.status !== 'done')
  const kindLabel = (kind: string) => kind.charAt(0).toUpperCase() + kind.slice(1)
  // Visual comments ready for review count with the agent's items; the rest of them list behind the same control (docs/plans/open/visual-review).
  const visualReady = visual.comments.filter(comment => comment.status === 'ready')
  const fromAgent = openItems.length + visualReady.length
  const itemsLabel = fromAgent > 0 ? (fromAgent === 1 ? '1 item from the agent' : `${fromAgent} items from the agent`) : visual.comments.length === 1 ? '1 visual comment' : `${visual.comments.length} visual comments`
  const tools = <div className="conversation-tools">
    {(openItems.length > 0 || visual.comments.length > 0) && <div className="conversation-items-tool">
      <button type="button" aria-expanded={menu === 'items'} onClick={() => setMenu(menu === 'items' ? null : 'items')}>{itemsLabel}</button>
      {menu === 'items' && <div className="conversation-navigation" role="region" aria-label="Items from the agent">
        {openItems.length > 0 && <p>The agent is waiting on these. Choose one to read its passage or answer it.</p>}
        {openItems.map(item => <div className="conversation-item-entry" key={item.id}><button type="button" onClick={() => { open(item.id); setMenu(null) }}><strong>{kindLabel(item.kind)}</strong> {item.text || item.quote}{item.status === 'drafted' && <em> Reply drafted</em>}</button>{item.inferred && <button type="button" aria-label={`Dismiss question: ${item.quote}`} onClick={() => void attempt(() => window.strata.dismissItem(thread!.id, item.id))}>Dismiss</button>}</div>)}
        {visual.comments.length > 0 && <p>Visual comments in this conversation.</p>}
        {visual.comments.map(comment => <button type="button" key={comment.id} className="conversation-visual-item" data-status={comment.status} onClick={() => { visual.onOpen(comment.id); setMenu(null) }}><strong>Visual</strong> {comment.title}<em> {comment.statusLabel}</em></button>)}
      </div>}
    </div>}
    <div className="conversation-find" role="search">
      <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="6.75" cy="6.75" r="4.5" /><path d="m10.25 10.25 3.75 3.75" /></svg>
      <input ref={findField} type="search" aria-label="Find in conversation" placeholder="Find" value={query} onChange={event => { setQuery(event.target.value); setMatchIndex(0) }} onKeyDown={event => {
        if (event.key === 'Enter') { event.preventDefault(); findStep(matchIndex + (event.shiftKey ? -1 : 1)) }
        if (event.key === 'Escape' && query) { event.preventDefault(); event.stopPropagation(); setQuery('') }
      }} />
      {query.trim() && <><span>{matches.length ? `${matchIndex + 1} of ${matches.length}` : 'No matches'}</span><button type="button" aria-label="Previous" title="Previous match" disabled={!matches.length} onClick={() => findStep(matchIndex - 1)}>‹</button><button type="button" aria-label="Next" title="Next match" disabled={!matches.length} onClick={() => findStep(matchIndex + 1)}>›</button></>}
    </div>
  </div>
  const tray = <>
    {(held.length > 0 || queued.length > 0 || preview) && <details className="conversation-context-tray" open><summary>Pending context · {held.length + queued.length + (thread?.outcomes?.length ?? 0)}</summary>
      {[...held.map(comment => ({ id: comment.id, text: comment.text, label: `Held ${comment.kind}`, removable: true })), ...queued.map(item => ({ id: item.id, text: item.draftReply!, label: 'Reply', removable: true }))].map(entry => <div className="conversation-context-entry" key={entry.id}><label><input type="checkbox" aria-label={`Include ${entry.label.toLowerCase()}: ${entry.text}`} checked={!excluded.includes(entry.id)} onChange={() => setExcluded(previous => previous.includes(entry.id) ? previous.filter(id => id !== entry.id) : [...previous, entry.id])} /><button type="button" onClick={() => open(entry.id)}>{entry.label}: {entry.text}</button></label>{entry.removable && <button type="button" className="conversation-context-remove" aria-label={`Remove held ${entry.label === 'Reply' ? 'reply' : 'comment'}: ${entry.text}`} title="Remove held context" onClick={() => void attempt(() => removeHeld(entry.id))}>×</button>}</div>)}
      {!!thread?.outcomes?.length && <p>{thread.outcomes.length} action outcomes</p>}
      {preview && <details><summary>Delivery preview</summary><pre>{preview}</pre></details>}
    </details>}
    {replyItem && !replyRecord?.inferred && <div className="conversation-reply-composer"><strong>Reply to {replyRecord?.text || replyRecord?.quote || replyItem}</strong><textarea aria-label="Discussion reply" value={reply} onChange={event => setReply(event.target.value)} />{replyRecord?.options?.map(option => <button type="button" key={option} onClick={() => setReply(option)}>{option}</button>)}<button type="button" onClick={() => setReply('')}>Other</button><button type="button" disabled={!reply.trim()} onClick={() => void attempt(async () => { const submitted = replyDraft; await window.strata.queueItemReply(thread!.id, replyItem, reply); setReplyDraft(current => current === submitted ? null : current) })}>Queue reply</button><button type="button" onClick={() => setReplyDraft(null)}>Cancel</button></div>}
    {thread?.deliveries?.map(delivery => <details key={delivery.messageId}><summary>{delivery.phase === 'uploading' ? 'Delivery upload incomplete' : 'Delivery ready to dispatch'}</summary><pre>{delivery.text}</pre><button type="button" onClick={() => void attempt(() => onStart(thread.id, { messageId: delivery.messageId, text: '', model: thread.model, effort: thread.effort, access: thread.access }))}>Retry delivery</button></details>)}
    {error && <p role="alert">{error}</p>}
    {navigationFailure && <p role="alert" className="conversation-navigation-failure">The passage in message {navigationFailure.target.message} is not ready yet. <button type="button" onClick={retryNavigation}>Retry</button></p>}
  </>
  const overlay = selection && thread ? <AnnotationComposer messageTarget initialText={comments.find(comment => comment.id === selection.id)?.text ?? ''} selection={selection.range} spelling={null} size={{ width: 360, height: -1 }} zoom={Number(getComputedStyle(document.querySelector(`[data-message-id="${CSS.escape(selection.message)}"]`) ?? document.body).getPropertyValue('--zoom')) || 1} onSize={() => {}} onDismiss={() => setSelection(null)} onRemove={selection.id ? () => void attempt(() => removeHeld(selection.id!)) : undefined} onSubmit={() => {}} recipients={[{ id: thread.id, name: thread.title, color: "grape", attached: true }]} leadAgentId={null} activeConversationId={thread.id} onHold={(kind, text) => void attempt(() => hold(kind, text, false))} onSend={(kind, text) => void attempt(() => hold(kind, text, true))} onReplaceWord={() => {}} onAddToDictionary={() => {}} /> : null
  const bounds = panel.current?.querySelector('.conversation-reading-area')?.getBoundingClientRect()
  const recordWidth = Math.min(420, window.innerWidth - 32)
  const recordPosition = bounds ? { position: 'fixed' as const, left: Math.max(16, Math.min(panel.current?.dataset.placement === 'side' ? bounds.left + 40 : bounds.right - recordWidth - 12, window.innerWidth - recordWidth - 16)), bottom: window.innerHeight - bounds.bottom + 12, width: recordWidth, maxHeight: Math.max(120, bounds.height * .6) } : undefined
  const ownerComment = activeComment && isOwnerComment(activeComment)
  const discussionView = activeComment ? createPortal(<section ref={discussionRoot} style={recordPosition} className="conversation-discussion" role="dialog" aria-label={ownerComment ? 'Saved comment' : 'Passage discussion'}>
    <header><small>{ownerComment ? activeComment.state === 'held' ? 'Held comment' : activeComment.state === 'pending' ? 'Sending comment' : 'Sent comment' : 'Agent item'}</small><button type="button" className="popover-close" aria-label="Close comment" onClick={() => setDiscussion(null)}>×</button></header>
    <blockquote>{activeComment.selection}</blockquote><p><InlineMarkdown text={activeComment.text} links /></p>
    {activeComment.replies.length > 0 && <details><summary>Earlier replies</summary>{activeComment.replies.map((reply, index) => <p key={index}><strong>{reply.author === 'agent' ? 'Agent' : 'You'}</strong> <InlineMarkdown text={reply.text} links /></p>)}</details>}
    {!resolveMessageAnchor(activeComment, thread?.messages.find(message => message.id === activeComment.anchor.message)) && <p>Original passage unavailable</p>}
    <button type="button" onClick={() => open(activeComment.id)}>Jump to passage</button>
    {!ownerComment && <button type="button" onClick={() => focusReply(activeComment.id)}>Answer</button>}
    <button type="button" onClick={backToReading}>Back to reading</button>
  </section>, document.querySelector('.app-shell') ?? document.body) : null
  const answerRoot = useRef<HTMLElement>(null)
  const answerState = useRef<{ id: string | null }>({ id: null })
  useLayoutEffect(() => { answerState.current = { id: replyRecord?.inferred ? replyItem : null } })
  const closeAnswer = () => {
    const id = answerState.current.id
    setReplyDraft(null)
    if (id) panel.current?.querySelector<HTMLButtonElement>(`[data-ask-id="${CSS.escape(id)}"]`)?.focus({ preventScroll: true })
  }
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape' && answerState.current.id && !isEscapeClaimed(event)) { claimEscape(event); closeAnswer() } }
    const outside = (event: PointerEvent) => { if (answerState.current.id && !answerRoot.current?.contains(event.target as Node) && !(event.target instanceof Element && event.target.closest('[data-ask-id], .conversation-marker'))) setReplyDraft(null) }
    window.addEventListener('keydown', key)
    window.addEventListener('pointerdown', outside, true)
    return () => { window.removeEventListener('keydown', key); window.removeEventListener('pointerdown', outside, true) }
  }, [])
  const answerView = replyRecord?.inferred && replyItem ? createPortal(<section ref={answerRoot} style={recordPosition} className="conversation-discussion conversation-answer-popup" role="dialog" aria-label="Your answer">
    <header><strong>Your answer</strong><button type="button" className="popover-close" aria-label="Close answer" onClick={closeAnswer}>×</button></header>
    {replyRecord.unavailable && <p>Original passage unavailable</p>}
    <div className="reply-box"><textarea key={replyItem} autoFocus aria-label="Your answer" placeholder="Write your answer…" value={reply} onChange={event => { const text = event.target.value; answerDrafts.current.set(answerKey(replyItem), text); setReply(text); void attempt(() => window.strata.saveAskDraft(thread?.engineIdentity ?? null, thread!.id, replyItem, text)) }} /></div>
    <small>Included in your next Send</small>
    <div className="conversation-answer-actions"><button type="button" className="quiet-button" onClick={closeAnswer}>Cancel</button><button type="button" className="primary-button" disabled={!reply.trim()} onClick={() => void attempt(async () => { const submitted = replyDraft; const key = answerKey(replyItem); await window.strata.queueItemReply(thread!.id, replyItem, reply); if (answerDrafts.current.get(key) === reply) answerDrafts.current.delete(key); setReplyDraft(current => current === submitted ? null : current) })}>Queue reply</button></div>
    {error && <p role="alert">{error}</p>}
  </section>, document.querySelector('.app-shell') ?? document.body) : null
  const navigate = (marker: ConversationMarker) => {
    setMenu(null)
    if (marker.comment) open(marker.comment)
    else { setDiscussion(null); jump(marker.message, 0, 0, 'start') }
  }

  return { navigate, selection, target, onNavigation, tools, tray, latestResponse: latestResponse?.id, jumpToLatest: () => { setMenu(null); if (latestResponse) jump(latestResponse.id, 0, 0, 'start') }, overlay: overlay ? createPortal(overlay, document.querySelector('.app-shell') ?? document.body) : null, discussion: activeComment, discussionView: <>{discussionView}{answerView}</>, answerMessage: replyRecord?.inferred ? replyRecord.messageId : null, open, setReplyItem: focusReply, outgoing, previewId, sent: () => setPreviewId(crypto.randomUUID()), selectedCount: selectedComments.length + Object.keys(selectedReplies).length,
    select: (message: string, range: EditorSelection | null) => { if (range) setSelection(previous => previous?.message === message && previous.range.from === range.from && previous.range.to === range.to ? previous : { message, range }) },
    folds: (message: string): HeadingReference[] => { if (target?.message === message) return []; try { return JSON.parse(reading[`headings:${message}`] ?? '[]') } catch { return [] } },
    foldHeading: (message: string, heading: HeadingReference, folded: boolean) => { if (target?.message === message) setTarget(null); const previous: HeadingReference[] = JSON.parse(reading[`headings:${message}`] ?? '[]'); remember(`headings:${message}`, JSON.stringify([...previous.filter(value => JSON.stringify(value) !== JSON.stringify(heading)), ...(folded ? [heading] : [])])) },
    onKeyDown: (event: React.KeyboardEvent) => { if ((event.ctrlKey || event.metaKey) && event.key === 'f') { event.preventDefault(); event.stopPropagation(); findField.current?.focus(); findField.current?.select() } },
  }
}
