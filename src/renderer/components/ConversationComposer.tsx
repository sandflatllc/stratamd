import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { ConversationInput, EngineView } from '../../shared/contracts'
import { availableModels, clearDraft, readDraft, rememberSelection, selectionForModel, writeDraft, type ComposerSelection } from '../conversationDrafts'

const accessModes = [
  ['approval-required', 'Supervised', 'Ask before commands and file changes.'],
  ['auto-accept-edits', 'Auto-accept edits', 'Approve edits, ask before other actions.'],
  ['auto', 'Auto', 'Supported providers approve routine actions; others still ask.'],
  ['full-access', 'Full access', 'Allow commands and edits without prompts.'],
] as const
function readFavorites(): string[] {
  try { const value: unknown = JSON.parse(localStorage.getItem('stratamd.model-favorites.v1') ?? '[]'); return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [] } catch { return [] }
}

export interface ConversationComposerProps {
  engine: EngineView
  projectId: string
  draftKey: string
  initial: ComposerSelection
  centered?: boolean
  queuedCount?: number
  context?: ReactNode
  canSendContext?: boolean
  workspace?: string
  branch?: string | null
  onSend(input: ConversationInput): Promise<void>
}

export function ConversationComposer({ engine, projectId, draftKey, initial, centered = false, queuedCount = 0, context, canSendContext = false, workspace, branch, onSend }: ConversationComposerProps) {
  const [draft] = useState(() => readDraft(draftKey))
  const [text, setText] = useState(draft.text)
  const [attachment, setAttachment] = useState(draft.attachment)
  const [selection, setSelection] = useState(draft.selection ?? initial)
  const [menu, setMenu] = useState<'models' | 'options' | 'access' | null>(null)
  const [search, setSearch] = useState('')
  const [favorites, setFavorites] = useState(readFavorites)
  const [onlyFavorites, setOnlyFavorites] = useState(false)
  const [busy, setBusy] = useState(false)
  const sending = useRef(false)
  const [error, setError] = useState('')
  const root = useRef<HTMLFormElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const popup = useRef<HTMLDivElement>(null)
  const models = availableModels(engine)
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
  const persist = (nextText: string, nextSelection: ComposerSelection, nextAttachment: typeof attachment) => writeDraft(draftKey, { ...readDraft(draftKey), text: nextText, selection: nextSelection, ...(nextAttachment ? { attachment: nextAttachment } : { attachment: undefined }) })
  const choose = (next: ComposerSelection) => { setSelection(next); rememberSelection(projectId, next); persist(text, next, attachment) }
  useEffect(() => { if (centered) input.current?.focus() }, [])
  useEffect(() => {
    if (!selection.model && initial.model) setSelection(initial)
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
      const width = Math.min(menu === 'options' ? 320 : 420, box.width, window.innerWidth - 24)
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
    if (menu === 'models') element.querySelector('input')?.focus({ preventScroll: true })
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); if (element.matches(':popover-open')) element.hidePopover() }
  }, [menu, search, onlyFavorites])
  const send = async () => {
    if (sending.current || !valid || (!text.trim() && !attachment && !queuedCount && !canSendContext)) return
    sending.current = true; setBusy(true); setError(''); setMenu(null)
    try {
      const messageId = readDraft(draftKey).messageId ?? crypto.randomUUID()
      writeDraft(draftKey, { ...readDraft(draftKey), messageId })
      await onSend({ ...selection, messageId, commandId: `strata-${messageId}`, text: text.trim(), ...(attachment ? { attachment } : {}) })
      clearDraft(draftKey); setText(''); setAttachment(undefined)
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'The message could not be sent. Try again.') }
    finally { sending.current = false; setBusy(false) }
  }
  const favoriteKey = (instanceId: string, slug: string) => `${instanceId}:${slug}`
  const visibleModels = models.filter((model) => (!onlyFavorites || favorites.includes(favoriteKey(model.instanceId, model.slug))) && `${model.name} ${model.slug} ${model.accountName}`.toLowerCase().includes(search.toLowerCase())).toSorted((a, b) => Number(favorites.includes(favoriteKey(b.instanceId, b.slug))) - Number(favorites.includes(favoriteKey(a.instanceId, a.slug))))
  return <form ref={root} className="chat-composer" data-centered={centered} aria-label="Conversation composer" onSubmit={(event) => { event.preventDefault(); void send() }} onKeyDown={(event) => {
    if (event.key === 'Escape' && menu) { event.preventDefault(); event.stopPropagation(); setMenu(null); input.current?.focus() }
    if ((event.ctrlKey || event.metaKey) && /^[1-9]$/.test(event.key)) {
      const target = favorites[Number(event.key) - 1]; const next = models.find((model) => favoriteKey(model.instanceId, model.slug) === target)
      if (next && !engine.accounts.some((account) => account.instanceId === next.instanceId && !account.usable)) { event.preventDefault(); event.stopPropagation(); choose(selectionForModel(next, selection.access)) }
    }
  }}>
    <div className="chat-composer-box">
      {context && <div className="chat-context">{context}</div>}
      {attachment && <div className="conversation-attachment-preview"><strong>{attachment.name}</strong><button type="button" aria-label={`Remove ${attachment.name}`} disabled={busy} onClick={() => { setAttachment(undefined); persist(text, selection, undefined) }}>×</button></div>}
      <textarea ref={input} aria-label="Message conversation" placeholder="Ask for changes, send follow-ups, or attach a file" value={text} disabled={busy} onChange={(event) => { setText(event.target.value); persist(event.target.value, selection, attachment) }} onKeyDown={(event) => {
        if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); void send() }
      }} />
      <div className="chat-controls">
        <div className="chat-control"><button type="button" className="chat-pill" aria-label="Choose model and account" aria-expanded={menu === 'models'} disabled={busy} onClick={() => setMenu(menu === 'models' ? null : 'models')} title={model?.accountName}>{model?.name ?? (selection.model || 'Choose model')}<small>{model?.accountName}</small><span aria-hidden="true">⌄</span></button>
          {menu === 'models' && <div ref={popup} popover="manual" className="chat-menu chat-model-menu" aria-label="Models and accounts" role="region">
            <div className="chat-model-search"><button type="button" aria-label="Show favorite models" aria-pressed={onlyFavorites} onClick={() => setOnlyFavorites(!onlyFavorites)}>★</button><input aria-label="Search models" placeholder="Search models or accounts…" value={search} onChange={(event) => setSearch(event.target.value)} /></div>
            <div className="chat-model-list">{visibleModels.map((candidate) => {
              const key = favoriteKey(candidate.instanceId, candidate.slug); const favorite = favorites.includes(key)
              const unavailable = engine.accounts.find((account) => account.instanceId === candidate.instanceId)
              return <div className="chat-model-row" key={key} data-selected={model === candidate}>
                <button type="button" disabled={unavailable?.usable === false} onClick={() => { choose(selectionForModel(candidate, selection.access)); setMenu(null); input.current?.focus() }}><span>{candidate.name}</span><small>{candidate.accountName}{unavailable?.usable === false ? ` · ${unavailable.reason ?? unavailable.state}` : ''}</small></button>
                {favorite && favorites.indexOf(key) < 9 && <kbd>Ctrl+{favorites.indexOf(key) + 1}</kbd>}
                <button type="button" className="chat-favorite" aria-label={`${favorite ? 'Unfavorite' : 'Favorite'} ${candidate.name} ${candidate.accountName}`} aria-pressed={favorite} onClick={() => { const next = favorite ? favorites.filter((value) => value !== key) : [...favorites, key]; setFavorites(next); try { localStorage.setItem('stratamd.model-favorites.v1', JSON.stringify(next)) } catch { /* In-memory favorites still work. */ } }}>{favorite ? '★' : '☆'}</button>
              </div>
            })}{visibleModels.length === 0 && <p>No matching models.</p>}</div>
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
        <div className="chat-send-actions"><input ref={fileInput} className="conversation-attachment-input" type="file" accept="text/*,.md,.markdown,.json,.csv,.ts,.tsx,.js,.py" hidden onChange={async (event) => {
          const file = event.target.files?.[0]; event.target.value = ''; if (!file) return
          if (file.size > 2 * 1024 * 1024) { setError(`File ${file.name} exceeds the 2 MB attachment limit.`); return }
          try { const next = { name: file.name, text: await file.text() }; setAttachment(next); persist(text, selection, next) } catch { setError(`Could not read ${file.name}.`) }
        }} /><button type="button" aria-label="Attach file" disabled={busy || canSendContext} onClick={() => fileInput.current?.click()}>＋</button><button className="chat-send" type="submit" aria-label="Send" disabled={busy || !valid || (!text.trim() && !attachment && !queuedCount && !canSendContext)}>{busy ? '…' : '↑'}</button></div>
      </div>
    </div>
    {(workspace || branch) && <div className="chat-workspace"><span title={workspace}>▱ Current checkout{workspace && <small>{workspace}</small>}</span>{branch && <span>{branch}</span>}</div>}
    {queuedCount > 0 && <small>{queuedCount} answers queued</small>}
    {account?.usable === false && <p role="alert">{account.name} cannot take a turn: {account.reason ?? account.state}. Choose another account.</p>}
    {error && <p className="send-error" role="alert">{error}</p>}
  </form>
}
