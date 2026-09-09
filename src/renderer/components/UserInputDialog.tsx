import { useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { acceptFiles } from '../../core/composer-attachments'
import { visualImageUrl } from '../../shared/visual-urls'
import { loadImage } from '../visualImage'
import { VisualSession } from './VisualSession'
import { QuestionFiles } from './QuestionFiles'
import type { ConversationAttachment, VisualCaptureView, EngineActivityView } from '../../shared/contracts'
import { inputPayload } from '../../core/user-input'
import { SetupDialog } from './SetupDialog'

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {}
}

/** Native question drafts stay on this computer. Only the conversation's Send delivers held answers. */
export function UserInputDialog({ activity, draft, files = {}, held, projectId, threadId, reservedFiles = 0, onOpenFile, onDraft, onClose, onHold, onDismiss }: {
  activity: EngineActivityView; draft: Record<string, string> | undefined; held: boolean
  files?: Record<string, ConversationAttachment[]>; projectId: string; threadId: string; reservedFiles?: number
  onOpenFile?(file: ConversationAttachment): void
  onDraft(answers: Record<string, string>, files: Record<string, ConversationAttachment[]>): void; onClose(): void
  onHold(answers: Record<string, string>, files: Record<string, ConversationAttachment[]>): Promise<void>; onDismiss(): Promise<void>
}) {
  const formId = useId()
  const payload = inputPayload(activity)
  const questions = Array.isArray(payload.questions) ? payload.questions.map(record) : []
  const rows = questions.length ? questions : [{ id: 'answer', question: activity.summary }]
  const [answers, setAnswers] = useState<Record<string, string>>(draft ?? {})
  const [answerFiles, setAnswerFiles] = useState(files)
  const [markup, setMarkup] = useState<{ questionId: string; file: ConversationAttachment; capture: VisualCaptureView } | null>(null)
  const fileInputs = useRef<Record<string, HTMLInputElement | null>>({})
  const [failedFile, setFailedFile] = useState<{ id: string; name: string } | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const idFor = (question: Record<string, unknown>, index: number) => String(question.id ?? question.header ?? `answer-${index}`)
  const update = (id: string, answer: string) => {
    const next = { ...answers, [id]: answer }
    setAnswers(next)
    try { onDraft(next, answerFiles); setError('') } catch (failure) { setError(`Answer could not be saved: ${String(failure)}`) }
  }
  const act = async (action: () => Promise<void>) => {
    setBusy(true); setError('')
    try { await action() } catch (failure) { setError(String(failure)); setBusy(false) }
  }
  const saveFiles = (questionId: string, next: ConversationAttachment[], nextAnswers = answers) => {
    const files = { ...answerFiles, [questionId]: next }
    onDraft(nextAnswers, files); setAnswerFiles(files); setAnswers(nextAnswers)
  }
  const stage = async (questionId: string, picked: File[], pasted = false) => {
    if (busy) return
    setBusy(true); setError(''); setFailedFile(null)
    try {
      const accepted = acceptFiles(Object.values(answerFiles).flat().length + reservedFiles, picked, 0, { pasted })
      if (accepted.refusal) { setError(accepted.refusal); setFailedFile({ id: questionId, name: picked[0]?.name ?? 'file' }) }
      const added: ConversationAttachment[] = []
      for (const entry of accepted.accepted) {
        try {
          if (entry.kind === 'text' && !/\.html?$/i.test(entry.name)) added.push({ kind: 'text', name: entry.name, text: await entry.file.text() })
          else {
            const staged = await window.strata.stageConversationAttachment({ name: entry.name, mimeType: entry.kind === 'text' ? 'text/html' : entry.mimeType, bytes: new Uint8Array(await entry.file.arrayBuffer()) })
            added.push({ kind: entry.kind === 'text' ? 'binary' : entry.kind, id: staged.id, name: entry.name, mimeType: entry.kind === 'text' ? 'text/html' : entry.mimeType, sizeBytes: staged.sizeBytes })
          }
        } catch (failure) { setError(`Could not read ${entry.name}. Choose it again to attach it. ${String(failure)}`); setFailedFile({ id: questionId, name: entry.name }); break }
      }
      if (added.length) saveFiles(questionId, [...(answerFiles[questionId] ?? []), ...added])
    } catch (failure) { setError(String(failure)) }
    finally { setBusy(false) }
  }
  const ready = rows.every((question, index) => answers[idFor(question, index)]?.trim() || answerFiles[idFor(question, index)]?.length)
  const heldAnswers = () => Object.fromEntries(rows.map((question, index) => { const id = idFor(question, index); return [id, answers[id] ?? ''] }))
  const markUp = async (questionId: string, file: ConversationAttachment) => {
    if (file.kind !== 'image') return
    try { const url = visualImageUrl('staged', file.id); const image = await loadImage(url); setMarkup({ questionId, file, capture: { id: file.id, url, width: image.naturalWidth, height: image.naturalHeight } }) }
    catch (failure) { setError(`Could not open ${file.name}. ${String(failure)}`) }
  }
  if (markup) return createPortal(<VisualSession capture={markup.capture} projectId={projectId} destination={{ threadId, threadTitle: 'Answer question' }} place={`Answer file · ${markup.file.name}`} returnToComposer={false} onClose={() => setMarkup(null)} onError={setError} onHold={async input => {
    const bytes = input.marked[0]?.bytes
    if (!bytes) throw new Error(`No marked image was produced for ${markup.file.name}`)
    const name = markup.file.name.replace(/\.[^.]+$/, '') + '-marked.png'
    const staged = await window.strata.stageConversationAttachment({ name, mimeType: 'image/png', bytes })
    const next: ConversationAttachment = { kind: 'image', id: staged.id, name, mimeType: 'image/png', sizeBytes: staged.sizeBytes }
    saveFiles(markup.questionId, (answerFiles[markup.questionId] ?? []).map(file => file === markup.file ? next : file), { ...answers, [markup.questionId]: [answers[markup.questionId], input.text].filter(Boolean).join('\n') })
    return staged.id
  }} />, document.querySelector('.app-shell') ?? document.body)
  const dismissible = payload.responseMode === 'message'
  return <SetupDialog title="Answer question" subtitle={held ? 'Answer held. Nothing has been sent.' : dismissible ? 'The agent can keep working while you answer.' : 'The agent is waiting for your answer.'} className="user-input-dialog" onClose={() => { if (!busy) onClose() }} footer={<>
    <p className="user-input-private">Hold keeps this answer private until you press Send.</p>
    {dismissible && <button type="button" className="quiet-button" disabled={busy} onClick={() => void act(onDismiss)}>Dismiss</button>}
    <button type="submit" form={formId} className="primary-button" disabled={busy || !ready || !!failedFile}>Hold answer</button>
  </>}>
    <form id={formId} className="user-input-fields" onSubmit={event => { event.preventDefault(); if (!busy && ready && !failedFile) void act(() => onHold(heldAnswers(), answerFiles)) }}>{rows.map((question, index) => {
      const id = idFor(question, index)
      const options = Array.isArray(question.options) ? question.options.map(record) : []
      return <fieldset key={id} disabled={busy} onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); if (question.allowCustomAnswer !== false) void stage(id, Array.from(event.dataTransfer.files)) }} onPaste={event => { if (event.clipboardData.files.length && question.allowCustomAnswer !== false) { event.preventDefault(); void stage(id, Array.from(event.clipboardData.files), true) } }}><legend>{String(question.question ?? question.prompt ?? activity.summary)}</legend>
        {options.length > 0 && <div className="user-input-options">{options.map((option, index) => {
          const label = String(option.label ?? option.value ?? `Option ${index + 1}`)
          return <button type="button" aria-pressed={answers[id] === label} key={label} onClick={() => update(id, label)}>{label}</button>
        })}</div>}
        {question.allowCustomAnswer !== false && <><label className="setup-field"><span>{options.length ? 'Or write an answer' : 'Your answer'}</span><input aria-label={`Answer ${id}`} placeholder="Other answer" value={options.some(option => String(option.label ?? option.value) === answers[id]) ? '' : answers[id] ?? ''} onChange={event => update(id, event.target.value)} /></label>
        <div className="question-files" aria-label={`Files for ${id}`}>{failedFile?.id === id && <div className="conversation-attachment-preview" data-kind="binary"><span>FILE</span><strong>{failedFile.name}</strong><small>Could not stage this file</small></div>}<QuestionFiles files={answerFiles[id] ?? []} onRemove={index => { try { saveFiles(id, (answerFiles[id] ?? []).filter((_, position) => position !== index)); setError('') } catch (failure) { setError(String(failure)) } }} onMarkUp={file => void markUp(id, file)} {...(onOpenFile ? { onOpen: onOpenFile } : {})} />
          <input ref={element => { fileInputs.current[id] = element }} type="file" multiple hidden aria-label={`Attach to answer ${id}`} onChange={event => { const files = Array.from(event.target.files ?? []); event.target.value = ''; void stage(id, files) }} />
          <button type="button" className="question-attach" onClick={() => fileInputs.current[id]?.click()}>Attach to answer</button>
        </div></>}
      </fieldset>
    })}</form>
    {error && <div className="question-file-error" role="alert"><p>{error}</p>{failedFile && <><button type="button" className="question-attach" onClick={() => fileInputs.current[failedFile.id]?.click()}>Choose file again</button><button type="button" className="quiet-button" onClick={() => { setFailedFile(null); setError('') }}>Remove failed file</button></>}</div>}
  </SetupDialog>
}
