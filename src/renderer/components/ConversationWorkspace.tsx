import { createPortal } from 'react-dom'
import { readDraft } from '../conversationDrafts'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ConversationInput, DraftKind, EngineThreadView, HeadingReference } from '../../shared/contracts'
import type { EditorSelection } from '../../editor/types'
import { conversationDelivery, renderConversationDelivery, resolveMessageAnchor } from '../../core/conversation-delivery'
import { conversationMatches, readConversationReading, writeConversationReading } from '../conversationReading'
import { ConversationContents } from './ConversationContents'
import { AnnotationComposer } from './AnnotationComposer'
import type { PassageTarget } from './ConversationMessage'

export function useConversationWorkspace(thread: EngineThreadView | undefined, onStart: (id: string, input: ConversationInput) => Promise<void>, onNewest: () => void) {
  const [selection, setSelection] = useState<{ message: string; range: EditorSelection; id?: string } | null>(null)
  const [discussion, setDiscussion] = useState<string | null>(null)
  const returnPosition = useRef<{ message: string; offset: number } | null>(null)
  const [replyItem, setReplyItem] = useState<string | null>(null)
  const [reply, setReply] = useState('')
  const [target, setTarget] = useState<PassageTarget | null>(null)
  const [excluded, setExcluded] = useState<string[]>([])
  const [reading, setReading] = useState<Record<string, string>>({})
  const [menu, setMenu] = useState<'contents' | 'items' | 'find' | null>(null)
  const [query, setQuery] = useState('')
  const [matchIndex, setMatchIndex] = useState(0)
  const [error, setError] = useState('')
  const [previewId, setPreviewId] = useState(() => readDraft(`thread:${thread?.id}`).messageId ?? crypto.randomUUID())
  useEffect(() => { setReading(readConversationReading(thread?.id ?? '')); setSelection(null); setDiscussion(null); setTarget(null); setReplyItem(null); setExcluded([]); setReply(''); setPreviewId(readDraft(`thread:${thread?.id}`).messageId ?? crypto.randomUUID()) }, [thread?.id])
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
  const jump = (message: string, from: number, to: number, align?: 'start') => {
    // A navigation reveal leaves the owner's persisted fold choices intact.
    setTarget(previous => ({ message, from, to, ...(align ? { align } : {}), serial: (previous?.serial ?? 0) + 1 }))
    const targetMessage = thread?.messages.find(candidate => candidate.id === message)
    if (!align && (targetMessage?.role !== 'assistant' || targetMessage.streaming)) requestAnimationFrame(() => document.querySelector(`[data-message-id="${CSS.escape(message)}"]`)?.scrollIntoView({ block: 'center' }))
  }
  useEffect(() => {
    const navigate = (event: Event) => { const detail = (event as CustomEvent).detail; if (detail.thread === thread?.id) jump(detail.message, detail.from, detail.to) }
    window.addEventListener('conversation-jump', navigate)
    return () => window.removeEventListener('conversation-jump', navigate)
  }, [thread?.id])
  const open = (id: string) => {
    const comment = comments.find(comment => comment.id === id)
    if (!comment) { setReplyItem(id); setReply(thread?.items?.find(item => item.id === id)?.draftReply ?? ''); return }
    const message = thread?.messages.find(message => message.id === comment.anchor.message)
    const range = resolveMessageAnchor(comment, message)
    if (discussion !== id) {
      const viewport = document.querySelector('.conversation-panel .conversation-messages')
      const top = viewport?.getBoundingClientRect().top ?? 0
      const row = Array.from(viewport?.querySelectorAll<HTMLElement>('[data-message-id]') ?? []).find(row => row.getBoundingClientRect().bottom > top)
      returnPosition.current = row ? { message: row.dataset.messageId!, offset: row.getBoundingClientRect().top - top } : null
    }
    setDiscussion(id)
    if (range) {
      jump(comment.anchor.message, range.from, range.to)
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
  const activeComment = comments.find(comment => comment.id === discussion)
  const backToReading = () => {
    setDiscussion(null)
    const position = returnPosition.current
    if (!position) return
    requestAnimationFrame(() => {
      const viewport = document.querySelector('.conversation-panel .conversation-messages')
      const row = viewport?.querySelector(`[data-message-id="${CSS.escape(position.message)}"]`)
      if (viewport && row) viewport.scrollTop += row.getBoundingClientRect().top - viewport.getBoundingClientRect().top - position.offset
    })
  }
  const replyRecord = thread?.items?.find(item => item.id === replyItem)
  const focusReply = (id: string) => { setReplyItem(id); setReply(thread?.items?.find(item => item.id === id)?.draftReply ?? '') }
  const latestResponse = thread?.messages.findLast(message => message.role === 'assistant')
  const toolbar = <div className="conversation-reading-tools">
    <button type="button" onClick={() => setMenu(menu === 'contents' ? null : 'contents')}>Contents</button>
    <button type="button" onClick={() => setMenu(menu === 'items' ? null : 'items')}>Items</button>
    <button type="button" onClick={() => setMenu(menu === 'find' ? null : 'find')}>Find</button>
    <button type="button" disabled={!latestResponse} onClick={() => { setMenu(null); if (latestResponse) jump(latestResponse.id, 0, 0, 'start') }}>Latest response</button>
    <button type="button" onClick={onNewest}>Newest</button>
    {menu && <div className="conversation-navigation" role="region" aria-label={`Conversation ${menu}`}>
      {menu === 'find' && <><input autoFocus aria-label="Find in conversation" value={query} onChange={event => { setQuery(event.target.value); setMatchIndex(0) }} onKeyDown={event => { if (event.key === 'Enter') findStep(matchIndex + (event.shiftKey ? -1 : 1)) }} /><span>{matches.length ? matchIndex + 1 : 0} of {matches.length}</span><button type="button" onClick={() => findStep(matchIndex - 1)}>Previous</button><button type="button" onClick={() => findStep(matchIndex + 1)}>Next</button></>}
      {menu === 'contents' && <ConversationContents thread={thread} />}
      {menu === 'items' && (thread?.items ?? []).map(item => <button type="button" key={item.id} onClick={() => { open(item.id); setMenu(null) }}>{item.status} · {item.kind}: {item.text}</button>)}
    </div>}
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
  const discussionView = activeComment ? <section className="conversation-discussion" aria-label="Passage discussion"><blockquote>{activeComment.selection}</blockquote><p>{activeComment.text}</p>{activeComment.replies.map((reply, index) => <p key={index}><strong>{reply.author === 'agent' ? 'Agent' : 'You'}</strong> {reply.text}</p>)}{!resolveMessageAnchor(activeComment, thread?.messages.find(message => message.id === activeComment.anchor.message)) && <p>Target unavailable</p>}<button type="button" onClick={() => open(activeComment.id)}>Jump to passage</button><button type="button" onClick={() => focusReply(activeComment.id)}>Reply</button>{activeComment.kind === 'suggestion' && activeComment.state !== 'held' && ['Accept', 'Reject'].map(action => <button type="button" key={action} onClick={() => void attempt(() => window.strata.queueItemReply(thread!.id, activeComment.id, action))}>{action}</button>)}{activeComment.state !== 'held' && <button type="button" onClick={() => void attempt(() => window.strata.actMessageComment(thread!.id, activeComment.id, activeComment.state === 'resolved' ? 'reopen' : 'resolve'))}>{activeComment.state === 'resolved' ? 'Reopen' : 'Resolve'}</button>}<button type="button" onClick={backToReading}>Back to reading</button></section> : null
  return { selection, target, toolbar, tray, overlay: overlay ? createPortal(overlay, document.querySelector('.app-shell') ?? document.body) : null, discussion: activeComment, discussionView, open, setReplyItem: focusReply, outgoing, previewId, sent: () => setPreviewId(crypto.randomUUID()), selectedCount: selectedComments.length + Object.keys(selectedReplies).length,
    select: (message: string, range: EditorSelection | null) => { if (range) setSelection(previous => previous?.message === message && previous.range.from === range.from && previous.range.to === range.to ? previous : { message, range }) },
    folds: (message: string): HeadingReference[] => { if (target?.message === message) return []; try { return JSON.parse(reading[`headings:${message}`] ?? '[]') } catch { return [] } },
    foldHeading: (message: string, heading: HeadingReference, folded: boolean) => { const previous: HeadingReference[] = JSON.parse(reading[`headings:${message}`] ?? '[]'); remember(`headings:${message}`, JSON.stringify([...previous.filter(value => JSON.stringify(value) !== JSON.stringify(heading)), ...(folded ? [heading] : [])])) },
    onKeyDown: (event: React.KeyboardEvent) => { if ((event.ctrlKey || event.metaKey) && event.key === 'f') { event.preventDefault(); event.stopPropagation(); setMenu('find') } },
  }
}
