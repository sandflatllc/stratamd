import { memo, useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { AttachmentView, DraftView, PanelSize, SendChangeItem, SendDocumentToken, SendEventItem, SendItems, SendPreview, SendPreviewRequest } from '../../shared/contracts'
import { AGENT_COLORS, defaultRecipientIds, previewTabIndex } from '../model'
import { InlineMarkdown } from '../inlineMarkdown'
import { useDialogFocus } from '../useDialogFocus'
import { hasPrimaryModifier, primaryModifierLabel } from '../../shared/primary-modifier'

interface SendComposerProps {
  attachments: AttachmentView[]
  drafts: DraftView[]
  leadAgentId: string | null
  activeConversationId: string | null
  /** Keys the draft: note and item choices survive closing the composer while the app runs. */
  documentPath: string
  /** Persisted size; height -1 keeps the default content sizing. */
  size: PanelSize
  zoom: number
  onSize(size: PanelSize, commit: boolean): void
  onCancel(): void
  onPreview(request: SendPreviewRequest): Promise<SendPreview[]>
  onSend(request: SendPreviewRequest): Promise<void>
}

const SIZE_LIMITS = { minWidth: 460, maxWidth: 1600, minHeight: 420, maxHeight: 1600 }
const SNIPPET_LINES = 3
const EMPTY_KEYS: readonly string[] = []

// Send is a committed decision, not a state the button can lose. A click captures
// the token-free selection on screen and waits for its preview to settle. The
// settled token is attached only when the request is dispatched.
export type SendPhase = 'idle' | 'queued' | 'sending'

export interface SendState {
  phase: SendPhase
  request: SendPreviewRequest | null
  error: string
}

export type SendEvent =
  | { type: 'submit'; request: SendPreviewRequest }
  | { type: 'preview-settled' }
  | { type: 'preview-failed'; error: unknown }
  | { type: 'send-failed'; error: unknown }

export const IDLE_SEND: SendState = { phase: 'idle', request: null, error: '' }

function messageFor(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

export function nextSendState(state: SendState, event: SendEvent): SendState {
  switch (event.type) {
    // A second click while one is already committed is the same decision, not a second delivery.
    case 'submit': return state.phase === 'idle' ? { phase: 'queued', request: event.request, error: '' } : state
    case 'preview-settled': return state.phase === 'queued' ? { ...state, phase: 'sending' } : state
    // A preview that never lands must not strand a committed click: it reports itself and leaves
    // the phase alone, and the caller drops its pending flag so `preview-settled` follows.
    // While a send is in flight the state object must keep its identity — the dispatch effect
    // uses it to know the delivery already started, and a new object here would start a second one.
    case 'preview-failed': return state.phase === 'sending' ? state : { ...state, error: messageFor(event.error, 'Could not prepare the exact text.') }
    case 'send-failed': return { phase: 'idle', request: null, error: messageFor(event.error, 'The send failed.') }
  }
}

/** What the composer remembers per document between openings (PRD §6.9 drafts). */
export interface ComposerDraft {
  note: string
  selected: readonly string[] | null
  checkedExternal: readonly string[]
  uncheckedUser: readonly string[]
  uncheckedEvents: readonly number[]
}

export const EMPTY_DRAFT: ComposerDraft = { note: '', selected: null, checkedExternal: [], uncheckedUser: [], uncheckedEvents: [] }

const composerDrafts = new Map<string, ComposerDraft>()

export function readComposerDraft(documentPath: string): ComposerDraft {
  return composerDrafts.get(documentPath) ?? EMPTY_DRAFT
}

export function isEmptyDraft(draft: ComposerDraft): boolean {
  return draft.note === '' && draft.selected === null && draft.checkedExternal.length === 0 && draft.uncheckedUser.length === 0 && draft.uncheckedEvents.length === 0
}

/** Stores a draft; an empty one is forgotten rather than kept. */
export function saveComposerDraft(documentPath: string, draft: ComposerDraft): void {
  if (isEmptyDraft(draft)) composerDrafts.delete(documentPath)
  else composerDrafts.set(documentPath, draft)
}

export function clearComposerDraft(documentPath: string): void {
  composerDrafts.delete(documentPath)
}

/** Drop drafts for documents that are no longer open (§5.16). */
export function forgetComposerDrafts(openPaths: ReadonlySet<string>): void {
  for (const path of composerDrafts.keys()) if (!openPaths.has(path)) composerDrafts.delete(path)
}

/** The one approved default recipient for this composer opening. */
export function draftRecipients(draft: ComposerDraft, attachments: readonly AttachmentView[], leadAgentId: string | null = null, activeConversationId: string | null = null): string[] {
  const ids = attachments.map((item) => item.agent.id)
  const preferred = defaultRecipientIds(attachments, leadAgentId, activeConversationId)
  if (preferred.length > 0) return preferred
  if (draft.selected === null) return defaultRecipientIds(attachments, leadAgentId, activeConversationId)
  return ids.filter((id) => draft.selected!.includes(id))
}

function sameToken(left: SendDocumentToken, right: SendDocumentToken): boolean {
  return left.snapshotId === right.snapshotId
    && left.segmentIndex === right.segmentIndex
    && left.cursor === right.cursor
}

function sameValues<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

export interface PreviewSelection {
  recipients: readonly string[]
  note: string
  checkedExternal: ReadonlySet<string>
  uncheckedUser: ReadonlySet<string>
  uncheckedEvents: ReadonlySet<number>
  externalKeys: readonly string[]
  draftIds?: readonly string[]
  /** Stored preview state may carry a token, but preview requests deliberately ignore it. */
  token?: SendDocumentToken | null
}

export function buildPreviewRequest(selection: PreviewSelection): SendPreviewRequest {
  const includeExternal = selection.checkedExternal.size > 0
  return {
    recipients: [...selection.recipients],
    note: selection.note,
    includeExternal,
    excludedHunks: [
      ...selection.uncheckedUser,
      ...(includeExternal ? selection.externalKeys.filter((key) => !selection.checkedExternal.has(key)) : []),
    ],
    excludedEvents: [...selection.uncheckedEvents],
    ...(selection.draftIds ? { draftIds: [...selection.draftIds] } : {}),
  }
}

export function commitRequest(request: SendPreviewRequest, token: SendDocumentToken): SendPreviewRequest {
  return { ...request, token }
}

function canRetainItems(previous: SendPreview, next: SendPreview): boolean {
  return previous.recipient.id === next.recipient.id
    && sameToken(previous.token, next.token)
    && previous.queuedAfter === next.queuedAfter
    && previous.resync === next.resync
    && sameValues(previous.items.changes.map((item) => item.key), next.items.changes.map((item) => item.key))
    && sameValues(previous.items.events.map((item) => item.seq), next.items.events.map((item) => item.seq))
}

/** Keeps rich item objects when only the rendered delivery text changed. */
export function mergePreviews(previous: readonly SendPreview[], next: readonly SendPreview[]): SendPreview[] {
  const byRecipient = new Map(previous.map((preview) => [preview.recipient.id, preview]))
  return next.map((preview) => {
    const retained = byRecipient.get(preview.recipient.id)
    return retained !== undefined && canRetainItems(retained, preview)
      ? { ...preview, items: retained.items }
      : preview
  })
}

export interface PreviewState {
  hasPreview: boolean
  pending: boolean
  currentRequestId: number
  previews: SendPreview[]
}

export type PreviewEvent =
  | { type: 'request-changed'; requestId: number }
  | { type: 'preview-succeeded'; requestId: number; previews: SendPreview[] }
  | { type: 'preview-failed'; requestId: number }

export const IDLE_PREVIEW: PreviewState = { hasPreview: false, pending: false, currentRequestId: 0, previews: [] }

export function nextPreviewState(state: PreviewState, event: PreviewEvent): PreviewState {
  if (event.type === 'request-changed') {
    return { ...state, pending: true, currentRequestId: event.requestId }
  }
  if (event.requestId !== state.currentRequestId) return state
  if (event.type === 'preview-failed') return { ...state, pending: false }
  return {
    hasPreview: true,
    pending: false,
    currentRequestId: state.currentRequestId,
    previews: mergePreviews(state.previews, event.previews),
  }
}

function toggled<T>(values: ReadonlySet<T>, value: T): Set<T> {
  const next = new Set(values)
  if (next.has(value)) next.delete(value)
  else next.add(value)
  return next
}

function snippetLines(lines: readonly string[], kind: 'removed' | 'added') {
  const shown = lines.filter((line) => line.trim().length > 0).slice(0, SNIPPET_LINES)
  return shown.map((line, index) => (
    <span className={`snippet-${kind}`} key={`${kind}-${index}`}><InlineMarkdown text={line} /></span>
  ))
}

function eventAuthor(item: SendEventItem): string {
  if (item.kind === 'verdict') return 'you'
  return item.author === 'user' ? 'you' : (item.name ?? 'agent')
}

function eventKindLabel(item: SendEventItem): string {
  if (item.kind === 'annotation') return item.annotationKind ?? 'comment'
  if (item.kind === 'reply') return 'reply'
  if (item.kind === 'answer') return 'answered decision'
  if (item.kind === 'verdict') return item.text === 'kept' ? 'kept their change' : 'removed their change'
  const words: Record<string, string> = {
    resolved: 'closed the thread',
    accepted: 'accepted',
    rejected: 'not taken',
    orphaned: 'text removed',
    reattached: 'text found again',
    requoted: 'moved',
  }
  return words[item.text] ?? item.text
}

interface SendItemListProps {
  items: SendItems
  checkedExternal: ReadonlySet<string>
  uncheckedUser: ReadonlySet<string>
  uncheckedEvents: ReadonlySet<number>
  dependentExternalHunks: number
  onToggleChange(item: SendChangeItem): void
  onToggleEvent(seq: number): void
  drafts: readonly DraftView[]
  selectedDrafts: ReadonlySet<string>
  onToggleDraft(id: string): void
}

const SendItemList = memo(function SendItemList({
  items,
  checkedExternal,
  uncheckedUser,
  uncheckedEvents,
  dependentExternalHunks,
  onToggleChange,
  onToggleEvent,
  drafts,
  selectedDrafts,
  onToggleDraft,
}: SendItemListProps) {
  const renders = useRef(0)
  renders.current += 1
  const userChanges = items.changes.filter((item) => item.author === 'user')
  const externalChanges = items.changes.filter((item) => item.author === 'external')
  const changeChecked = (item: SendChangeItem) => item.author === 'external'
    ? checkedExternal.has(item.key)
    : !uncheckedUser.has(item.key)
  const changeRow = (item: SendChangeItem) => (
    <label className="send-item" key={item.key} data-author={item.author} data-checked={changeChecked(item)}>
      <input type="checkbox" checked={changeChecked(item)} onChange={() => onToggleChange(item)} />
      <span className="send-item-body">
        {item.author === 'external' && <span className="send-item-meta"><strong>{item.name ?? 'Someone else'}</strong></span>}
        <span className="change-snippet">
          {snippetLines(item.removed, 'removed')}
          {snippetLines(item.added, 'added')}
        </span>
      </span>
    </label>
  )
  const visibleEvents = items.events.filter((item) => item.draftId === undefined)
  const eventRow = (item: SendEventItem) => (
    <label className="send-item send-item-event" key={`${item.kind}:${item.seq}`} data-checked={!uncheckedEvents.has(item.seq)}>
      <input type="checkbox" checked={!uncheckedEvents.has(item.seq)} onChange={() => onToggleEvent(item.seq)} />
      <span className="send-item-body">
        <span className="send-item-meta"><strong>{eventAuthor(item)}</strong><small>{eventKindLabel(item)}</small></span>
        {item.quote !== undefined && item.quote.length > 0 && <blockquote><InlineMarkdown text={item.quote} /></blockquote>}
        {item.kind !== 'verdict' && item.kind !== 'resolution' && <span className="send-item-text"><InlineMarkdown text={item.text} /></span>}
      </span>
    </label>
  )

  return (
    <div className="send-items" data-render={renders.current}>
      {drafts.length > 0 && <>
        <h3 className="send-group-heading">Your comments · {drafts.length}</h3>
        {drafts.map((draft) => <label className="send-item send-item-draft" key={draft.id} data-checked={selectedDrafts.has(draft.id)}>
          <input type="checkbox" checked={selectedDrafts.has(draft.id)} onChange={() => onToggleDraft(draft.id)} />
          <span className="send-item-body"><span className="send-item-meta"><strong>you</strong><small>{draft.kind} · draft</small></span><blockquote><InlineMarkdown text={draft.quote} /></blockquote><span className="send-item-text"><InlineMarkdown text={draft.text} /></span></span>
        </label>)}
      </>}
      {userChanges.length > 0 && <>
        <h3 className="send-group-heading">Your changes · {userChanges.length}</h3>
        {userChanges.map(changeRow)}
      </>}
      {visibleEvents.length > 0 && <>
        <h3 className="send-group-heading">Annotations · {visibleEvents.length}</h3>
        {visibleEvents.map(eventRow)}
      </>}
      {externalChanges.length > 0 && <>
        <h3 className="send-group-heading">Changes not made by you · {externalChanges.length}</h3>
        {dependentExternalHunks > 0 && <p className="send-group-note">{dependentExternalHunks} of your changes {dependentExternalHunks === 1 ? 'builds' : 'build'} on changes not made by you.</p>}
        {externalChanges.map(changeRow)}
      </>}
    </div>
  )
})

export function SendComposer({ attachments, drafts, leadAgentId, activeConversationId, documentPath, size, zoom, onSize, onCancel, onPreview, onSend }: SendComposerProps) {
  const dialogRef = useRef<HTMLElement>(null)
  const previewId = useId()
  const draft = readComposerDraft(documentPath)
  const [note, setNote] = useState(draft.note)
  const [selected, setSelected] = useState(() => draftRecipients(draft, attachments, leadAgentId, activeConversationId))
  const [selectedDrafts, setSelectedDrafts] = useState<ReadonlySet<string>>(() => new Set(drafts.map((item) => item.id)))
  const [selectionTouched, setSelectionTouched] = useState(draft.selected !== null)
  const [checkedExternal, setCheckedExternal] = useState<ReadonlySet<string>>(() => new Set(draft.checkedExternal))
  const [uncheckedUser, setUncheckedUser] = useState<ReadonlySet<string>>(() => new Set(draft.uncheckedUser))
  const [uncheckedEvents, setUncheckedEvents] = useState<ReadonlySet<number>>(() => new Set(draft.uncheckedEvents))
  useEffect(() => {
    saveComposerDraft(documentPath, {
      note,
      selected: selectionTouched ? selected : null,
      checkedExternal: [...checkedExternal],
      uncheckedUser: [...uncheckedUser],
      uncheckedEvents: [...uncheckedEvents],
    })
  }, [checkedExternal, documentPath, note, selected, selectionTouched, uncheckedEvents, uncheckedUser])
  const [externalKeys, setExternalKeys] = useState<readonly string[]>([])
  const [exact, setExact] = useState(false)
  const [previewState, setPreviewState] = useState<PreviewState>(IDLE_PREVIEW)
  const [active, setActive] = useState(0)
  const [requestInFlight, setRequestInFlight] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const [send, setSend] = useState<SendState>(IDLE_SEND)
  const dispatched = useRef<SendState | null>(null)
  const requestSequence = useRef(0)
  const startedRequest = useRef<SendPreviewRequest | null>(null)
  const startedRefresh = useRef(-1)

  const previewExternalKeys = checkedExternal.size > 0 ? externalKeys : EMPTY_KEYS
  const request = useMemo<SendPreviewRequest>(() => buildPreviewRequest({
      recipients: selected,
      note,
      checkedExternal,
      uncheckedUser,
      uncheckedEvents,
      externalKeys: previewExternalKeys,
      draftIds: drafts.filter((item) => selectedDrafts.has(item.id)).map((item) => item.id),
    }), [checkedExternal, drafts, note, previewExternalKeys, selected, selectedDrafts, uncheckedEvents, uncheckedUser])
  const requestNeedsStart = startedRequest.current !== request || startedRefresh.current !== refresh
  const pending = requestNeedsStart || previewState.pending
  const submit = useCallback(() => setSend((state) => nextSendState(state, { type: 'submit', request })), [request])
  useDialogFocus(dialogRef, onCancel)

  useEffect(() => {
    const requestId = requestSequence.current + 1
    requestSequence.current = requestId
    startedRequest.current = request
    startedRefresh.current = refresh
    let current = true
    setPreviewState((state) => nextPreviewState(state, { type: 'request-changed', requestId }))
    setRequestInFlight(false)
    const timer = window.setTimeout(() => {
      if (!current) return
      setRequestInFlight(true)
      void onPreview(request)
        .then((next) => {
          if (!current) return
          setPreviewState((state) => nextPreviewState(state, { type: 'preview-succeeded', requestId, previews: next }))
          setActive((index) => Math.min(index, Math.max(next.length - 1, 0)))
          const keys = [...new Set(next.flatMap((preview) => preview.items.changes
            .filter((change) => change.author === 'external')
            .map((change) => change.key)))].sort()
          setExternalKeys((previous) => previous.join('\n') === keys.join('\n') ? previous : keys)
          setRequestInFlight(false)
        })
        .catch((error: unknown) => {
          if (!current) return
          setPreviewState((state) => nextPreviewState(state, { type: 'preview-failed', requestId }))
          setSend((state) => nextSendState(state, { type: 'preview-failed', error }))
          setRequestInFlight(false)
        })
    }, 120)
    return () => { current = false; window.clearTimeout(timer) }
  }, [onPreview, refresh, request])

  // Reads committed preview state rather than the value the click closed over.
  useEffect(() => {
    if (!pending && send.phase === 'queued') {
      setSend((state) => nextSendState(state, { type: 'preview-settled' }))
    }
  }, [pending, send.phase])

  useEffect(() => {
    if (send.phase !== 'sending' || !send.request || dispatched.current === send) return
    dispatched.current = send
    const token = previewState.previews[0]?.token
    if (token === undefined) {
      setSend((state) => nextSendState(state, { type: 'send-failed', error: new Error(send.error || 'Could not prepare the exact text.') }))
      return
    }
    void onSend(commitRequest(send.request, token))
      .then(() => clearComposerDraft(documentPath))
      .catch((error: unknown) => {
        setSend((state) => nextSendState(state, { type: 'send-failed', error }))
        // A refused send — the document changed under the preview — re-previews at once.
        setRefresh((count) => count + 1)
      })
  }, [documentPath, onSend, previewState.previews, send])

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Enter' && hasPrimaryModifier(event) && selected.length > 0) {
        event.preventDefault()
        submit()
      }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [selected.length, submit])

  const startResize = (event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    const bounds = dialogRef.current?.getBoundingClientRect()
    const origin = { x: event.clientX, y: event.clientY, width: bounds?.width ?? size.width, height: bounds?.height ?? 560 }
    let latest = size
    const move = (next: PointerEvent) => {
      latest = {
        width: Math.round(Math.max(SIZE_LIMITS.minWidth, Math.min(SIZE_LIMITS.maxWidth, origin.width + next.clientX - origin.x))),
        height: Math.round(Math.max(SIZE_LIMITS.minHeight, Math.min(SIZE_LIMITS.maxHeight, origin.height + next.clientY - origin.y))),
      }
      onSize(latest, false)
    }
    const finish = () => {
      window.removeEventListener('pointermove', move)
      onSize(latest, true)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', finish, { once: true })
  }

  const toggleChange = useCallback((item: SendChangeItem) => {
    if (item.author === 'external') setCheckedExternal((previous) => toggled(previous, item.key))
    else setUncheckedUser((previous) => toggled(previous, item.key))
  }, [])
  const toggleEvent = useCallback((seq: number) => {
    setUncheckedEvents((previous) => toggled(previous, seq))
  }, [])
  const toggleDraft = useCallback((id: string) => setSelectedDrafts((previous) => toggled(previous, id)), [])

  const previews = previewState.previews
  const preview = previews[active]
  const dependentCount = preview?.dependentExternalHunks ?? 0
  const movePreviewFocus = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    const next = previewTabIndex(index, previews.length, event.key)
    if (next === null) return
    event.preventDefault()
    setActive(next)
    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus()
  }

  const itemsView = () => {
    if (preview === undefined) return <div className="send-empty">Select at least one recipient.</div>
    if (preview.resync === true) return <div className="send-empty">Gets the whole document to catch up.</div>
    if (preview.items.changes.length + preview.items.events.length === 0 && drafts.length === 0) {
      return <div className="send-empty">Nothing new for this agent.</div>
    }
    return <SendItemList items={preview.items} drafts={drafts} selectedDrafts={selectedDrafts} checkedExternal={checkedExternal} uncheckedUser={uncheckedUser} uncheckedEvents={uncheckedEvents} dependentExternalHunks={dependentCount} onToggleChange={toggleChange} onToggleEvent={toggleEvent} onToggleDraft={toggleDraft} />
  }

  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel() }}>
      <section
        ref={dialogRef}
        tabIndex={-1}
        className="send-composer modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="send-title"
        data-pane="composer"
        style={{ width: size.width, ...(size.height >= 0 ? { height: size.height } : {}), '--zoom': zoom } as CSSProperties}
      >
        <h2 id="send-title">Send changes</h2>
        <p className="modal-subtitle">Shares what you changed with the agents you pick · does not save</p>
        <textarea data-dialog-initial-focus value={note} onChange={(event) => setNote(event.target.value)} placeholder="Note for the recipients (optional)…" aria-label="Note for recipients" />
        {attachments.length > 1 ? (
          <fieldset className="recipients"><legend>Recipients</legend>{attachments.map((attachment) => {
            const checked = selected.includes(attachment.agent.id)
            const color = AGENT_COLORS[attachment.agent.color]
            return <label key={attachment.agent.id} data-selected={checked} style={{ borderColor: checked ? color : undefined, '--recipient-color': color } as CSSProperties}><input type="checkbox" checked={checked} onChange={() => { setSelectionTouched(true); setSelected((ids) => checked ? ids.filter((id) => id !== attachment.agent.id) : [...ids, attachment.agent.id]) }} /><i style={{ background: checked ? color : undefined }} />{attachment.agent.name}</label>
          })}</fieldset>
        ) : attachments[0] ? <div className="single-recipient">To <strong>{attachments[0].agent.name}</strong></div> : null}
        {previews.filter((item) => item.queuedAfter).map((item) => <div className="queued-notice" key={item.recipient.id}>{item.recipient.name} still has an earlier update waiting. This one arrives after it.</div>)}
        <div className="preview-heading" role="tablist" aria-label="What each agent receives">
          <strong aria-hidden="true">What each agent gets</strong>
          {previews.map((item, index) => <button type="button" role="tab" id={`${previewId}-tab-${index}`} aria-controls={`${previewId}-panel`} aria-selected={index === active} tabIndex={index === active ? 0 : -1} className={index === active ? 'active' : ''} key={item.recipient.id} onClick={() => setActive(index)} onKeyDown={(event) => movePreviewFocus(event, index)}>{item.recipient.name}</button>)}
          {previewState.hasPreview && pending && requestInFlight && <span className="preview-updating">Updating exact text…</span>}
          <button type="button" className="exact-toggle" aria-pressed={exact} onClick={() => setExact((value) => !value)}>Exact text</button>
        </div>
        <div className="send-tab-body" role="tabpanel" id={`${previewId}-panel`} aria-labelledby={preview ? `${previewId}-tab-${active}` : undefined} aria-busy={pending}>
          {!previewState.hasPreview
            ? <div className="send-empty">Preparing…</div>
            : exact
              ? <pre className="delivery-preview">{preview?.text ?? 'Select at least one recipient.'}</pre>
              : itemsView()}
        </div>
        {send.error && <div className="send-error" role="alert">{send.error}</div>}
        <div className="modal-actions"><kbd>{primaryModifierLabel()}+Enter</kbd><button type="button" className="quiet-button composer-cancel" onClick={onCancel}>Cancel</button><button type="button" className="gradient-button composer-send" disabled={selected.length === 0 || send.phase !== 'idle'} onClick={submit}>{send.phase === 'idle' ? 'Send' : 'Sending…'}</button></div>
        <button type="button" tabIndex={-1} className="send-composer-resize" aria-label="Resize" onPointerDown={startResize} />
      </section>
    </div>
  )
}
