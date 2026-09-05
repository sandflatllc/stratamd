import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { ConversationInput, EngineView, EngineThreadView } from '../../shared/contracts'
import { continuationScope, modelDesignation, permitsSelection } from '../../shared/modelSelection'
import { ProviderGlyph } from './ProviderGlyph'
import { ModelPicker } from './ModelPicker'
import { availableModels, clearDraft, readDraft, rememberSelection, selectionForModel, writeDraft, type ComposerSelection, type DraftAttachment } from '../conversationDrafts'
import { acceptFiles, classifyFile, SUPPORTED_IMAGE_TYPES } from '../../core/composer-attachments'

const PICKER_ACCEPT = ['text/*', '.md', '.markdown', '.json', '.csv', '.ts', '.tsx', '.js', '.py', ...SUPPORTED_IMAGE_TYPES].join(',')

/** A preview small enough to live in the draft; the real bytes stay with the main process. */
async function thumbnailFor(file: File): Promise<string | undefined> {
  try {
    const bitmap = await createImageBitmap(file)
    const scale = Math.min(1, 96 / Math.max(bitmap.width, bitmap.height, 1))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bitmap.width * scale))
    canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    bitmap.close()
    return canvas.toDataURL('image/webp', 0.8)
  } catch { return undefined }
}

const accessModes = [
  ['approval-required', 'Supervised', 'Ask before commands and file changes.'],
  ['auto-accept-edits', 'Auto-accept edits', 'Approve edits, ask before other actions.'],
  ['auto', 'Auto', 'Supported providers approve routine actions; others still ask.'],
  ['full-access', 'Full access', 'Allow commands and edits without prompts.'],
] as const

export interface ConversationComposerProps {
  deliveryId?: string
  engine: EngineView
  thread?: EngineThreadView | undefined
  projectId: string
  draftKey: string
  initial: ComposerSelection
  centered?: boolean
  queuedCount?: number
  /** 1 when the send will add Strata's context file, which counts toward T3's attachment limit (§6.0). */
  reservedAttachments?: 0 | 1
  context?: ReactNode
  canSendContext?: boolean
  workspaceControls?: ReactNode
  workspace?: string
  branch?: string | null
  /** While the agent works, the Send button becomes Stop, as in T3. Enter still sends. */
  running?: boolean
  onStop?(): void
  onSend(input: ConversationInput): Promise<void>
}

