import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import type { EngineView, PreviewNavigation, PreviewTabView, PreviewViewportRequest } from '../../shared/contracts'
import { pageName, PREVIEW_PRESETS, viewportCaption, viewportLabel } from '../../shared/preview'
import { threadAgentName } from '../model'
import { claimEscape } from '../escape'

/**
 * The preview window (docs/plans/open/visual-review, phase 2): a tab strip
 * with the owner's tabs and any agent tabs, then back, forward, reload, the
 * address, a status pill while an agent drives a tab, a size pill, and the
 * Annotate toggle. The page itself is a main-process view; this component
 * leaves a hole for it and reports where the hole is whenever layout changes.
 */
export interface SavedPreviewMedia {
  document?: ReactNode
  id: string
  name: string
  url: string
  mimeType: string
  active: boolean
  onSelect(): void
  onClose(): void
  onAnnotate(): void
}

export interface PreviewWindowProps {
  documentMedia?: SavedPreviewMedia | undefined
  savedMedia?: SavedPreviewMedia | undefined
  projectId: string
  projectTitle: string
  tabs: PreviewTabView[]
  activeTabId: string | null
  engine: EngineView
  onSelectTab(id: string): void
  onNewTab(): void
  onCloseTab(id: string): void
  onNavigate(id: string, navigation: PreviewNavigation): void
  onResize(id: string, viewport: PreviewViewportRequest): void
  onResume(id: string): void
  /** Annotate on a page (phase 3): the toggle and the session drawn over the stage. */
  annotate?: { active: boolean; disabled?: boolean; onToggle(): void; overlay?: ReactNode }
}

function RobotGlyph() {
  return <svg className="preview-robot" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8V4H8" /><rect width="16" height="12" x="4" y="8" rx="2" /><path d="M2 14h2M20 14h2M15 13v2M9 13v2" /></svg>
}

export function tabLabel(tab: PreviewTabView, engine: EngineView): string {
  const page = tab.url ? pageName(tab.url, tab.title) : 'New tab'
  if (tab.kind !== 'agent' || !tab.threadId) return page
  return `${threadAgentName(engine, tab.threadId)} · ${page}`
}

