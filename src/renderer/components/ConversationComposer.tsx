import './conversation-drafts.css'
import { accountForModel } from '../../core/accountState'
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { ConversationInput, EngineView, EngineThreadView, EngineModelView, VisualCommentView } from '../../shared/contracts'
import { sendCapacity, visualCaptureIds } from '../../core/visual-comments'
import { VisualCommentCard } from './VisualCommentCard'
import { continuationScope, modelDesignation, permitsSelection } from '../../shared/modelSelection'
import { ProviderGlyph } from './ProviderGlyph'
import { useContextCompaction } from '../useContextCompaction'
import { ContextWindowMeter } from './ContextWindowMeter'
import { FolderIcon, FolderGit2Icon, GitBranchIcon } from '../icons/lucide'
import { ModelPicker } from './ModelPicker'
import { availableModels, clearDraftContent, draftSelection, flushDrafts, onDraftStorage, readDraft, rememberedSelection, rememberSelection, selectionForModel, writeDraft, type ComposerSelection, type DraftAttachment } from '../conversationDrafts'
import { acceptFiles, binaryFileLabel, classifyFile } from '../../core/composer-attachments'



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

export interface ComposerSendFailure {
  draftKey: string
  message: string
  disabled: boolean
  retry(): void
}

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
  /** Native held answers need an explicit Send while their asynchronous turn continues. */
  sendWhileRunning?: boolean
  onStop?(): void
  onSend(input: ConversationInput): Promise<void>
  onSendFailureChange?(failure: ComposerSendFailure | null): void
  /** Held visual comments addressed to this thread; each rides the next Send as a staged card (docs/plans/open/visual-review). */
  visualComments?: VisualCommentView[]
  onOpenVisual?(comment: VisualCommentView): void
  /** Opens the annotation session over a staged image; a pasted image opens it at once. */
  onMarkUpImage?(attachment: DraftAttachment): void
  /** Staged images whose bytes moved into a held visual comment; they leave the list without a discard. */
  consumedAttachmentIds?: readonly string[]
}

