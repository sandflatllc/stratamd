import { useState } from 'react'
import type { EngineThreadView, EngineView } from '../../shared/contracts'
export function ThreadRecoveryNotice({ engine, thread, onReconnect }: { engine: EngineView; thread: EngineThreadView; onReconnect(): void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const disconnected = engine.state === 'disconnected' || engine.state === 'connecting'
  const recovery = thread.recovery
  if (!disconnected && !recovery) return null
  const state = disconnected ? 'reconnecting' : recovery!.state
  const text = state === 'reconnecting' ? 'Reconnecting to the engine… Conversation history and your draft are available.'
    : state === 'waiting' ? 'Reconnected. Waiting for the engine to confirm work has continued.'
    : state === 'resumed' ? 'Reconnected. The engine confirmed the original turn is running.'
    : state === 'continued' ? recovery?.source === 'message' ? 'Strata sent a new continuation message. Your held answers and draft were kept.' : 'Reconnected. The engine continued work in a new turn.'
    : state === 'completed' ? 'Reconnected. This work already completed. No continuation was sent.'
    : `The engine reconnected, but could not continue ${thread.title}. Your history and draft are still here.`
  const send = async () => {
    if (busy) return
    setBusy(true); setError('')
    try { await window.strata.continueInterruptedThread(thread.id) }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) }
    finally { setBusy(false) }
  }
  return <section className="conversation-request thread-recovery-notice" data-state={state} data-testid={disconnected ? 'conversation-disconnected' : undefined} data-history-row role={state === 'failed' ? 'alert' : 'status'}>
    <span>{text}</span>
    {state === 'failed' && <><small>{error || recovery?.failure}</small><div className="conversation-actions"><button type="button" disabled={busy} onClick={onReconnect}>Check recovery</button><button type="button" disabled={busy} onClick={() => void send()}>{busy ? 'Sending continuation…' : 'Continue with a message'}</button></div></>}
    {disconnected && <button type="button" onClick={onReconnect}>Reconnect</button>}
  </section>
}
