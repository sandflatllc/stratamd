import { useId, useState } from 'react'
import type { EngineActivityView } from '../../shared/contracts'
import { inputPayload } from '../../core/user-input'
import { SetupDialog } from './SetupDialog'

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {}
}

/** Native question drafts stay on this computer. Only the conversation's Send delivers held answers. */
export function UserInputDialog({ activity, draft, held, onDraft, onClose, onHold, onDismiss }: {
  activity: EngineActivityView; draft: Record<string, string> | undefined; held: boolean
  onDraft(answers: Record<string, string>): void; onClose(): void
  onHold(answers: Record<string, string>): Promise<void>; onDismiss(): Promise<void>
}) {
  const formId = useId()
  const payload = inputPayload(activity)
  const questions = Array.isArray(payload.questions) ? payload.questions.map(record) : []
  const rows = questions.length ? questions : [{ id: 'answer', question: activity.summary }]
  const [answers, setAnswers] = useState<Record<string, string>>(draft ?? {})
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const idFor = (question: Record<string, unknown>, index: number) => String(question.id ?? question.header ?? `answer-${index}`)
  const update = (id: string, answer: string) => {
    const next = { ...answers, [id]: answer }
    setAnswers(next)
    try { onDraft(next); setError('') } catch (failure) { setError(`Answer could not be saved: ${String(failure)}`) }
  }
  const act = async (action: () => Promise<void>) => {
    setBusy(true); setError('')
    try { await action() } catch (failure) { setError(String(failure)); setBusy(false) }
  }
  const dismissible = payload.responseMode === 'message'
  return <SetupDialog title="Answer question" subtitle={held ? 'Answer held. Nothing has been sent.' : dismissible ? 'The agent can keep working while you answer.' : 'The agent is waiting for your answer.'} className="user-input-dialog" onClose={() => { if (!busy) onClose() }} footer={<>
    <p className="user-input-private">Hold keeps this answer private until you press Send.</p>
    {dismissible && <button type="button" className="quiet-button" disabled={busy} onClick={() => void act(onDismiss)}>Dismiss</button>}
    <button type="submit" form={formId} className="primary-button" disabled={busy || rows.some((question, index) => !answers[idFor(question, index)]?.trim())}>Hold answer</button>
  </>}>
    <form id={formId} className="user-input-fields" onSubmit={event => { event.preventDefault(); if (!busy && rows.every((question, index) => answers[idFor(question, index)]?.trim())) void act(() => onHold(answers)) }}>{rows.map((question, index) => {
      const id = idFor(question, index)
      const options = Array.isArray(question.options) ? question.options.map(record) : []
      return <fieldset key={id} disabled={busy}><legend>{String(question.question ?? question.prompt ?? activity.summary)}</legend>
        {options.length > 0 && <div className="user-input-options">{options.map((option, index) => {
          const label = String(option.label ?? option.value ?? `Option ${index + 1}`)
          return <button type="button" aria-pressed={answers[id] === label} key={label} onClick={() => update(id, label)}>{label}</button>
        })}</div>}
        <label className="setup-field"><span>{options.length ? 'Or write an answer' : 'Your answer'}</span><input aria-label={`Answer ${id}`} placeholder="Other answer" value={options.some(option => String(option.label ?? option.value) === answers[id]) ? '' : answers[id] ?? ''} onChange={event => update(id, event.target.value)} /></label>
      </fieldset>
    })}</form>
    {error && <p role="alert">{error}</p>}
  </SetupDialog>
}