export function ConversationComposer({ deliveryId, engine, thread, projectId, draftKey, initial, centered = false, queuedCount = 0, reservedAttachments = 0, context, canSendContext = false, workspaceControls, workspace, branch, running = false, sendWhileRunning = false, onStop, onSend, onSendFailureChange, visualComments = [], onOpenVisual, onMarkUpImage, consumedAttachmentIds = [] }: ConversationComposerProps) {
  const [draft] = useState(() => readDraft(draftKey))
  const [text, setText] = useState(draft.text)
  const [attachments, setAttachmentsState] = useState<DraftAttachment[]>(draft.attachments ?? [])
  // Two pastes can land before a render; the ref keeps the latest list for the second one.
  const latestAttachments = useRef(attachments)
  const setAttachments = (next: DraftAttachment[]) => { latestAttachments.current = next; setAttachmentsState(next) }
  /** Local storage refused the last draft write; the draft lives in memory until a later write succeeds. */
  const [unsaved, setUnsaved] = useState(false)
  const [storedSelection, setSelection] = useState(() => draftSelection(engine, draft, initial, thread !== undefined))
  /** Held visual comments the owner set aside for this Send; they stay held. */
  const [excludedVisual, setExcludedVisual] = useState<string[]>([])
  const includedVisual = visualComments.filter((comment) => !excludedVisual.includes(comment.id))
  const visualImages = includedVisual.reduce((count, comment) => count + visualCaptureIds(comment).length, 0)
  const contextFile = reservedAttachments === 1
  const capacity = sendCapacity({ files: attachments.length, visualImages, visualComments: includedVisual.length, contextFile })
  const [menu, setMenu] = useState<'models' | 'options' | 'access' | 'discard' | null>(null)
  const [busy, setBusy] = useState(false)
  const sending = useRef(false)
  const attachmentGeneration = useRef(0)
  const [error, setError] = useState('')
  const [sendFailed, setSendFailed] = useState(false)
  const retrySend = useRef<() => Promise<void>>(async () => {})
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
  const compact = useContextCompaction(engine, boundThread, selection, workspace)
  const selectedAccount = engine.accounts.find((account) => account.instanceId === selection.instanceId)
  const account = selectedAccount ? accountForModel(selectedAccount, selection.model) : undefined
  const access = accessModes.find(([id]) => id === selection.access) ?? accessModes[0]
  const descriptors = model?.options ?? []
  const selectedOptions = descriptors.map((descriptor) => {
    const value = selection.options?.find((option) => option.id === descriptor.id)?.value ?? descriptor.currentValue ?? descriptor.options?.find((option) => option.isDefault)?.id
    return { descriptor, value }
  })
  const isFastOption = (id: string, value: unknown) => id === 'fastMode' && value === true || id === 'serviceTier' && (value === 'fast' || value === 'priority')
  const fastMode = selectedOptions.some(({ descriptor, value }) => isFastOption(descriptor.id, value))
  const optionSummary = selectedOptions.flatMap(({ descriptor, value }) => {
    if (descriptor.id === 'serviceTier' && value === 'default' || isFastOption(descriptor.id, value)) return []
    const label = descriptor.options?.find((option) => option.id === value)?.label
    return label ? [label] : typeof value === 'boolean' && value ? [descriptor.label] : []
  }).join(' · ') || selection.effort || 'Model defaults'
  const valid = !compact.working && engine.state === 'connected' && !!projectId && !!model && account?.usable !== false
  const persist = (nextText: string, nextSelection: ComposerSelection, nextAttachments: DraftAttachment[]) => setUnsaved(!writeDraft(draftKey, { ...readDraft(draftKey), text: nextText, selection: nextSelection, ...(thread ? { selectionBase: initial } : {}), ...(nextAttachments.length ? { attachments: nextAttachments } : { attachments: undefined }) }))
  const choose = (next: ComposerSelection) => { setSelection(next); rememberSelection(projectId, next); persist(text, next, latestAttachments.current) }
  const chooseOption = (id: string, value: string | boolean) => {
    const effort = id === 'effort' || id === 'reasoningEffort'
    const options = (selection.options ?? []).filter(option => option.id !== id && !(effort && (option.id === 'effort' || option.id === 'reasoningEffort')))
    choose({ ...selection, ...(effort ? { effort: String(value) } : {}), options: [...options, { id, value }] })
  }
  const chooseModel = (next: EngineModelView) => {
    rememberSelection(projectId, selection)
    choose(selectionForModel(next, selection.access, next.instanceId === selection.instanceId ? selection : rememberedSelection(projectId, next.instanceId)))
  }
  /** Pasted and picked files share one path: accept, stage images with the main process, keep text inline, then save the draft. */
  const stageFiles = async (files: File[], pasted: boolean) => {
    if (canSendContext) { setError('The first turn from a document carries the document; attach files on the next turn.'); return }
    const { accepted, refusal } = acceptFiles(latestAttachments.current.length + visualImages, files, contextFile ? 1 : 0, { pasted })
    if (refusal) setError(refusal)
    const generation = attachmentGeneration.current
    let opened = false
    for (const entry of accepted) {
      try {
        let next: DraftAttachment
        if (entry.kind === 'image') {
          const [staged, thumbnail] = await Promise.all([window.strata.stageConversationAttachment({ name: entry.name, mimeType: entry.mimeType, bytes: new Uint8Array(await entry.file.arrayBuffer()) }), thumbnailFor(entry.file)])
          next = { kind: 'image', id: staged.id, name: entry.name, mimeType: entry.mimeType, sizeBytes: staged.sizeBytes, ...(thumbnail ? { thumbnail } : {}) }
        } else if (entry.kind === 'binary') {
          const staged = await window.strata.stageConversationAttachment({ name: entry.name, mimeType: entry.mimeType, bytes: new Uint8Array(await entry.file.arrayBuffer()) })
          next = { kind: 'binary', id: staged.id, name: entry.name, mimeType: entry.mimeType, sizeBytes: staged.sizeBytes }
        } else next = { kind: 'text', name: entry.name, text: await entry.file.text() }
        if (generation !== attachmentGeneration.current) {
          if (next.kind !== 'text') void window.strata.discardConversationAttachment(next.id).catch(() => {})
          continue
        }
        const list = [...latestAttachments.current, next]
        setAttachments(list); persist(text, selection, list)
        // A pasted screenshot opens the annotation session at once (docs/plans/open/visual-review); a picked file stays an attachment until Mark up.
        if (pasted && next.kind === 'image' && onMarkUpImage && !opened) { opened = true; onMarkUpImage(next) }
      } catch (failure) { setError(`Could not attach ${entry.name}: ${failure instanceof Error ? failure.message : String(failure)}`) }
    }
  }
  const removeAttachment = (index: number) => {
    const removed = latestAttachments.current[index]
    const list = latestAttachments.current.filter((_, position) => position !== index)
    setAttachments(list); persist(text, selection, list)
    if (removed && removed.kind !== 'text') window.strata.discardConversationAttachment(removed.id).catch(() => { /* The startup sweep deletes what a failed discard left behind. */ })
  }
  const removeVisual = async (comment: VisualCommentView) => {
    if (busy || sending.current) return
    setBusy(true)
    try {
      await window.strata.actVisualComment(comment.id, 'discard')
      setExcludedVisual(current => current.filter(id => id !== comment.id))
    } catch (failure) { setError(failure instanceof Error ? failure.message : `Could not remove ${comment.title}`) }
    finally { setBusy(false) }
  }
  useEffect(() => { if (centered) input.current?.focus() }, [])
  // Durable draft writes are coalesced; their outcome arrives after the keystroke that queued them.
  useEffect(() => onDraftStorage((key, stored) => { if (key === draftKey) setUnsaved(!stored) }), [draftKey])
  useEffect(() => () => { flushDrafts() }, [])
  // A staged image that became a visual comment has no bytes left to discard; it leaves the draft quietly.
  useEffect(() => {
    if (!consumedAttachmentIds.length) return
    const list = latestAttachments.current.filter((attachment) => attachment.kind !== 'image' || !consumedAttachmentIds.includes(attachment.id))
    if (list.length === latestAttachments.current.length) return
    setAttachments(list); persist(text, selection, list)
  }, [consumedAttachmentIds])
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
      const preferredWidth = menu === 'discard' ? 360 : menu === 'models' ? 420 : Math.min(menu === 'options' ? 320 : 420, box.width)
      const width = Math.min(preferredWidth, window.innerWidth - 24)
      element.style.width = `${width}px`
      element.style.left = `${Math.max(12, Math.min(menu === 'discard' ? box.right - width : box.left, window.innerWidth - width - 12))}px`
      const below = window.innerHeight - box.bottom - 20
      const above = box.top - 20
      const down = centered && (below >= 280 || below >= above)
      element.style.maxHeight = `${Math.max(100, Math.min(380, down ? below : above))}px`
      const height = element.getBoundingClientRect().height
      element.style.top = `${Math.max(12, down ? box.bottom + 6 : box.top - height - (menu === 'discard' ? 10 : 6))}px`
    }
    place()
    if (menu === 'models' || menu === 'discard') element.querySelector<HTMLElement>('button, select')?.focus({ preventScroll: true })
    const observer = new ResizeObserver(place)
    observer.observe(element)
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => { observer.disconnect(); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); if (element.matches(':popover-open')) element.hidePopover() }
  }, [menu])
  const discardMessage = () => {
    if (busy || sending.current) return
    attachmentGeneration.current += 1
    const removed = latestAttachments.current
    const { messageId: _messageId, attachments: _attachments, ...saved } = readDraft(draftKey)
    setUnsaved(!writeDraft(draftKey, { ...saved, text: '' }, { immediate: true }))
    setText(''); setAttachments([]); setError(''); setSendFailed(false); setMenu(null)
    for (const attachment of removed) if (attachment.kind !== 'text') window.strata.discardConversationAttachment(attachment.id).catch(() => { /* Startup sweep removes unreferenced files. */ })
    input.current?.focus()
  }
  const canSend = Boolean(text.trim() || attachments.length || queuedCount || canSendContext || includedVisual.length) && !capacity.refusal
  const send = async () => {
    if (sending.current || busy || !valid || !canSend) return
    sending.current = true; setBusy(true); setError(''); setSendFailed(false); setMenu(null)
    try {
      const messageId = readDraft(draftKey).messageId ?? deliveryId ?? crypto.randomUUID()
      writeDraft(draftKey, { ...readDraft(draftKey), messageId }, { immediate: true })
      // The thumbnail stays behind; the main process holds the bytes under the id.
      const outgoing = attachments.map(({ thumbnail: _thumbnail, ...attachment }) => attachment)
      await onSend({ ...selection, messageId, commandId: `strata-${messageId}`, text: text.trim(), ...(outgoing.length ? { attachments: outgoing } : {}), ...(includedVisual.length ? { visual: includedVisual.map((comment) => comment.id) } : {}) })
      // The preparation owns the staged images now; clearing the list must not discard them.
      setUnsaved(!clearDraftContent(draftKey, selection, thread ? initial : undefined)); setText(''); setAttachments([])
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'The message could not be sent. Try again.'); setSendFailed(true) }
    finally { sending.current = false; setBusy(false) }
  }
  // The composer owns submission and its frozen message id. The conversation owns
  // the transcript notice; a current ref keeps Retry aligned with this composer.
  const reportFailure = Boolean(onSendFailureChange && sendFailed && attachments.some(attachment => attachment.kind === 'binary'))
  useLayoutEffect(() => { retrySend.current = send })
  useEffect(() => {
    onSendFailureChange?.(reportFailure && error ? { draftKey, message: error, disabled: busy || !canSend, retry: () => { void retrySend.current() } } : null)
  }, [onSendFailureChange, reportFailure, error, draftKey, busy, canSend])
  useEffect(() => () => onSendFailureChange?.(null), [onSendFailureChange])

  return <form ref={root} className="chat-composer" data-centered={centered} aria-label="Conversation composer" onSubmit={(event) => { event.preventDefault(); void send() }} onKeyDown={(event) => {
    if (event.key === 'Escape' && menu) { event.preventDefault(); event.stopPropagation(); setMenu(null); input.current?.focus() }

  }}>
    <div className="chat-composer-box">
      {context && <div className="chat-context">{context}</div>}
      {visualComments.length > 0 && <div className="conversation-visual-staged" aria-label="Visual comments in this send">{visualComments.map((comment) => {
        const included = !excludedVisual.includes(comment.id)
        return <div key={comment.id} className="conversation-visual-card" data-included={included}>
          <VisualCommentCard comment={comment} compact actions={{ ...(onOpenVisual ? { onOpen: onOpenVisual } : {}) }} />
          <div className="conversation-visual-card-actions"><label><input type="checkbox" checked={included} disabled={busy} onChange={() => setExcludedVisual((current) => included ? [...current, comment.id] : current.filter((id) => id !== comment.id))} />Include</label><button type="button" aria-label={`Remove held visual comment: ${comment.title}`} title="Remove held comment" disabled={busy} onClick={() => void removeVisual(comment)}>×</button></div>
        </div>
      })}</div>}
      {attachments.length > 0 && <div className="conversation-attachments">{attachments.map((attachment, index) => <div key={attachment.kind !== 'text' ? attachment.id : `${attachment.name}:${index}`} className="conversation-attachment-preview" data-kind={attachment.kind}>{attachment.kind === 'image' && (onMarkUpImage ? <button type="button" className="conversation-attachment-markup" aria-label={`Mark up ${attachment.name}`} title="Mark up this image" disabled={busy} onClick={() => onMarkUpImage(attachment)}><img src={attachment.thumbnail ?? ''} alt="" /></button> : <img src={attachment.thumbnail ?? ''} alt="" />)}{attachment.kind === 'binary' && <span aria-hidden="true">{binaryFileLabel(attachment.name)}</span>}<strong title={attachment.name}>{attachment.name}</strong>{attachment.kind === 'binary' && <small title={attachment.mimeType}>{binaryFileLabel(attachment.name)} · {attachment.sizeBytes < 1024 * 1024 ? `${Math.ceil(attachment.sizeBytes / 1024)} KB` : `${(attachment.sizeBytes / (1024 * 1024)).toFixed(1)} MB`}</small>}<button type="button" aria-label={`Remove ${attachment.name}`} disabled={busy} onClick={() => removeAttachment(index)}>×</button></div>)}</div>}
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
            <ModelPicker models={models} accounts={engine.accounts} selection={selection} scope={scope} onSelect={(next, close) => { chooseModel(next); if (close) { setMenu(null); input.current?.focus() } }} />
          </div>}
        </div>
        <div className="chat-control"><button type="button" className="chat-pill" aria-label={fastMode ? 'Thinking and context, super speed on' : 'Thinking and context'} aria-expanded={menu === 'options'} disabled={busy} onClick={() => setMenu(menu === 'options' ? null : 'options')}>{optionSummary}{fastMode && <svg className="chat-fast-mode" viewBox="0 0 24 24" role="img" aria-label="Super speed"><title>Super speed</title><path d="M13 2 3 14h8l-1 8 11-12h-8l1-8Z" /></svg>}<span aria-hidden="true">⌄</span></button>
          {menu === 'options' && <div ref={popup} popover="manual" className="chat-menu chat-options-menu" role="region" aria-label="Model options">
            {descriptors.length === 0 && <p>This engine reports no adjustable options for this model.</p>}
            {descriptors.map((descriptor) => <fieldset key={descriptor.id}><legend>{descriptor.label}</legend>{descriptor.type === 'boolean' ? <label><input type="checkbox" checked={selection.options?.find((option) => option.id === descriptor.id)?.value === true} onChange={(event) => chooseOption(descriptor.id, event.target.checked)} />{descriptor.label}</label> : descriptor.options?.map((option) => <button type="button" key={option.id} aria-pressed={selection.options?.find((value) => value.id === descriptor.id)?.value === option.id} onClick={() => chooseOption(descriptor.id, option.id)}>{option.label}{option.isDefault && <small>Default</small>}{option.description && <span className="chat-option-description">{option.description}</span>}</button>)}</fieldset>)}
          </div>}
        </div>
        <div className="chat-control"><button type="button" className="chat-pill" aria-label="Conversation access" aria-expanded={menu === 'access'} disabled={busy} onClick={() => setMenu(menu === 'access' ? null : 'access')}>{access[1]}<span aria-hidden="true">⌄</span></button>
          {menu === 'access' && <div ref={popup} popover="manual" className="chat-menu chat-access-menu" role="region" aria-label="Access modes">{accessModes.map(([id, label, description]) => <button type="button" aria-pressed={selection.access === id} key={id} onClick={() => { choose({ ...selection, access: id }); setMenu(null) }}>{label}<span className="chat-option-description">{description}</span></button>)}</div>}
        </div>
        <div className="chat-send-actions"><input ref={fileInput} className="conversation-attachment-input" type="file" multiple hidden onChange={(event) => {
          const files = Array.from(event.target.files ?? []); event.target.value = ''
          if (files.length) void stageFiles(files, false)
        }} /><button type="button" aria-label="Attach file" disabled={busy || canSendContext} onClick={() => fileInput.current?.click()}>＋</button><ContextWindowMeter activities={boundThread?.activities ?? []} compact={compact} />{running && !busy && onStop && !sendWhileRunning
          ? <button className="chat-send chat-stop" type="button" aria-label="Stop" title="Stop the agent" onClick={onStop}><svg viewBox="0 0 20 20" aria-hidden="true"><rect x="3" y="3" width="14" height="14" rx="2" /></svg></button>
          : <button className="chat-send" type="submit" aria-label="Send" disabled={busy || !valid || !canSend}>{busy ? '…' : '↑'}</button>}</div>
      </div>
      {Boolean(text.trim() || attachments.length) && menu !== 'discard' && <div className="conversation-draft-status"><span>{unsaved ? 'Message draft in memory' : 'Message draft saved'}</span><button type="button" className="chat-pill" disabled={busy} onClick={() => setMenu('discard')}>Discard message…</button></div>}
      {menu === 'discard' && <div ref={popup} popover="manual" className="chat-menu conversation-draft-confirm" role="dialog" aria-label="Discard this message draft?">
        <h3>Discard this message draft?</h3><p>Only the unsent message and its files will be removed. Held answers and comments stay available.</p>
        <div><button type="button" onClick={() => { setMenu(null); input.current?.focus() }}>Keep draft</button><button type="button" disabled={busy} onClick={discardMessage}>Discard message</button></div>
      </div>}
    </div>
    {workspaceControls}
    {!workspaceControls && (workspace || branch) && <div className="chat-workspace"><span title={workspace}>{thread?.worktreePath ? <FolderGit2Icon /> : <FolderIcon />}{thread?.worktreePath ? 'Worktree' : 'Current checkout'}{workspace && <small>{thread?.worktreePath ?? workspace}</small>}</span>{branch && <span><GitBranchIcon />{branch}</span>}</div>}
    {queuedCount > 0 && <small>{queuedCount} answers queued</small>}
    {(attachments.length > 0 || includedVisual.length > 0) && <small className="conversation-capacity" role="status" data-over={capacity.refusal ? '' : undefined}>{capacity.refusal ?? capacity.line}</small>}
    {account?.usable === false && <p role="alert">{account.name} cannot take a turn: {account.reason ?? account.state}. Choose another model or account.</p>}
    {unsaved && <p className="conversation-draft-unsaved" role="status">This draft could not be saved and will not survive reload.</p>}
    {error && !reportFailure && <div className="send-error" role="alert">{error}{sendFailed && <button type="button" className="chat-pill" disabled={busy || !canSend} onClick={() => void send()}>Retry send</button>}</div>}
  </form>
}