export function ConversationComposer({ deliveryId, engine, thread, projectId, draftKey, initial, centered = false, queuedCount = 0, reservedAttachments = 0, context, canSendContext = false, workspaceControls, workspace, branch, running = false, onStop, onSend }: ConversationComposerProps) {
  const [draft] = useState(() => readDraft(draftKey))
  const [text, setText] = useState(draft.text)
  const [attachments, setAttachmentsState] = useState<DraftAttachment[]>(draft.attachments ?? [])
  // Two pastes can land before a render; the ref keeps the latest list for the second one.
  const latestAttachments = useRef(attachments)
  const setAttachments = (next: DraftAttachment[]) => { latestAttachments.current = next; setAttachmentsState(next) }
  /** Local storage refused the last draft write; the draft lives in memory until a later write succeeds. */
  const [unsaved, setUnsaved] = useState(false)
  const [storedSelection, setSelection] = useState(draft.selection ?? initial)
  const [menu, setMenu] = useState<'models' | 'options' | 'access' | null>(null)
  const [busy, setBusy] = useState(false)
  const sending = useRef(false)
  const [error, setError] = useState('')
  const root = useRef<HTMLFormElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const popup = useRef<HTMLDivElement>(null)
  const allModels = availableModels(engine)
  const boundThread = thread ?? engine.projects.flatMap(project => project.threads).find(candidate => candidate.id === readDraft(draftKey).threadId)
  const driverFor = (instanceId: string | null | undefined) => engine.accounts.find(account => account.instanceId === instanceId)?.driver ?? allModels.find(model => model.instanceId === instanceId)?.driver
  const scope = boundThread ? continuationScope({ instanceId: boundThread.providerInstanceId, model: boundThread.model, driver: driverFor(boundThread.providerInstanceId) }) : undefined
  const models = allModels.filter(model => permitsSelection(scope, { instanceId: model.instanceId, model: model.slug, driver: model.driver }))
  const selection = permitsSelection(scope, { instanceId: storedSelection.instanceId ?? '', model: storedSelection.model, driver: driverFor(storedSelection.instanceId) }) ? storedSelection : boundThread ? { model: boundThread.model, instanceId: boundThread.providerInstanceId, effort: boundThread.effort, options: boundThread.options ?? [], access: storedSelection.access } : initial
  const model = models.find((model) => model.slug === selection.model && model.instanceId === selection.instanceId)
  const account = engine.accounts.find((account) => account.instanceId === selection.instanceId)
  const access = accessModes.find(([id]) => id === selection.access) ?? accessModes[0]
  const descriptors = model?.options ?? []
  const optionSummary = descriptors.flatMap((descriptor) => {
    const value = selection.options?.find((option) => option.id === descriptor.id)?.value ?? descriptor.currentValue ?? descriptor.options?.find((option) => option.isDefault)?.id
    const label = descriptor.options?.find((option) => option.id === value)?.label
    return label ? [label] : typeof value === 'boolean' && value ? [descriptor.label] : []
  }).join(' · ') || selection.effort || 'Model defaults'
  const valid = engine.state === 'connected' && !!projectId && !!model && account?.usable !== false
  const persist = (nextText: string, nextSelection: ComposerSelection, nextAttachments: DraftAttachment[]) => setUnsaved(!writeDraft(draftKey, { ...readDraft(draftKey), text: nextText, selection: nextSelection, ...(nextAttachments.length ? { attachments: nextAttachments } : { attachments: undefined }) }))
  const choose = (next: ComposerSelection) => { setSelection(next); rememberSelection(projectId, next); persist(text, next, latestAttachments.current) }
  /** Pasted and picked files share one path: accept, stage images with the main process, keep text inline, then save the draft. */
  const stageFiles = async (files: File[], pasted: boolean) => {
    if (canSendContext) { setError('The first turn from a document carries the document; attach files on the next turn.'); return }
    const { accepted, refusal } = acceptFiles(latestAttachments.current.length, files, reservedAttachments, { pasted })
    if (refusal) setError(refusal)
    for (const entry of accepted) {
      try {
        let next: DraftAttachment
        if (entry.kind === 'image') {
          const [staged, thumbnail] = await Promise.all([window.strata.stageConversationAttachment({ name: entry.name, mimeType: entry.mimeType, bytes: new Uint8Array(await entry.file.arrayBuffer()) }), thumbnailFor(entry.file)])
          next = { kind: 'image', id: staged.id, name: entry.name, mimeType: entry.mimeType, sizeBytes: staged.sizeBytes, ...(thumbnail ? { thumbnail } : {}) }
        } else next = { kind: 'text', name: entry.name, text: await entry.file.text() }
        const list = [...latestAttachments.current, next]
        setAttachments(list); persist(text, selection, list)
      } catch (failure) { setError(`Could not attach ${entry.name}: ${failure instanceof Error ? failure.message : String(failure)}`) }
    }
  }
  const removeAttachment = (index: number) => {
    const removed = latestAttachments.current[index]
    const list = latestAttachments.current.filter((_, position) => position !== index)
    setAttachments(list); persist(text, selection, list)
    if (removed?.kind === 'image') window.strata.discardConversationAttachment(removed.id).catch(() => { /* The startup sweep deletes what a failed discard left behind. */ })
  }
  useEffect(() => { if (centered) input.current?.focus() }, [])
  useEffect(() => {
    if (!storedSelection.model && initial.model) setSelection(initial)
  }, [initial.model])
  useEffect(() => {
    if (!menu) return
    const dismiss = (event: MouseEvent) => { if (!popup.current?.contains(event.target as Node) && !(event.target instanceof Element && event.target.closest('.chat-pill'))) setMenu(null) }
    document.addEventListener('mousedown', dismiss)
    return () => document.removeEventListener('mousedown', dismiss)
  }, [menu])
  useLayoutEffect(() => {
    const element = popup.current
    if (!menu || !element) return
    element.showPopover()
    const place = () => {
      const box = root.current!.getBoundingClientRect()
      const preferredWidth = menu === 'models' ? 420 : Math.min(menu === 'options' ? 320 : 420, box.width)
      const width = Math.min(preferredWidth, window.innerWidth - 24)
      element.style.width = `${width}px`
      element.style.left = `${Math.max(12, Math.min(box.left, window.innerWidth - width - 12))}px`
      const below = window.innerHeight - box.bottom - 20
      const above = box.top - 20
      const down = centered && (below >= 280 || below >= above)
      element.style.maxHeight = `${Math.max(100, Math.min(380, down ? below : above))}px`
      const height = element.getBoundingClientRect().height
      element.style.top = `${Math.max(12, down ? box.bottom + 6 : box.top - height - 6)}px`
    }
    place()
    if (menu === 'models') element.querySelector<HTMLElement>('button, select')?.focus({ preventScroll: true })
    const observer = new ResizeObserver(place)
    observer.observe(element)
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => { observer.disconnect(); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); if (element.matches(':popover-open')) element.hidePopover() }
  }, [menu])
  const send = async () => {
    if (sending.current || !valid || (!text.trim() && !attachments.length && !queuedCount && !canSendContext)) return
    sending.current = true; setBusy(true); setError(''); setMenu(null)
    try {
      const messageId = readDraft(draftKey).messageId ?? deliveryId ?? crypto.randomUUID()
      writeDraft(draftKey, { ...readDraft(draftKey), messageId })
      // The thumbnail stays behind; the main process holds the bytes under the id.
      const outgoing = attachments.map(({ thumbnail: _thumbnail, ...attachment }) => attachment)
      await onSend({ ...selection, messageId, commandId: `strata-${messageId}`, text: text.trim(), ...(outgoing.length ? { attachments: outgoing } : {}) })
      // The preparation owns the staged images now; clearing the list must not discard them.
      clearDraft(draftKey); setText(''); setAttachments([]); setUnsaved(false)
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'The message could not be sent. Try again.') }
    finally { sending.current = false; setBusy(false) }
  }
  return <form ref={root} className="chat-composer" data-centered={centered} aria-label="Conversation composer" onSubmit={(event) => { event.preventDefault(); void send() }} onKeyDown={(event) => {
    if (event.key === 'Escape' && menu) { event.preventDefault(); event.stopPropagation(); setMenu(null); input.current?.focus() }

  }}>
    <div className="chat-composer-box">
      {context && <div className="chat-context">{context}</div>}
      {attachments.length > 0 && <div className="conversation-attachments">{attachments.map((attachment, index) => <div key={attachment.kind === 'image' ? attachment.id : `${attachment.name}:${index}`} className="conversation-attachment-preview" data-kind={attachment.kind}>{attachment.kind === 'image' && <img src={attachment.thumbnail ?? ''} alt="" />}<strong title={attachment.name}>{attachment.name}</strong><button type="button" aria-label={`Remove ${attachment.name}`} disabled={busy} onClick={() => removeAttachment(index)}>×</button></div>)}</div>}
      <textarea ref={input} aria-label="Message conversation" placeholder="Ask for changes, send follow-ups, or attach a file" value={text} disabled={busy} onChange={(event) => { setText(event.target.value); persist(event.target.value, selection, latestAttachments.current) }} onKeyDown={(event) => {
        if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); void send() }
      }} onPaste={(event) => {
        // An image on the clipboard becomes an attachment, as in T3; files with no text alongside do too. Plain text pastes as text.
        const files = Array.from(event.clipboardData.files)
        if (files.length === 0) return
        const claims = files.some((file) => classifyFile(file).kind !== 'text') || !event.clipboardData.getData('text/plain')
        if (!claims) return
        event.preventDefault()
        void stageFiles(files, true)
      }} />
      <div className="chat-controls">
        <div className="chat-control"><button type="button" className="chat-pill" aria-label="Choose model and account" aria-expanded={menu === 'models'} disabled={busy} onClick={() => setMenu(menu === 'models' ? null : 'models')} title={model?.name ?? model?.accountName}>{model ? <><ProviderGlyph driver={model.driver} />{modelDesignation(model)}</> : (selection.model || 'Choose model')}<small>{model?.accountName}</small><span aria-hidden="true">⌄</span></button>
          {menu === 'models' && <div ref={popup} popover="manual" className="chat-menu chat-model-menu" aria-label="Models and accounts" role="region">
            <ModelPicker models={models} accounts={engine.accounts} selection={selection} scope={scope} onSelect={(next, close) => { choose(selectionForModel(next, selection.access)); if (close) { setMenu(null); input.current?.focus() } }} />
          </div>}
        </div>
        <div className="chat-control"><button type="button" className="chat-pill" aria-label="Thinking and context" aria-expanded={menu === 'options'} disabled={busy} onClick={() => setMenu(menu === 'options' ? null : 'options')}>{optionSummary}<span aria-hidden="true">⌄</span></button>
          {menu === 'options' && <div ref={popup} popover="manual" className="chat-menu chat-options-menu" role="region" aria-label="Model options">
            {descriptors.length === 0 && <p>This engine reports no adjustable options for this model.</p>}
            {descriptors.map((descriptor) => <fieldset key={descriptor.id}><legend>{descriptor.label}</legend>{descriptor.type === 'boolean' ? <label><input type="checkbox" checked={selection.options?.find((option) => option.id === descriptor.id)?.value === true} onChange={(event) => choose({ ...selection, options: [...(selection.options ?? []).filter((option) => option.id !== descriptor.id), { id: descriptor.id, value: event.target.checked }] })} />{descriptor.label}</label> : descriptor.options?.map((option) => <button type="button" key={option.id} aria-pressed={selection.options?.find((value) => value.id === descriptor.id)?.value === option.id} onClick={() => choose({ ...selection, ...(descriptor.id === 'effort' ? { effort: option.id } : {}), options: [...(selection.options ?? []).filter((value) => value.id !== descriptor.id), { id: descriptor.id, value: option.id }] })}>{option.label}{option.isDefault && <small>Default</small>}{option.description && <span className="chat-option-description">{option.description}</span>}</button>)}</fieldset>)}
          </div>}
        </div>
        <div className="chat-control"><button type="button" className="chat-pill" aria-label="Conversation access" aria-expanded={menu === 'access'} disabled={busy} onClick={() => setMenu(menu === 'access' ? null : 'access')}>{access[1]}<span aria-hidden="true">⌄</span></button>
          {menu === 'access' && <div ref={popup} popover="manual" className="chat-menu chat-access-menu" role="region" aria-label="Access modes">{accessModes.map(([id, label, description]) => <button type="button" aria-pressed={selection.access === id} key={id} onClick={() => { choose({ ...selection, access: id }); setMenu(null) }}>{label}<span className="chat-option-description">{description}</span></button>)}</div>}
        </div>
        <div className="chat-send-actions"><input ref={fileInput} className="conversation-attachment-input" type="file" accept={PICKER_ACCEPT} multiple hidden onChange={(event) => {
          const files = Array.from(event.target.files ?? []); event.target.value = ''
          if (files.length) void stageFiles(files, false)
        }} /><button type="button" aria-label="Attach file" disabled={busy || canSendContext} onClick={() => fileInput.current?.click()}>＋</button>{running && !busy && onStop
          ? <button className="chat-send chat-stop" type="button" aria-label="Stop" title="Stop the agent" onClick={onStop}><svg viewBox="0 0 12 12" aria-hidden="true"><rect x="2.5" y="2.5" width="7" height="7" rx="1.5" /></svg></button>
          : <button className="chat-send" type="submit" aria-label="Send" disabled={busy || !valid || (!text.trim() && !attachments.length && !queuedCount && !canSendContext)}>{busy ? '…' : '↑'}</button>}</div>
      </div>
    </div>
    {workspaceControls}
    {!workspaceControls && (workspace || branch) && <div className="chat-workspace"><span title={workspace}>▱ {thread?.worktreePath ? 'Worktree' : 'Current checkout'}{workspace && <small>{thread?.worktreePath ?? workspace}</small>}</span>{branch && <span>{branch}</span>}</div>}
    {queuedCount > 0 && <small>{queuedCount} answers queued</small>}
    {account?.usable === false && <p role="alert">{account.name} cannot take a turn: {account.reason ?? account.state}. Choose another account.</p>}
    {unsaved && <p className="conversation-draft-unsaved" role="status">This draft could not be saved and will not survive reload.</p>}
    {error && <p className="send-error" role="alert">{error}</p>}
  </form>
}
