import { useEffect, useState } from 'react'
import type { EngineThreadView } from '../../shared/contracts'
import { conversationHeadings } from '../conversationReading'

/** Shared outline and walkthrough for the side popover and center navigation. */
export function ConversationContents({ thread }: { thread: EngineThreadView | undefined | null }) {
  const [step, setStep] = useState(0)
  useEffect(() => { setStep(0) }, [thread?.id])
  if (!thread) return null
  const rows = thread.messages.filter(message => message.role === 'assistant' && !message.streaming).flatMap(message => [
    { key: `exchange:${message.turnId}`, message: message.id, from: 0, to: 1, level: 0, text: thread.messages.find(prompt => prompt.role === 'user' && prompt.turnId === message.turnId)?.text.slice(0, 100) || 'Exchange', items: (thread.comments ?? []).filter(comment => comment.anchor.message === message.id && comment.state !== 'resolved').length },
    ...conversationHeadings(message.id, message.prose ?? message.text).map(heading => ({ ...heading, key: `heading:${message.id}:${heading.from}`, message: message.id, items: 0 })),
  ])
  const jump = (index: number) => {
    const row = rows[index]
    if (!row) return
    setStep(index)
    window.dispatchEvent(new CustomEvent('conversation-jump', { detail: { thread: thread.id, message: row.message, from: row.from, to: row.to } }))
  }
  const current = rows[step]
  return <nav className="conversation-outline" aria-label="Conversation contents">
    <div className="conversation-walkthrough"><button type="button" disabled={step === 0} onClick={() => jump(step - 1)}>Previous section</button><button type="button" disabled={step >= rows.length - 1} onClick={() => jump(step + 1)}>Next section</button>{current && <span>{step + 1} of {rows.length} · {current.text}</span>}</div>
    {rows.map((row, index) => <div key={`${row.message}:${row.key}`} className="conversation-outline-row" style={{ paddingLeft: row.level * 8 }}>
      <button type="button" onClick={() => jump(index)}>{row.text}{row.level === 0 ? ` · ${row.items} items` : ''}</button>
    </div>)}
  </nav>
}
