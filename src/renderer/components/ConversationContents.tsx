import { useEffect, useState } from 'react'
import type { EngineThreadView } from '../../shared/contracts'
import { conversationHeadings, readConversationReading, writeConversationReading } from '../conversationReading'

/** Shared outline and walkthrough for the side popover and center navigation. */
export function ConversationContents({ thread }: { thread: EngineThreadView | undefined | null }) {
  const [reading, setReading] = useState<Record<string, string>>({})
  const [step, setStep] = useState(0)
  useEffect(() => {
    const refresh = () => setReading(readConversationReading(thread?.id ?? ''))
    refresh(); setStep(0)
    window.addEventListener('conversation-reading', refresh)
    return () => window.removeEventListener('conversation-reading', refresh)
  }, [thread?.id])
  if (!thread) return null
  const rows = thread.messages.filter(message => message.role === 'assistant' && !message.streaming).flatMap(message => [
    { key: `mark:${message.turnId}`, message: message.id, from: 0, to: 1, level: 0, text: thread.messages.find(prompt => prompt.role === 'user' && prompt.turnId === message.turnId)?.text.slice(0, 100) || 'Exchange', items: (thread.comments ?? []).filter(comment => comment.anchor.message === message.id && comment.state !== 'resolved').length },
    ...conversationHeadings(message.id, message.prose ?? message.text).map(heading => ({ ...heading, key: `mark:${message.id}:${heading.from}`, message: message.id, items: 0 })),
  ])
  const jump = (index: number) => {
    const row = rows[index]
    if (!row) return
    setStep(index)
    window.dispatchEvent(new CustomEvent('conversation-jump', { detail: { thread: thread.id, message: row.message, from: row.from, to: row.to } }))
  }
  const mark = (key: string, value: string) => writeConversationReading(thread.id, { ...readConversationReading(thread.id), [key]: value })
  const current = rows[step]
  return <nav className="conversation-outline" aria-label="Conversation contents">
    <div className="conversation-walkthrough"><button type="button" disabled={step === 0} onClick={() => jump(step - 1)}>Previous section</button><button type="button" disabled={step >= rows.length - 1} onClick={() => jump(step + 1)}>Next section</button>{current && <><span>{step + 1} of {rows.length} · {current.text}</span><button type="button" onClick={() => mark(current.key, 'Reviewed')}>Reviewed</button><button type="button" onClick={() => mark(current.key, 'Revisit')}>Revisit</button></>}</div>
    {rows.map((row, index) => <div key={`${row.message}:${row.key}`} className="conversation-outline-row" style={{ paddingLeft: row.level * 8 }}>
      <button type="button" onClick={() => jump(index)}>{row.text}{row.level === 0 ? ` · ${row.items} items` : ''}</button>
      <select aria-label={`Reading mark ${row.text}`} value={reading[row.key] ?? ''} onChange={event => mark(row.key, event.target.value)}><option value="">Unread</option><option>Reviewed</option><option>Revisit</option></select>
    </div>)}
  </nav>
}