export function PreviewWindow({ savedMedia: evidenceMedia, documentMedia, projectId, projectTitle, tabs, activeTabId, engine, onSelectTab, onNewTab, onCloseTab, onNavigate, onResize, onResume, annotate }: PreviewWindowProps) {
  const savedMedia = documentMedia?.active ? documentMedia : evidenceMedia
  const active = tabs.find((tab) => tab.id === activeTabId) ?? null
  const hole = useRef<HTMLDivElement>(null)
  const stage = useRef<HTMLDivElement>(null)
  const address = useRef<HTMLInputElement>(null)
  const [room, setRoom] = useState<{ width: number; height: number } | null>(null)
  const [draft, setDraft] = useState(active?.url ?? '')
  const [editing, setEditing] = useState(false)
  const [sizeMenu, setSizeMenu] = useState(false)
  const reported = useRef<string>('')

  // The address follows the page unless the owner is typing.
  useEffect(() => { if (!editing) setDraft(active?.url ?? '') }, [active?.id, active?.url, editing])
  useEffect(() => { if (active && !active.url) address.current?.focus() }, [active?.id])

  // Where the page sits: measured after every layout change and sent to the main process, which draws the view there.
  useLayoutEffect(() => {
    const element = hole.current
    const tabId = active && !annotate?.active && !savedMedia?.active ? active.id : null
    let frame = 0
    const report = () => {
      frame = 0
      const rect = element && tabId ? element.getBoundingClientRect() : null
      const payload = { tabId, bounds: rect ? { x: rect.left, y: rect.top, width: rect.width, height: rect.height } : null }
      const key = JSON.stringify(payload)
      if (key === reported.current) return
      reported.current = key
      void window.strata.reportPreviewBounds(payload).catch(() => undefined)
    }
    const schedule = () => { if (frame === 0) frame = window.requestAnimationFrame(report) }
    report()
    const observer = new ResizeObserver(schedule)
    if (element) observer.observe(element)
    observer.observe(document.body)
    window.addEventListener('resize', schedule)
    window.addEventListener('scroll', schedule, true)
    return () => {
      if (frame) window.cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener('resize', schedule)
      window.removeEventListener('scroll', schedule, true)
    }
  }, [active?.id, active?.viewport, annotate?.active, savedMedia?.active])
  // Leaving the preview hides the page; the page itself stays alive for the next visit.
  useEffect(() => () => { reported.current = ''; void window.strata.reportPreviewBounds({ tabId: null, bounds: null }).catch(() => undefined) }, [])

  // A narrowed viewport larger than the stage shrinks to fit; the page still sees its full size.
  useLayoutEffect(() => {
    const element = stage.current
    if (!element) return
    const measure = () => setRoom({ width: element.clientWidth, height: element.clientHeight })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [active?.id])

  useEffect(() => {
    if (!sizeMenu) return
    const away = (event: PointerEvent) => { if (!(event.target instanceof Element && event.target.closest('.preview-size'))) setSizeMenu(false) }
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { claimEscape(event); setSizeMenu(false) } }
    window.addEventListener('pointerdown', away, true)
    window.addEventListener('keydown', key, true)
    return () => { window.removeEventListener('pointerdown', away, true); window.removeEventListener('keydown', key, true) }
  }, [sizeMenu])

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!active) return
    setEditing(false)
    if (draft.trim()) onNavigate(active.id, { url: draft.trim() })
  }
  const agentTabs = tabs.filter((tab) => tab.kind === 'agent')
  const driven = agentTabs.find((tab) => tab.id !== active?.id && (tab.working || tab.paused)) ?? agentTabs.find((tab) => tab.id !== active?.id)
  const caption = active ? viewportCaption(active.viewport) : null
  const fit = active && active.viewport.mode !== 'fill' && room ? Math.min(1, (room.width - 48) / active.viewport.width, (room.height - 80) / active.viewport.height) : 1
  const holeStyle = active && active.viewport.mode !== 'fill' ? { width: Math.round(active.viewport.width * Math.max(fit, 0.1)), height: Math.round(active.viewport.height * Math.max(fit, 0.1)) } : undefined

  return (
    <section className="preview-window" aria-label={`${projectTitle} preview`} data-project={projectId}>
      <div className="preview-tabstrip" role="tablist" aria-label="Preview tabs">
        {tabs.map((tab) => (
          <div key={tab.id} role="tab" tabIndex={0} aria-selected={!savedMedia?.active && tab.id === active?.id} className="preview-tab" data-kind={tab.kind} data-paused={tab.paused || undefined} data-working={tab.working || undefined} title={tab.url || undefined} onClick={() => onSelectTab(tab.id)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelectTab(tab.id) } }}>
            {tab.kind === 'agent' ? <RobotGlyph /> : <span className="preview-tab-fav" aria-hidden="true" />}
            <span className="preview-tab-name">{tabLabel(tab, engine)}</span>
            {tab.recording && <small role="status">{tab.recording === 'paused' ? 'Recording paused' : 'Recording'}</small>}
            {tab.kind === 'agent' && tab.working && <i className="preview-live" aria-label="working" />}
            <span role="button" tabIndex={0} className="preview-tab-close" aria-label={`Close tab ${tabLabel(tab, engine)}`} onClick={(event) => { event.stopPropagation(); onCloseTab(tab.id) }} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); onCloseTab(tab.id) } }}>×</span>
          </div>
        ))}
        {[evidenceMedia, documentMedia].filter((item): item is SavedPreviewMedia => Boolean(item)).map(savedMedia => <div key={savedMedia.id} role="tab" tabIndex={0} aria-selected={savedMedia.active} className="preview-tab" onClick={savedMedia.onSelect} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); savedMedia.onSelect() } }}>
          <span className="preview-tab-fav" aria-hidden="true" /><span className="preview-tab-name">{savedMedia.name}</span><button type="button" className="preview-tab-close" aria-label={`Close saved ${savedMedia.name}`} onClick={event => { event.stopPropagation(); savedMedia.onClose() }}>×</button>
        </div>)}
        <button type="button" className="preview-tab-add" aria-label="New tab" onClick={onNewTab}>+</button>
      </div>
      {savedMedia?.active && savedMedia.document ? savedMedia.document : <>
      {savedMedia?.active ? <div className="preview-chrome preview-saved-chrome"><strong>{savedMedia.name}</strong><span>{savedMedia.mimeType === 'image/png' ? 'Saved screenshot' : 'Saved recording'}</span>{savedMedia.mimeType === 'image/png' && <button type="button" className="preview-annotate" onClick={savedMedia.onAnnotate}>Annotate</button>}</div> : <div className="preview-chrome">
        <div className="preview-nav">
          <button type="button" aria-label="Back" disabled={!active?.canGoBack} onClick={() => active && onNavigate(active.id, { action: 'back' })}>‹</button>
          <button type="button" aria-label="Forward" disabled={!active?.canGoForward} onClick={() => active && onNavigate(active.id, { action: 'forward' })}>›</button>
          <button type="button" aria-label={active?.loading ? 'Stop' : 'Reload'} disabled={!active?.url} onClick={() => active && onNavigate(active.id, { action: active.loading ? 'stop' : 'reload' })}>{active?.loading ? '×' : '↻'}</button>
        </div>
        <form className="preview-address" onSubmit={submit}>
          <input ref={address} type="text" aria-label="Address" placeholder="Type an address, such as localhost:5173" value={draft} disabled={!active} onFocus={() => setEditing(true)} onBlur={() => setEditing(false)} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') { claimEscape(event.nativeEvent); setDraft(active?.url ?? ''); address.current?.blur() } }} spellCheck={false} />
        </form>
        {active?.kind === 'agent' && active.paused && <span className="preview-agent-pill" data-paused>Paused: you took control<button type="button" onClick={() => onResume(active.id)}>Resume</button></span>}
        {driven && driven.threadId && <button type="button" className="preview-agent-pill" data-working={driven.working || undefined} onClick={() => onSelectTab(driven.id)} title="Watch this tab without pausing it"><i className="preview-live" aria-hidden="true" /><b>{threadAgentName(engine, driven.threadId)}</b>{driven.paused ? ' is paused' : driven.activity ? ` is ${driven.activity}` : ` is in ${pageName(driven.url, driven.title)}`} · Watch</button>}
        <div className="preview-size">
          <button type="button" aria-haspopup="menu" aria-expanded={sizeMenu} aria-label="Page size" disabled={!active} onClick={() => setSizeMenu((open) => !open)}>{active ? viewportLabel(active.viewport) : 'Fit window'} ▾</button>
          {sizeMenu && active && <div className="preview-size-menu" role="menu" aria-label="Page sizes">
            <button type="button" role="menuitemradio" aria-checked={active.viewport.mode === 'fill'} onClick={() => { onResize(active.id, { mode: 'fill' }); setSizeMenu(false) }}>Fit window</button>
            {PREVIEW_PRESETS.map((preset) => <button type="button" role="menuitemradio" key={preset.id} aria-checked={active.viewport.mode === 'preset' && active.viewport.preset === preset.id} onClick={() => { onResize(active.id, { mode: 'preset', preset: preset.id }); setSizeMenu(false) }}>{preset.label}<small>{preset.width} × {preset.height}</small></button>)}
          </div>}
        </div>
        {annotate && <button type="button" className="preview-annotate" aria-pressed={annotate.active} disabled={annotate.disabled || !active?.url} onClick={annotate.onToggle} title={annotate.active ? 'Stop annotating (Esc)' : 'Mark up this page'}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>{annotate.active ? 'Annotating' : 'Annotate'}{annotate.active && <kbd>Esc</kbd>}</button>}
      </div>
      }
      {!savedMedia?.active && active?.error && <p className="preview-notice" role="alert">{active.error}</p>}
      <div className="preview-stage" ref={stage} data-mode={active?.viewport.mode ?? 'fill'}>
        {savedMedia?.active ? <div className="preview-saved-media">{savedMedia.mimeType === 'image/png' ? <img src={savedMedia.url} alt={savedMedia.name} /> : <video src={savedMedia.url} controls autoPlay />}</div> : active
          ? <figure className="preview-frame">
              <div className="preview-hole" ref={hole} data-tab={active.id} style={holeStyle} />
              {caption && <figcaption>{caption}</figcaption>}
            </figure>
          : <div className="empty-subtle preview-empty">No page open.<small>Open a tab and type an address.</small></div>}
        {annotate?.overlay}
      </div>
      </>}
    </section>
  )
}
