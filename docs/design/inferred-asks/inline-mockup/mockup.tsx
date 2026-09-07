import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { AmbientContext, AmbientDecor } from '../../../../src/renderer/components/AmbientDecor'
import '@fontsource/baloo-2/400.css'
import '@fontsource/baloo-2/500.css'
import '@fontsource/baloo-2/600.css'
import '@fontsource/baloo-2/700.css'
import '@fontsource/baloo-2/800.css'
import '@fontsource/jetbrains-mono/400.css'
import '../../../../src/renderer/styles.css'
import './mockup.css'
import theme from './theme.json'
import logo from '../../../../resources/stratamd-icon.svg'

const themeStyle = Object.fromEntries(Object.entries(theme).flatMap(([group, values]) => typeof values === 'object' ? Object.entries(values).map(([key, value]) => [`--${group}-${key}`, value]) : []))
const passages = [
  { question: 'Where does the icon go when a reply had no tool calls?', context: 'The Worked for line only appears when the agent did work to fold away. A plain answer has no such line, so the icon needs another home. I recommend a slim row in the same spot, between your message and the reply, holding just the icon. The other option is to always draw a Worked for line, even for bare replies.' },
  { question: 'What happens to replies that finished while Strata was closed?', context: "They can't be scanned live. I recommend that when Strata connects, it scans the latest reply of every thread marked unread, since those are the ones you haven't seen. Threads you've already read would show the cancelled icon and scan when you click. The other option is click-to-run for all of them." }
]
function QuestionIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7.5"/><path d="M7.8 7.4a2.3 2.3 0 0 1 4.4.9c0 1.7-2.2 1.7-2.2 3.2M10 14h.01"/></svg> }
function App() {
  const state = new URLSearchParams(location.search).get('state')
  const [open, setOpen] = useState<number | null>(state === 'answer' ? 0 : null)
  const [drafts, setDrafts] = useState(['', ''])
  const [queued, setQueued] = useState<string[]>(state === 'queued' ? ['Use the slim row in the same spot. Keep the icon beside the passage.', ''] : ['', ''])
  const [sent, setSent] = useState(false)
  const popup = useRef<HTMLElement>(null)
  const [popupPosition, setPopupPosition] = useState<React.CSSProperties>({})
  useLayoutEffect(() => {
    if (open === null) return
    const position = () => {
      const bounds = document.querySelector('.mock-reading')!.getBoundingClientRect()
      const width = Math.min(420, window.innerWidth - 32)
      setPopupPosition({ position: 'fixed', left: Math.max(16, Math.min(bounds.right - width - 12, window.innerWidth - width - 16)), bottom: window.innerHeight - bounds.bottom + 12, width, maxHeight: Math.max(120, bounds.height * .6) })
    }
    position()
    window.addEventListener('resize', position)
    return () => window.removeEventListener('resize', position)
  }, [open])
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(null) }
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Element && !popup.current?.contains(event.target) && !event.target.closest('.mock-ask-tag, .mock-question-marker, .strata-annotation')) setOpen(null)
    }
    window.addEventListener('keydown', key)
    window.addEventListener('pointerdown', outside)
    return () => { window.removeEventListener('keydown', key); window.removeEventListener('pointerdown', outside) }
  }, [])
  const count = queued.filter(Boolean).length
  function reveal(index: number) { setDrafts(old => old.map((value,i) => i === index && !value ? queued[i] : value)); setOpen(index); requestAnimationFrame(() => document.getElementById(`question-${index}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })) }
  function queue(index: number) { if (!drafts[index].trim()) return; setQueued(old => old.map((value, i) => i === index ? drafts[index] : value)); setOpen(null); setSent(false) }
  function send() { if (count) { setSent(true); setQueued(['', '']) } }
  return <AmbientContext.Provider value={{ background: 'none', windows: 'stars-and-smoke', sideWindows: 'background', sideWindowOpacity: .85 }}>
    <div className="app-shell mock-shell" style={themeStyle as React.CSSProperties} data-motion="true" data-ambient-background="none" data-transcript-style="panel" data-transcript-shadow="drop-shadow">
      <header className="mock-topbar">
        <div className="mock-brand"><img src={logo} alt=""/>StrataMD⌄</div><span className="mock-tab">▧ <b>2</b>⌄</span><span className="mock-tab">▱ <b>11</b>⌄</span><span className="mock-tab">◎ <b>1</b>⌄</span>
        <span className="mock-spacer"/><span className="mock-connected">● <span>Connected</span></span><span className="mock-pending">{count} pending</span><button className="primary-button" onClick={send}>Send ↗</button><span className="mock-window-buttons">−　□　×</span>
      </header>
      <div className="mock-body">
        <aside className="mock-projects">
          <header><span>⌕</span><strong>Projects</strong></header>
          <div className="mock-project-heading">Projects <small>Recent⌄　+</small></div>
          <div className="mock-project-name">⌄ ▱ StrataMD <small>●　◎　+</small></div>
          <div className="mock-thread selected">☆ Improve Inferred Question Usefulness <small>now</small></div>
          <div className="mock-thread">☆ Eliminate Test Suite Flakes <small>1h ago</small></div>
          {['Mesa', 'Desktop', 'Haru', 'Skills Dashboard', 'File Explorer', 't3-strata', 'Outcrop', 'Open Design', 'Lodestone'].map((name,i) => <React.Fragment key={name}><div className="mock-project-name">⌄ ▱ {name}<small>◎　+</small></div>{i < 3 && <div className="mock-thread dim">☆ {['There is a new git repo called archify…', 'I am curious what can be done to my…', 'hit my session limit in this thread…'][i]}</div>}</React.Fragment>)}
          <div className="mock-settled">› Snoozed <small>0</small></div><div className="mock-settled">⌄ Settled <small>393</small></div><div className="mock-thread dim">☆ How Inferred Questions Are Made</div>
        </aside>
        <main className="mock-conversation conversation-panel" data-placement="center">
          <AmbientDecor variant="editor"/>
          <header className="mock-title"><span>◧　<span className="dim">StrataMD /</span> Improve Inferred Question Usefulness</span><span className="mock-find">⌕　Find</span></header>
          <section className="conversation-reading-area mock-reading">
            <nav className="conversation-navigator" aria-label="Conversation history"><div className="conversation-marker-list mock-markers">
              {[0,1,2,3].map(i => <span className="mock-history-tick" key={i}/>)}
              {passages.map((p,i) => <button key={i} className={`mock-question-marker ${open === i ? 'active' : ''}`} onClick={() => reveal(i)} title={`Go to question ${i+1}`} aria-label={`Go to question ${i+1}`}><QuestionIcon/><span/></button>)}
              {[0,1,2].map(i => <span className="mock-history-tick" key={i}/>)}</div></nav>
            <div className="conversation-messages mock-messages"><div className="conversation-column mock-column">
              <div className="conversation-message user mock-user"><small>You</small>What choices are still left in the plan?</div>
              <div className="mock-worked">Worked for 24s › <span className="mock-scan" title="Scan complete: 2 asks"><QuestionIcon/></span></div>
              <article className="mock-prose"><p>Two questions.</p>
                {passages.map((p,i) => <section className="mock-passage" id={`question-${i}`} key={i}>
                  <p className="mock-question-line"><span className="mock-number">{i+1}.</span> <span className={`strata-annotation strata-annotation-question ${open === i ? 'is-active' : ''}`} onClick={() => reveal(i)}>{p.question}</span> <button className={`strata-draft-chip mock-ask-tag ${queued[i] ? 'is-queued' : ''}`} onClick={() => reveal(i)} aria-label={`Answer question ${i+1}`} aria-expanded={open === i}>{queued[i] ? '✓ Drafted' : <><QuestionIcon/>Question</>}</button></p>
                  <p className="mock-context">{p.context}</p>

                </section>)}
              </article>
            </div></div>
          </section>
          <div className="mock-dock"><div className="mock-dock-handle">⌃</div><div className="mock-composer">
            {count > 0 && <details className="conversation-context-tray mock-queued" open><summary>Pending context · {count}</summary>{queued.map((answer,i) => answer && <div key={i}><input type="checkbox" checked readOnly/><button onClick={() => reveal(i)}>Reply: {answer}</button></div>)}</details>}
            <textarea aria-label="Message" placeholder="Send a message…"/><div className="mock-composer-tools"><span>◎ Astra <small>Codex sandflatgmail⌄</small></span><span>High ϟ⌄</span><span>Full access⌄</span><span className="mock-spacer"/><span>+</span><button className="mock-send" onClick={send} aria-label="Send queued answers">↑</button></div></div>
            <footer>▱ Current checkout　 <em>/home/dillonc/Projects/StrataMD</em><span>{sent ? 'Answer sent in this preview' : count ? `${count} answer queued` : ' '}</span></footer>
          </div>
        </main>
      </div>
      {open !== null && <section ref={popup} style={popupPosition} className="conversation-discussion mock-answer-popup" role="dialog" aria-label="Your answer">
        <header><strong>Your answer</strong><button className="popover-close" aria-label="Close answer" onClick={() => setOpen(null)}>×</button></header>
        <div className="reply-box"><textarea key={open} autoFocus aria-label="Your answer" placeholder="Write your answer…" value={drafts[open]} onChange={e => setDrafts(old => old.map((value,j) => open === j ? e.target.value : value))}/></div>
        <small className="mock-answer-hint">Included in your next Send</small>
        <div className="mock-answer-actions"><button className="quiet-button" onClick={() => setOpen(null)}>Cancel</button><button className="primary-button" disabled={!drafts[open].trim()} onClick={() => queue(open)}>Queue reply</button></div>
      </section>}
      <div className="mock-preview-label">INTERACTIVE MOCKUP · Example reply from this thread · Nothing is sent to an agent</div>
    </div>
  </AmbientContext.Provider>
}
createRoot(document.getElementById('root')!).render(<App/>);
