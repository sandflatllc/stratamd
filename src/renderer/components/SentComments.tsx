import { useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { renderedOffsetForSource } from '../../editor/selection'
import type { SentComment } from '../../core/sent-comments'
import { MessageMarkdown } from '../messageMarkdown'
import { useDialogFocus } from '../useDialogFocus'
import './sent-comments.css'

function PassageDialog({ comment, onClose }: { comment: SentComment; onClose(): void }) {
  const dialog = useRef<HTMLElement>(null)
  useDialogFocus(dialog, onClose)
  useLayoutEffect(() => {
    if (!comment.range) return
    const ranges: Range[] = []
    for (const run of dialog.current?.querySelectorAll<HTMLElement>('[data-source-from]') ?? []) {
      const from = Number(run.dataset.sourceFrom), to = Number(run.dataset.sourceTo)
      if (from >= comment.range.to || to <= comment.range.from) continue
      const text = Array.from(run.childNodes).find((node): node is Text => node.nodeType === Node.TEXT_NODE)
      if (!text) continue
      const source = comment.passage.slice(from, to)
      const start = renderedOffsetForSource(source, text.data, Math.max(0, comment.range.from - from))
      const end = renderedOffsetForSource(source, text.data, Math.min(to, comment.range.to) - from)
      if (start === null || end === null || end <= start) continue
      const range = document.createRange()
      range.setStart(text, Math.min(start, text.length)); range.setEnd(text, Math.min(end, text.length))
      ranges.push(range)
    }
    CSS.highlights.set('sent-passage', new Highlight(...ranges))
    return () => { CSS.highlights.delete('sent-passage') }
  }, [comment])
  return createPortal(<div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <section ref={dialog} className="sent-passage-dialog" role="dialog" aria-modal="true" aria-label="Original passage" tabIndex={-1}>
      <header><strong>Original passage</strong><button type="button" onClick={onClose}>Close</button></header>
      <div className="sent-passage-body"><MessageMarkdown text={comment.passage} sourceMap /></div>
    </section>
  </div>, document.querySelector('.app-shell') ?? document.body)
}

/** One immutable send. Reading its context never moves the transcript or opens an editable comment. */
export function SentComments({ comments }: { comments: readonly SentComment[] }) {
  const [opened, setOpened] = useState<SentComment | null>(null)
  return <div className="conversation-sent-comments">
    {comments.map((comment, index) => <section className="conversation-sent-comment" key={`${comment.id}:${index}`}>
      <div className="conversation-sent-quote">
        <div className="conversation-sent-quote-label"><span>Responding to</span>{comment.passage && <button type="button" onClick={() => setOpened(comment)}>View passage <span aria-hidden="true">↗</span></button>}</div>
        <blockquote><MessageMarkdown text={comment.selection} /></blockquote>
      </div>
      <p className="conversation-sent-response">{comment.text}</p>
    </section>)}
    {opened && <PassageDialog comment={opened} onClose={() => setOpened(null)} />}
  </div>
}
