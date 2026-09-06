import { createPortal } from 'react-dom'
import { readDraft } from '../conversationDrafts'
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import type { ConversationInput, DraftKind, EngineThreadView, HeadingReference, VisualCommentView } from '../../shared/contracts'
import type { EditorSelection } from '../../editor/types'
import { conversationDelivery, renderConversationDelivery, resolveMessageAnchor, isOwnerComment } from '../../core/conversation-delivery'
import { conversationMatches, readConversationReading, writeConversationReading } from '../conversationReading'
import type { ConversationMarker } from '../conversationNavigation'
import { AnnotationComposer } from './AnnotationComposer'
import type { PassageTarget } from './ConversationMessage'

export function useConversationWorkspace(thread: EngineThreadView | undefined, onStart: (id: string, input: ConversationInput) => Promise<void>, panel: RefObject<HTMLElement | null>, visual: { comments: VisualCommentView[]; onOpen(id: string): void } = { comments: [], onOpen: () => undefined }) {
  const [selection, setSelection] = useState<{ message: string; range: EditorSelection; id?: string } | null>(null)
  const [discussion, setDiscussion] = useState<string | null>(null)
  const returnPosition = useRef<{ message: string; offset: number } | null>(null)
  const [replyItem, setReplyItem] = useState<string | null>(null)
  const [reply, setReply] = useState('')
  const [target, setTarget] = useState<PassageTarget | null>(null)
  const [excluded, setExcluded] = useState<string[]>([])
  const [reading, setReading] = useState<Record<string, string>>({})
  const [menu, setMenu] = useState<'items' | null>(null)
  const findField = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [matchIndex, setMatchIndex] = useState(0)
  const [error, setError] = useState('')
  const [previewId, setPreviewId] = useState(() => readDraft(`thread:${thread?.id}`).messageId ?? crypto.randomUUID())
  useEffect(() => { setReading(readConversationReading(thread?.id ?? '')); setSelection(null); setDiscussion(null); setMenu(null); setQuery(''); setTarget(null); setReplyItem(null); setExcluded([]); setReply(''); setPreviewId(readDraft(`thread:${thread?.id}`).messageId ?? crypto.randomUUID()) }, [thread?.id])
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
  const jump = (message: string, from: number, to: number, align?: 'start', annotation?: string) => {
    // A navigation reveal leaves the owner's persisted fold choices intact.
    setTarget(previous => ({ message, from, to, ...(align ? { align } : {}), ...(annotation ? { annotation } : {}), serial: (previous?.serial ?? 0) + 1 }))
    const targetMessage = thread?.messages.find(candidate => candidate.id === message)
    if (!align && (targetMessage?.role !== 'assistant' || targetMessage.streaming)) requestAnimationFrame(() => document.querySelector(`[data-message-id="${CSS.escape(message)}"]`)?.scrollIntoView({ block: 'center' }))
  }
  const open = (id: string) => {
    const comment = comments.find(comment => comment.id === id)
    if (!comment) { setReplyItem(id); setReply(thread?.items?.find(item => item.id === id)?.draftReply ?? ''); return }
    const message = thread?.messages.find(message => message.id === comment.anchor.message)
    const range = resolveMessageAnchor(comment, message)
    if (discussion !== id) {
      const viewport = panel.current?.querySelector('.conversation-messages')
      const top = viewport?.getBoundingClientRect().top ?? 0
      const row = Array.from(viewport?.querySelectorAll<HTMLElement>('[data-message-id]') ?? []).find(row => row.getBoundingClientRect().bottom > top)
      returnPosition.current = row ? { message: row.dataset.messageId!, offset: row.getBoundingClientRect().top - top } : null
    }
    setDiscussion(id)
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
  const backToReading = () => {
    setDiscussion(null)
    const position = returnPosition.current
    if (!position) return
    // The saved-comment card is an overlay, so returning needs no deferred
    // layout. A queued restoration could otherwise override the next jump.
    const viewport = panel.current?.querySelector('.conversation-messages')
    const row = viewport?.querySelector(`[data-message-id="${CSS.escape(position.message)}"]`)
    if (viewport && row) viewport.scrollTop += row.getBoundingClientRect().top - viewport.getBoundingClientRect().top - position.offset
  }
  const replyRecord = thread?.items?.find(item => item.id === replyItem)
  const focusReply = (id: string) => { setReplyItem(id); setReply(thread?.items?.find(item => item.id === id)?.draftReply ?? '') }
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
        {openItems.map(item => <button type="button" key={item.id} onClick={() => { open(item.id); setMenu(null) }}><strong>{kindLabel(item.kind)}</strong> {item.text || item.quote}{item.status === 'drafted' && <em> Reply drafted</em>}</button>)}
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
      {[...held.map(comment => ({ id: comment.id, text: comment.text, label: `Held ${comment.kind}` })), ...queued.map(item => ({ id: item.id, text: item.draftReply!, label: 'Reply' }))].map(entry => <label key={entry.id}><input type="checkbox" checked={!excluded.includes(entry.id)} onChange={() => setExcluded(previous => previous.includes(entry.id) ? previous.filter(id => id !== entry.id) : [...previous, entry.id])} /><button type="button" onClick={() => open(entry.id)}>{entry.label}: {entry.text}</button></label>)}
      {!!thread?.outcomes?.length && <p>{thread.outcomes.length} action outcomes</p>}
      {preview && <details><summary>Delivery preview</summary><pre>{preview}</pre></details>}
    </details>}
    {replyItem && <div className="conversation-reply-composer"><strong>Reply to {replyRecord?.text || replyRecord?.quote || replyItem}</strong><textarea aria-label="Discussion reply" value={reply} onChange={event => setReply(event.target.value)} />{replyRecord?.options?.map(option => <button type="button" key={option} onClick={() => setReply(option)}>{option}</button>)}<button type="button" onClick={() => setReply('')}>Other</button><button type="button" disabled={!reply.trim()} onClick={() => void attempt(async () => { await window.strata.queueItemReply(thread!.id, replyItem, reply); setReplyItem(null); setReply('') })}>Queue reply</button><button type="button" onClick={() => setReplyItem(null)}>Cancel</button></div>}
    {thread?.deliveries?.map(delivery => <details key={delivery.messageId}><summary>{delivery.phase === 'uploading' ? 'Delivery upload incomplete' : 'Delivery ready to dispatch'}</summary><pre>{delivery.text}</pre><button type="button" onClick={() => void attempt(() => onStart(thread.id, { messageId: delivery.messageId, text: '', model: thread.model, effort: thread.effort, access: thread.access }))}>Retry delivery</button></details>)}
    {error && <p role="alert">{error}</p>}
  </>
  const overlay = selection && thread ? <AnnotationComposer messageTarget initialText={comments.find(comment => comment.id === selection.id)?.text ?? ''} selection={selection.range} spelling={null} size={{ width: 360, height: -1 }} zoom={Number(getComputedStyle(document.querySelector(`[data-message-id="${CSS.escape(selection.message)}"]`) ?? document.body).getPropertyValue('--zoom')) || 1} onSize={() => {}} onDismiss={() => setSelection(null)} onSubmit={() => {}} recipients={[{ id: thread.id, name: thread.title, color: "grape", attached: true }]} leadAgentId={null} activeConversationId={thread.id} onHold={(kind, text) => void attempt(() => hold(kind, text, false))} onSend={(kind, text) => void attempt(() => hold(kind, text, true))} onReplaceWord={() => {}} onAddToDictionary={() => {}} /> : null
  const bounds = panel.current?.querySelector('.conversation-reading-area')?.getBoundingClientRect()
  const recordWidth = Math.min(420, window.innerWidth - 32)
  const recordPosition = bounds ? { position: 'fixed' as const, left: Math.max(16, Math.min(panel.current?.dataset.placement === 'side' ? bounds.left + 40 : bounds.right - recordWidth - 12, window.innerWidth - recordWidth - 16)), bottom: window.innerHeight - bounds.bottom + 12, width: recordWidth, maxHeight: Math.max(120, bounds.height * .6) } : undefined
  const ownerComment = activeComment && isOwnerComment(activeComment)
  const discussionView = activeComment ? createPortal(<section style={recordPosition} className="conversation-discussion" aria-label={ownerComment ? 'Saved comment' : 'Passage discussion'}>
    <small>{ownerComment ? activeComment.state === 'held' ? 'Held comment' : activeComment.state === 'pending' ? 'Sending comment' : 'Sent comment' : 'Agent item'}</small>
    <blockquote>{activeComment.selection}</blockquote><p>{activeComment.text}</p>
    {activeComment.replies.length > 0 && <details><summary>Earlier replies</summary>{activeComment.replies.map((reply, index) => <p key={index}><strong>{reply.author === 'agent' ? 'Agent' : 'You'}</strong> {reply.text}</p>)}</details>}
    {!resolveMessageAnchor(activeComment, thread?.messages.find(message => message.id === activeComment.anchor.message)) && <p>Original passage unavailable</p>}
    <button type="button" onClick={() => open(activeComment.id)}>Jump to passage</button>
    {!ownerComment && <button type="button" onClick={() => focusReply(activeComment.id)}>Answer</button>}
    <button type="button" onClick={backToReading}>Back to reading</button>
  </section>, document.querySelector('.app-shell') ?? document.body) : null
  const navigate = (marker: ConversationMarker) => {
    setMenu(null)
    if (marker.comment) open(marker.comment)
    else { setDiscussion(null); jump(marker.message, 0, 0, 'start') }
  }

  return { navigate, selection, target, tools, tray, latestResponse: latestResponse?.id, jumpToLatest: () => { setMenu(null); if (latestResponse) jump(latestResponse.id, 0, 0, 'start') }, overlay: overlay ? createPortal(overlay, document.querySelector('.app-shell') ?? document.body) : null, discussion: activeComment, discussionView, open, setReplyItem: focusReply, outgoing, previewId, sent: () => setPreviewId(crypto.randomUUID()), selectedCount: selectedComments.length + Object.keys(selectedReplies).length,
    select: (message: string, range: EditorSelection | null) => { if (range) setSelection(previous => previous?.message === message && previous.range.from === range.from && previous.range.to === range.to ? previous : { message, range }) },
    folds: (message: string): HeadingReference[] => { if (target?.message === message) return []; try { return JSON.parse(reading[`headings:${message}`] ?? '[]') } catch { return [] } },
    foldHeading: (message: string, heading: HeadingReference, folded: boolean) => { const previous: HeadingReference[] = JSON.parse(reading[`headings:${message}`] ?? '[]'); remember(`headings:${message}`, JSON.stringify([...previous.filter(value => JSON.stringify(value) !== JSON.stringify(heading)), ...(folded ? [heading] : [])])) },
    onKeyDown: (event: React.KeyboardEvent) => { if ((event.ctrlKey || event.metaKey) && event.key === 'f') { event.preventDefault(); event.stopPropagation(); findField.current?.focus(); findField.current?.select() } },
  }
}
