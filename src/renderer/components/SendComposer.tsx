import { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { AttachmentView, PanelSize, SendChangeItem, SendDocumentToken, SendEventItem, SendPreview, SendPreviewRequest } from '../../shared/contracts'
import { AGENT_COLORS, previewTabIndex } from '../model'
import { InlineMarkdown } from '../inlineMarkdown'
import { useDialogFocus } from '../useDialogFocus'
import { hasPrimaryModifier, primaryModifierLabel } from '../../shared/primary-modifier'

interface SendComposerProps {
  attachments: AttachmentView[]
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

// Send is a committed decision, not a state the button can lose. Toggling a
// recipient or an item starts a fresh preview, and the old button disabled
// itself for the duration, so a click landing in that window hit a button that
// changed under it and vanished (docs/plans/open/performance-plan.md, "Send trace
// result"). Instead the click always commits: it captures the exact request on
// screen — exclusions and the previewed document token included — and parks in
// `queued` until the in-flight preview settles, so the user still only sends
// text the composer rendered, but the click itself cannot be dropped. The
// button disables from `queued` onward, which keeps the old guarantee that an
// in-progress send shows `Sending…` and cannot double-fire.
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

function sameToken(left: SendDocumentToken, right: SendDocumentToken): boolean {
  return left.snapshotId === right.snapshotId
    && left.segmentIndex === right.segmentIndex
    && left.cursor === right.cursor
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

export function SendComposer({ attachments, size, zoom, onSize, onCancel, onPreview, onSend }: SendComposerProps) {
  const dialogRef = useRef<HTMLElement>(null)
  const previewId = useId()
  const [note, setNote] = useState('')
  const [selected, setSelected] = useState(() => attachments.map((item) => item.agent.id))
  const [checkedExternal, setCheckedExternal] = useState<ReadonlySet<string>>(() => new Set())
  const [uncheckedUser, setUncheckedUser] = useState<ReadonlySet<string>>(() => new Set())
  const [uncheckedEvents, setUncheckedEvents] = useState<ReadonlySet<number>>(() => new Set())
  const [externalKeys, setExternalKeys] = useState<readonly string[]>([])
  const [token, setToken] = useState<SendDocumentToken | null>(null)
  const [exact, setExact] = useState(false)
  const [previews, setPreviews] = useState<SendPreview[]>([])
  const [active, setActive] = useState(0)
  const [loading, setLoading] = useState(true)
  const [refresh, setRefresh] = useState(0)
  const [send, setSend] = useState<SendState>(IDLE_SEND)
  const dispatched = useRef<SendState | null>(null)

  const request = useMemo<SendPreviewRequest>(() => {
    const includeExternal = checkedExternal.size > 0
    return {
      recipients: selected,
      note,
      includeExternal,
      excludedHunks: [
        ...uncheckedUser,
        ...(includeExternal ? externalKeys.filter((key) => !checkedExternal.has(key)) : []),
      ],
      excludedEvents: [...uncheckedEvents],
      ...(token === null ? {} : { token }),
    }
  }, [checkedExternal, externalKeys, note, selected, token, uncheckedEvents, uncheckedUser])
  const submit = useCallback(() => setSend((state) => nextSendState(state, { type: 'submit', request })), [request])
  useDialogFocus(dialogRef, onCancel)

  useEffect(() => {
    let current = true
    setLoading(true)
    const timer = window.setTimeout(() => {
      void onPreview(request)
        .then((next) => {
          if (!current) return
          setPreviews(next)
          setActive((index) => Math.min(index, Math.max(next.length - 1, 0)))
          // Token and item universe update only on real change, so the request
          // memo settles instead of previewing in a loop.
          const nextToken = next[0]?.token ?? null
          setToken((previous) => previous !== null && nextToken !== null && sameToken(previous, nextToken) ? previous : nextToken)
          const keys = [...new Set(next.flatMap((preview) => preview.items.changes
            .filter((change) => change.author === 'external')
            .map((change) => change.key)))].sort()
          setExternalKeys((previous) => previous.join('\n') === keys.join('\n') ? previous : keys)
          setLoading(false)
        })
        .catch((error: unknown) => { if (current) { setSend((state) => nextSendState(state, { type: 'preview-failed', error })); setLoading(false) } })
    }, 120)
    return () => { current = false; window.clearTimeout(timer) }
  }, [onPreview, refresh, request])

  // Reads the committed `loading` rather than the value the click closed over, so a
  // click racing the settle is released on the very next commit instead of parking forever.
  useEffect(() => { if (!loading) setSend((state) => nextSendState(state, { type: 'preview-settled' })) }, [loading, send])

  useEffect(() => {
    if (send.phase !== 'sending' || !send.request || dispatched.current === send) return
    dispatched.current = send
    void onSend(send.request).catch((error: unknown) => {
      setSend((state) => nextSendState(state, { type: 'send-failed', error }))
      // A refused send — the document changed under the preview — re-previews at once.
      setRefresh((count) => count + 1)
    })
  }, [onSend, send])

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

  const changeChecked = (item: SendChangeItem) =>
    item.author === 'external' ? checkedExternal.has(item.key) : !uncheckedUser.has(item.key)
  const toggleChange = (item: SendChangeItem) => {
    if (item.author === 'external') setCheckedExternal((previous) => toggled(previous, item.key))
    else setUncheckedUser((previous) => toggled(previous, item.key))
  }

  const preview = previews[active]
  const dependentCount = preview?.dependentExternalHunks ?? 0
  const movePreviewFocus = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    const next = previewTabIndex(index, previews.length, event.key)
    if (next === null) return
    event.preventDefault()
    setActive(next)
    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus()
  }

  const changeRow = (item: SendChangeItem) => (
    <label className="send-item" key={item.key} data-author={item.author} data-checked={changeChecked(item)}>
      <input type="checkbox" checked={changeChecked(item)} onChange={() => toggleChange(item)} />
      <span className="send-item-body">
        {item.author === 'external' && <span className="send-item-meta"><strong>{item.name ?? 'Someone else'}</strong></span>}
        <span className="change-snippet">
          {snippetLines(item.removed, 'removed')}
          {snippetLines(item.added, 'added')}
        </span>
      </span>
    </label>
  )

  const eventRow = (item: SendEventItem) => (
    <label className="send-item send-item-event" key={item.seq} data-checked={!uncheckedEvents.has(item.seq)}>
      <input type="checkbox" checked={!uncheckedEvents.has(item.seq)} onChange={() => setUncheckedEvents((previous) => toggled(previous, item.seq))} />
      <span className="send-item-body">
        <span className="send-item-meta"><strong>{eventAuthor(item)}</strong><small>{eventKindLabel(item)}</small></span>
        {item.quote !== undefined && item.quote.length > 0 && <blockquote><InlineMarkdown text={item.quote} /></blockquote>}
        {item.kind !== 'verdict' && item.kind !== 'resolution' && <span className="send-item-text"><InlineMarkdown text={item.text} /></span>}
      </span>
    </label>
  )

  const itemsView = () => {
    if (preview === undefined) return <div className="send-empty">Select at least one recipient.</div>
    if (preview.resync === true) return <div className="send-empty">Gets the whole document to catch up.</div>
    const userChanges = preview.items.changes.filter((item) => item.author === 'user')
    const externalChanges = preview.items.changes.filter((item) => item.author === 'external')
    if (userChanges.length + externalChanges.length + preview.items.events.length === 0) {
      return <div className="send-empty">Nothing new for this agent.</div>
    }
    return (
      <div className="send-items">
        {userChanges.length > 0 && <>
          <h3 className="send-group-heading">Your changes · {userChanges.length}</h3>
          {userChanges.map(changeRow)}
        </>}
        {externalChanges.length > 0 && <>
          <h3 className="send-group-heading">Changes not made by me · {externalChanges.length}</h3>
          {dependentCount > 0 && <p className="send-group-note">{dependentCount} of your changes {dependentCount === 1 ? 'builds' : 'build'} on changes not made by you.</p>}
          {externalChanges.map(changeRow)}
        </>}
        {preview.items.events.length > 0 && <>
          <h3 className="send-group-heading">Comments · {preview.items.events.length}</h3>
          {preview.items.events.map(eventRow)}
        </>}
      </div>
    )
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
            return <label key={attachment.agent.id} data-selected={checked} style={{ borderColor: checked ? color : undefined, '--recipient-color': color } as CSSProperties}><input type="checkbox" checked={checked} onChange={() => setSelected((ids) => checked ? ids.filter((id) => id !== attachment.agent.id) : [...ids, attachment.agent.id])} /><i style={{ background: checked ? color : undefined }} />{attachment.agent.name}</label>
          })}</fieldset>
        ) : attachments[0] ? <div className="single-recipient">To <strong>{attachments[0].agent.name}</strong></div> : null}
        {previews.filter((item) => item.queuedAfter).map((item) => <div className="queued-notice" key={item.recipient.id}>{item.recipient.name} still has an earlier update waiting. This one arrives after it.</div>)}
        <div className="preview-heading" role="tablist" aria-label="What each agent receives">
          <strong aria-hidden="true">What each agent gets</strong>
          {previews.map((item, index) => <button type="button" role="tab" id={`${previewId}-tab-${index}`} aria-controls={`${previewId}-panel`} aria-selected={index === active} tabIndex={index === active ? 0 : -1} className={index === active ? 'active' : ''} key={item.recipient.id} onClick={() => setActive(index)} onKeyDown={(event) => movePreviewFocus(event, index)}>{item.recipient.name}</button>)}
          <button type="button" className="exact-toggle" aria-pressed={exact} onClick={() => setExact((value) => !value)}>Exact text</button>
        </div>
        <div className="send-tab-body" role="tabpanel" id={`${previewId}-panel`} aria-labelledby={preview ? `${previewId}-tab-${active}` : undefined}>
          {loading
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
