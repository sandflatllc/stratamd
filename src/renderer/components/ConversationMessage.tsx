import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { EngineMessageView, HeadingReference } from '../../shared/contracts'
import { createStrataEditor, type AnnotationRange, type EditorSelection, type StrataEditorHandle } from '../../editor'
import { isOwnerComment, resolveMessageAnchor, type MessageComment } from '../../core/conversation-delivery'
import { conversationParse } from '../conversationReading'
import { MessageMarkdown } from '../messageMarkdown'

export interface PassageTarget { message: string; from: number; to: number; serial: number; align?: 'start'; annotation?: string }
export const ConversationMessage = memo(function ConversationMessage({ message, comments, pinned, target, onSelection, onOpen, root, folds, onFold }: {
  message: EngineMessageView; comments: MessageComment[]; pinned: boolean; target: PassageTarget | null
  root: string | null; folds: HeadingReference[]; onFold(heading: HeadingReference, folded: boolean): void
  onSelection(selection: EditorSelection | null): void; onOpen(id: string): void
}) {
  const row = useRef<HTMLDivElement>(null)
  const host = useRef<HTMLDivElement>(null)
  const editor = useRef<StrataEditorHandle | null>(null)
  const [near, setNear] = useState(false)
  const [height, setHeight] = useState<number>()
  const [selected, setSelected] = useState(false)
  const latest = useRef({ onSelection, onOpen, onFold }); latest.current = { onSelection, onOpen, onFold }
  const source = message.prose ?? message.text
  const mounted = near || pinned || selected || target?.message === message.id
  useEffect(() => {
    const observer = new IntersectionObserver(entries => {
      const visible = entries[0]?.isIntersecting ?? false
      // Retain the placeholder's height while its editor mounts, so the
      // browser cannot clamp the transcript's scroll position to an empty row.
      if (visible) setHeight(previous => previous ?? row.current!.getBoundingClientRect().height)
      setNear(visible)
    }, { root: row.current?.closest('.conversation-messages') ?? null, rootMargin: '600px' })
    observer.observe(row.current!)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    const changed = () => { const selection = window.getSelection(); setSelected(Boolean(selection && !selection.isCollapsed && selection.anchorNode && selection.focusNode && row.current?.contains(selection.anchorNode) && row.current.contains(selection.focusNode))) }
    document.addEventListener('selectionchange', changed)
    return () => document.removeEventListener('selectionchange', changed)
  }, [])
  useLayoutEffect(() => {
    if (!mounted || !host.current) return
    const handle = createStrataEditor(host.current, {
      content: source, parsed: conversationParse(message.id, source), readOnly: true, ariaLabel: 'Assistant message',
      documentPath: root ? `${root}/.conversation.md` : '',
      resolveLocalMarkdown: source => root ? window.strata.resolveLocalMarkdown(`${root}/.conversation.md`, source) : Promise.resolve(null),
      onOpenLocalMarkdown: path => { void window.strata.openDocument(path) },
      onSelection: selection => latest.current.onSelection(selection),
      onOpenAnnotation: id => latest.current.onOpen(id),
      onFold: (heading, folded) => latest.current.onFold(heading, folded),
      foldedHeadings: folds,
    })
    editor.current = handle
    const observer = new ResizeObserver(() => { if (host.current) { const measured = host.current.getBoundingClientRect().height; if (measured > 0) setHeight(measured) } })
    observer.observe(host.current)
    return () => { observer.disconnect(); handle.destroy(); editor.current = null }
  }, [mounted, message.id, source, root])
  useLayoutEffect(() => {
    const ranges: AnnotationRange[] = comments.flatMap(comment => {
      const range = resolveMessageAnchor(comment, message)
      return range ? [{ id: comment.id, kind: isOwnerComment(comment) && comment.kind === 'suggestion' ? 'comment' : comment.kind, status: !isOwnerComment(comment) && comment.state === 'resolved' ? 'resolved' as const : 'open' as const, from: 0, to: 0, sourceFrom: range.from, sourceTo: range.to, quote: comment.selection, text: comment.text, author: 'user', draft: comment.state === 'held' }] : []
    })
    if (target?.message === message.id && target.align !== 'start' && !target.annotation) ranges.push({ id: 'conversation-jump', kind: 'comment', status: 'open', from: 0, to: 0, sourceFrom: target.from, sourceTo: target.to, quote: source.slice(target.from, target.to), author: 'user' })
    editor.current?.setAnnotations(ranges)
  }, [comments, target, mounted, source])
  useLayoutEffect(() => {
    editor.current?.setFoldedHeadings(folds)
  }, [folds, mounted])
  // One jump per navigation. The rich editor mounts and unmounts as the
  // reader scrolls, and the target outlives the navigation that set it, so a
  // remount would otherwise re-center the passage over wherever the reader
  // has since gone, such as the position restored by Back to reading.
  const jumped = useRef<number | null>(null)
  useLayoutEffect(() => {
    if (target?.message === message.id && target.align !== 'start' && editor.current && jumped.current !== target.serial) {
      jumped.current = target.serial
      editor.current.jumpToAnnotation(target.annotation ?? 'conversation-jump')
    }
  }, [target, mounted])
  return <div ref={row} className="conversation-rich-message" style={mounted && height !== undefined ? { minHeight: height } : undefined} data-rich-mounted={mounted || undefined}>
    {mounted ? <div ref={host} className="prosemirror-host" data-prosemirror-host /> : height !== undefined ? <div style={{ height }} aria-label="Offscreen answer" /> : <MessageMarkdown text={source} />}
  </div>
})
