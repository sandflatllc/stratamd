import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import type { AnnotationKind, AnnotationView, AppView, AttachmentView, BufferOrigin, DocumentTabView, HunkView, PaneId, PanelSize, PaneZoom, PanelSizes, RedoResult, SendPreviewRequest, ThemePanelGeometry, UndoResult } from '../shared/contracts'
import type { RendererEditorFactory } from './editorAdapter'
import { Explorer } from './components/Explorer'
import { AmbientBackground, AmbientContext } from './components/AmbientDecor'
import { Boundary } from './components/Boundary'
import { ThemePanel } from './components/ThemePanel'
import { EditorPane, forgetClosedScroll } from './components/EditorPane'
import { forgetClosedEditors } from './components/EditorMount'
import { StrataIcon } from './components/Logo'
import { CloseTabDialog, ConflictDialog, DisconnectDialog, MixedRevertDialog, RecoveryDialog, RevertAllDialog } from './components/Overlays'
import { Resizer } from './components/Resizer'
import { RightRail } from './components/RightRail'
import { SendComposer } from './components/SendComposer'
import { Toast } from './components/Toast'
import { TopBar } from './components/TopBar'
import { AGENT_PROMPT, ambientStyles, clampPanelSize, clampThemePanel, cycleTab, EMPTY_VIEW, hasUnsavedCounted, isZoomed, nextReviewTarget, pendingCount, rendererThemeStyle, reviewTargets, stepZoom, type NumericPanelKey } from './model'
import { flushPendingBuffer, peekPendingBuffer, setPendingBuffer } from './pendingBuffer'
import { nextToast, type ToastState } from './toasts'
import { hasPrimaryModifier } from '../shared/primary-modifier'

interface AppProps { createEditor: RendererEditorFactory }

export function App({ createEditor }: AppProps) {
  const [view, setView] = useState<AppView>(EMPTY_VIEW)
  const [ready, setReady] = useState(false)
  const [toast, setToast] = useState<ToastState | null>(null)
  const [composer, setComposer] = useState(false)
  const [closingTab, setClosingTab] = useState<DocumentTabView | null>(null)
  const [mixedHunk, setMixedHunk] = useState<HunkView | null>(null)
  const [revertAll, setRevertAll] = useState<{ name: string; hunks: HunkView[] } | null>(null)
  const [disconnecting, setDisconnecting] = useState<AttachmentView | null>(null)
  const [selectedAnnotation, setSelectedAnnotation] = useState<AnnotationView | null>(null)
  const [jumpHunkId, setJumpHunkId] = useState<string | null>(null)
  const [jumpAnnotationId, setJumpAnnotationId] = useState<string | null>(null)
  const [scanning, setScanning] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [panelSizes, setPanelSizes] = useState<PanelSizes>(EMPTY_VIEW.settings.panelSizes)
  const [zoom, setZoom] = useState<PaneZoom>(EMPTY_VIEW.settings.zoom)
  const [themeOpen, setThemeOpen] = useState(false)
  const [themeHighlight, setThemeHighlight] = useState<string | null>(null)
  const zoomRef = useRef<PaneZoom>(EMPTY_VIEW.settings.zoom)
  const hoveredPane = useRef<PaneId | null>(null)
  const zoomPersist = useRef<number | null>(null)
  const mirrorTimer = useRef<number | null>(null)
  const typingTimer = useRef<number | null>(null)
  /** The last change stepped to with F7 / Shift+F7, so the next press continues from it. */
  const reviewCursor = useRef<string | null>(null)
  const document = view.activeDocument

  const report = useCallback((message: string) => setToast((current) => nextToast(current, { message, tone: 'info' })), [])
  const reportError = useCallback((message: string) => setToast((current) => nextToast(current, { message, tone: 'error' })), [])
  const dismissToast = useCallback(() => setToast(null), [])
  const perform = useCallback(async (job: () => Promise<unknown>, message?: string) => {
    try { await job(); if (message) report(message) }
    catch (error) { reportError(error instanceof Error ? error.message : 'The action failed') }
  }, [report, reportError])
  const openTheme = useCallback(() => { setThemeOpen(true); void perform(() => window.strata.openThemeSample()) }, [perform])

  useEffect(() => {
    let mounted = true
    let receivedPush = false
    void window.strata.getState().then((next) => {
      if (!mounted) return
      if (!receivedPush) {
        setView(next)
        setPanelSizes(next.settings.panelSizes)
        setZoom(next.settings.zoom); zoomRef.current = next.settings.zoom
      }
      setReady(true)
    }).catch((error: unknown) => { reportError(error instanceof Error ? error.message : 'Could not load StrataMD'); setReady(true) })
    const unsubscribe = window.strata.subscribe((next) => {
      if (!mounted) return
      receivedPush = true
      setView(next)
      setPanelSizes(next.settings.panelSizes)
      setZoom(next.settings.zoom); zoomRef.current = next.settings.zoom
    })
    return () => { mounted = false; unsubscribe() }
  }, [reportError])

  useEffect(() => () => {
    if (mirrorTimer.current !== null) window.clearTimeout(mirrorTimer.current)
    if (typingTimer.current !== null) window.clearTimeout(typingTimer.current)
  }, [])

  const applyZoom = useCallback((next: PaneZoom, immediate = false) => {
    zoomRef.current = next
    setZoom(next)
    if (zoomPersist.current !== null) window.clearTimeout(zoomPersist.current)
    const persist = () => { zoomPersist.current = null; void perform(() => window.strata.updateSettings({ zoom: next })) }
    if (immediate) persist()
    else zoomPersist.current = window.setTimeout(persist, 250)
  }, [perform])
  const zoomPane = useCallback((pane: PaneId, direction: 1 | -1) => {
    const current = zoomRef.current
    applyZoom({ ...current, [pane]: stepZoom(current[pane], direction) })
  }, [applyZoom])
  const resetZoom = useCallback(() => applyZoom({ explorer: 1, editor: 1, rightRail: 1, composer: 1 }, true), [applyZoom])

  useEffect(() => {
    const paneOf = (target: EventTarget | null): PaneId | null => {
      const pane = target instanceof Element ? target.closest<HTMLElement>('[data-pane]')?.dataset.pane : undefined
      return pane === 'explorer' || pane === 'editor' || pane === 'rightRail' || pane === 'composer' ? pane : null
    }
    const over = (event: PointerEvent) => { hoveredPane.current = paneOf(event.target) }
    // One zoom step per wheel notch (about 100 units at deltaMode 0). Trackpads deliver many small
    // deltas, so accumulate until a notch's worth arrives; a direction change resets the total.
    let wheelPane: PaneId | null = null
    let wheelTotal = 0
    const wheel = (event: WheelEvent) => {
      // ctrlKey on a wheel event is the zoom gesture on every platform:
      // Chromium synthesizes it for trackpad pinches, including on macOS.
      if (!event.ctrlKey) return
      event.preventDefault()
      const pane = paneOf(event.target)
      if (!pane || event.deltaY === 0) return
      const delta = event.deltaMode === WheelEvent.DOM_DELTA_PIXEL ? event.deltaY : event.deltaY * 100
      if (pane !== wheelPane || Math.sign(delta) !== Math.sign(wheelTotal)) wheelTotal = 0
      wheelPane = pane
      wheelTotal += delta
      if (Math.abs(wheelTotal) < 100) return
      zoomPane(pane, wheelTotal < 0 ? 1 : -1)
      wheelTotal = 0
    }
    const key = (event: KeyboardEvent) => {
      if (!hasPrimaryModifier(event) || event.altKey) return
      const direction = event.key === '=' || event.key === '+' ? 1 : event.key === '-' || event.key === '_' ? -1 : 0
      if (direction === 0) return
      event.preventDefault()
      zoomPane(hoveredPane.current ?? 'editor', direction)
    }
    window.addEventListener('pointerover', over)
    window.addEventListener('wheel', wheel, { passive: false })
    window.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('pointerover', over)
      window.removeEventListener('wheel', wheel)
      window.removeEventListener('keydown', key)
    }
  }, [zoomPane])

  const updateThemePanel = useCallback((geometry: ThemePanelGeometry, commit: boolean) => {
    setPanelSizes((sizes) => ({ ...sizes, themePanel: geometry }))
    if (commit) void perform(() => window.strata.updateSettings({ panelSizes: { ...panelSizes, themePanel: geometry } }))
  }, [panelSizes, perform])
  const themePanel = themeOpen && (
    <ThemePanel
      theme={view.settings.theme}
      geometry={clampThemePanel(panelSizes.themePanel, { width: window.innerWidth, height: window.innerHeight })}
      onGeometry={updateThemePanel}
      onClose={() => { setThemeOpen(false); setThemeHighlight(null) }}
      onHighlight={setThemeHighlight}
      onError={report}
    />
  )

  const updatePanel = useCallback((key: NumericPanelKey, value: number, commit: boolean) => {
    const clamped = clampPanelSize(key, value)
    setPanelSizes((sizes) => ({ ...sizes, [key]: clamped }))
    if (commit) void perform(() => window.strata.updateSettings({ panelSizes: { ...panelSizes, [key]: clamped } }))
  }, [panelSizes, perform])

  const updatePanelSize = useCallback((key: 'threadPanel' | 'annotationComposer' | 'sendComposer', value: PanelSize, commit: boolean) => {
    setPanelSizes((sizes) => ({ ...sizes, [key]: value }))
    if (commit) void perform(() => window.strata.updateSettings({ panelSizes: { ...panelSizes, [key]: value } }))
  }, [panelSizes, perform])

  const flushBuffer = useCallback(async () => {
    if (mirrorTimer.current !== null) window.clearTimeout(mirrorTimer.current)
    mirrorTimer.current = null
    await flushPendingBuffer()
  }, [])

  const bufferChanged = useCallback((content: string, origin: BufferOrigin) => {
    if (!document) return
    // A window that mixes history replay with a new edit is a new edit.
    const previous = peekPendingBuffer()
    const merged: BufferOrigin = previous?.path === document.path && previous.origin === 'edit' ? 'edit' : origin
    setPendingBuffer({ path: document.path, content, origin: merged })
    globalThis.document.documentElement.setAttribute('data-typing', 'true')
    if (typingTimer.current !== null) window.clearTimeout(typingTimer.current)
    typingTimer.current = window.setTimeout(() => globalThis.document.documentElement.removeAttribute('data-typing'), 700)
    if (mirrorTimer.current !== null) window.clearTimeout(mirrorTimer.current)
    mirrorTimer.current = window.setTimeout(() => { void perform(flushBuffer) }, 180)
  }, [document, flushBuffer, perform])

  useEffect(() => {
    const openPaths = new Set(view.tabs.map((tab) => tab.path))
    forgetClosedEditors(openPaths)
    forgetClosedScroll(openPaths)
  }, [view.tabs])

  const saveDocument = useCallback(async () => {
    if (!document) return
    await flushBuffer()
    await window.strata.save(document.path)
  }, [document, flushBuffer])

  const undoApplication = useCallback(async (): Promise<UndoResult> => {
    if (!document) return 'empty'
    try {
      await flushBuffer()
      return await window.strata.undo(document.path)
    } catch (error) {
      reportError(error instanceof Error ? error.message : 'Undo failed')
      return 'empty'
    }
  }, [document, flushBuffer, reportError])

  const redoApplication = useCallback(async (): Promise<RedoResult> => {
    if (!document) return 'empty'
    try {
      await flushBuffer()
      return await window.strata.redo(document.path)
    } catch (error) {
      reportError(error instanceof Error ? error.message : 'Redo failed')
      return 'empty'
    }
  }, [document, flushBuffer, reportError])

  const openComposer = useCallback(async () => {
    if (!document) return
    await flushBuffer()
    if (document.attachments.length === 0) {
      await window.strata.copyForAgent(document.path, '', false)
      report('Copied for your agent')
    } else if (document.canSend) setComposer(true)
    else report('Nothing to send. Make an edit or add an annotation first.')
  }, [document, flushBuffer, report])

  const dropFiles = useCallback((event: React.DragEvent) => {
    event.preventDefault()
    setDragging(false)
    const files = Array.from(event.dataTransfer.files).filter((file) => /\.(?:md|markdown)$/iu.test(file.name))
    if (files.length === 0) { report('Drop a .md or .markdown file.'); return }
    const openDroppedFiles = window.strata.openDroppedFiles
    if (!openDroppedFiles) { report('Drag and drop is unavailable in this window.'); return }
    void perform(() => openDroppedFiles(files))
  }, [perform, report])

  const closeTab = useCallback((tab: DocumentTabView) => {
    if (tab.dirty) setClosingTab(tab)
    else void perform(() => window.strata.closeDocument(tab.path))
  }, [perform])

  /** F7 / Shift+F7: the next pending change or open suggestion in document order (PRD §6.1). */
  const stepReview = useCallback((direction: 1 | -1) => {
    if (!document) return
    const target = nextReviewTarget(reviewTargets(document), reviewCursor.current, direction)
    if (!target) { report('No changes waiting for review.'); return }
    reviewCursor.current = target.id
    if (target.kind === 'hunk') { setJumpHunkId(null); window.requestAnimationFrame(() => setJumpHunkId(target.id)) }
    else { setJumpAnnotationId(null); window.requestAnimationFrame(() => setJumpAnnotationId(target.id)) }
  }, [document, report])

  useEffect(() => {
    const modalOpen = () => globalThis.document.querySelector('[aria-modal="true"]') !== null
    const key = (event: KeyboardEvent) => {
      if (!document) return
      const primary = hasPrimaryModifier(event)
      const lower = event.key.toLowerCase()
      if (event.key === 'Enter' && primary && !composer) {
        event.preventDefault()
        void perform(openComposer)
      } else if (lower === 's' && primary) {
        event.preventDefault()
        void perform(saveDocument, document.pendingHunks.length > 0 ? `Saved. ${document.pendingHunks.length} change${document.pendingHunks.length === 1 ? '' : 's'} still waiting for review.` : 'Saved.')
      } else if (event.key === '/' && primary) {
        event.preventDefault()
        if (document.sourceOnly) report('This document can only open in source view.')
        else void perform(() => window.strata.setSourceMode(document.path, !document.sourceMode))
      } else if (lower === 'w' && primary && !event.shiftKey && !event.altKey) {
        // Closes the active tab through the same confirmation a click gets (PRD §6.9).
        if (modalOpen()) return
        event.preventDefault()
        const active = view.tabs.find((tab) => tab.active)
        if (active) closeTab(active)
      } else if ((event.key === 'Tab' && event.ctrlKey && !event.altKey && !event.metaKey) || ((event.key === 'PageDown' || event.key === 'PageUp') && primary && !event.altKey)) {
        if (modalOpen()) return
        event.preventDefault()
        const backwards = event.key === 'PageUp' || (event.key === 'Tab' && event.shiftKey)
        const next = cycleTab(view.tabs, backwards ? -1 : 1)
        if (next) void perform(() => window.strata.openDocument(next.path))
      } else if (event.key === 'F7' && !primary && !event.altKey) {
        if (modalOpen()) return
        event.preventDefault()
        stepReview(event.shiftKey ? -1 : 1)
      }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [closeTab, composer, document, openComposer, perform, report, saveDocument, stepReview, view.tabs])

  if (!ready) return <div className="boot-screen"><StrataIcon /><span>Opening StrataMD…</span></div>
  if (!document) return (
    <AmbientContext.Provider value={ambientStyles(view.settings.theme)}><div className="app-shell empty-shell" style={rendererThemeStyle(view.settings.theme)} data-theme-highlight={themeHighlight ?? undefined} data-motion={view.settings.animatedBackground} data-ambient-background={ambientStyles(view.settings.theme).background} data-ambient-windows={ambientStyles(view.settings.theme).windows} data-dragging={dragging} onDragEnter={(event) => { event.preventDefault(); setDragging(true) }} onDragOver={(event) => event.preventDefault()} onDragLeave={(event) => { if (event.currentTarget === event.target) setDragging(false) }} onDrop={dropFiles}>
      <AmbientBackground /><TopBar tabs={view.tabs} canSend={false} hasAgents={false} pending={0} pendingUnsaved={false} onOpenTab={(path) => void perform(() => window.strata.openDocument(path))} onCloseTab={setClosingTab} onCopyPath={(path) => void perform(() => window.strata.copyText(path), 'Path copied.')} onSend={() => undefined} onCopy={() => undefined} zoomed={isZoomed(zoom)} onResetZoom={resetZoom} onOpenTheme={openTheme} />
      <div className="workspace">
        <div data-pane="explorer" style={{ width: panelSizes.explorerWidth, flex: 'none', '--zoom': zoom.explorer } as CSSProperties}><Boundary region="explorer"><Explorer folders={view.explorer} scanning={scanning} onOpen={(path) => void perform(() => window.strata.openDocument(path))} onScan={(path) => { setScanning(true); void perform(() => window.strata.scanFolder(path), 'Scan complete').finally(() => setScanning(false)) }} onRefresh={() => void perform(() => window.strata.refreshExplorer(), 'Explorer refreshed')} onAddFolder={() => void perform(() => window.strata.addFolder())} onForget={(path) => void perform(() => window.strata.forgetDocument(path), 'Document forgotten')} onCopyPath={(path) => void perform(() => window.strata.copyText(path), 'Path copied.')} onRemoveFolder={(path) => void perform(() => window.strata.removeFolder(path), 'Folder removed from the list. Its documents stay remembered.')} /></Boundary></div>
        <Resizer axis="vertical" label="Resize file explorer" value={panelSizes.explorerWidth} min={160} max={340} onChange={(value) => updatePanel('explorerWidth', value, false)} onCommit={(value) => updatePanel('explorerWidth', value, true)} />
        <main className="island editor-island empty-editor-island" data-pane="editor" style={{ '--zoom': zoom.editor } as CSSProperties}>
          <Boundary region="editor"><div className="empty-welcome"><StrataIcon /><h1>Open a markdown file</h1><p>Choose a folder, then open a document from the explorer.</p><button type="button" className="keep-button large" onClick={() => void perform(() => window.strata.addFolder())}>Add folder</button></div></Boundary>
        </main>
      </div>
      {dragging && <div className="drop-overlay">Drop markdown files to open</div>}
      {themePanel}
      <Toast toast={toast} onDone={dismissToast} />
    </div></AmbientContext.Provider>
  )

  const save = () => void perform(saveDocument, document.pendingHunks.length > 0 ? `Saved. ${document.pendingHunks.length} change${document.pendingHunks.length === 1 ? '' : 's'} still waiting for review.` : 'Saved.')
  const revert = (hunk: HunkView) => hunk.status === 'mixed' ? setMixedHunk(hunk) : void perform(() => window.strata.revertHunk(document.path, hunk.id), `Change by ${hunk.author?.name ?? 'someone else'} reverted. Agents see the revert as your change.`)
  const preview = async (request: SendPreviewRequest) => { await flushBuffer(); return window.strata.previewSend(document.path, request) }
  const disconnect = (attachment: AttachmentView) => void perform(
    () => window.strata.disconnectAgent(document.path, attachment.agent.id),
    `${attachment.agent.name} disconnected.`,
  ).then(() => setDisconnecting(null))

  return (
    <AmbientContext.Provider value={ambientStyles(view.settings.theme)}><div className="app-shell" style={rendererThemeStyle(view.settings.theme)} data-theme-highlight={themeHighlight ?? undefined} data-motion={view.settings.animatedBackground} data-ambient-background={ambientStyles(view.settings.theme).background} data-ambient-windows={ambientStyles(view.settings.theme).windows} data-dragging={dragging} onDragEnter={(event) => { event.preventDefault(); setDragging(true) }} onDragOver={(event) => event.preventDefault()} onDragLeave={(event) => { if (event.currentTarget === event.target) setDragging(false) }} onDrop={dropFiles}>
      <AmbientBackground />
      <TopBar tabs={view.tabs} canSend={document.canSend} hasAgents={document.attachments.length > 0} pending={pendingCount(document)} pendingUnsaved={hasUnsavedCounted(document)} onOpenTab={(path) => void perform(() => window.strata.openDocument(path))} onCloseTab={closeTab} onCopyPath={(path) => void perform(() => window.strata.copyText(path), 'Path copied.')} onSend={() => void perform(openComposer)} onCopy={() => void perform(openComposer)} zoomed={isZoomed(zoom)} onResetZoom={resetZoom} onOpenTheme={openTheme} />
      <div className="workspace">
        <div data-pane="explorer" style={{ width: panelSizes.explorerWidth, flex: 'none', '--zoom': zoom.explorer } as CSSProperties}><Boundary region="explorer"><Explorer folders={view.explorer} activePath={document.path} scanning={scanning} onOpen={(path) => void perform(() => window.strata.openDocument(path))} onScan={(path) => { setScanning(true); void perform(() => window.strata.scanFolder(path), 'Scan complete').finally(() => setScanning(false)) }} onRefresh={() => void perform(() => window.strata.refreshExplorer(), 'Explorer refreshed')} onAddFolder={() => void perform(() => window.strata.addFolder())} onForget={(path) => void perform(() => window.strata.forgetDocument(path), 'Document forgotten')} onCopyPath={(path) => void perform(() => window.strata.copyText(path), 'Path copied.')} onRemoveFolder={(path) => void perform(() => window.strata.removeFolder(path), 'Folder removed from the list. Its documents stay remembered.')} /></Boundary></div>
        <Resizer axis="vertical" label="Resize file explorer" value={panelSizes.explorerWidth} min={160} max={340} onChange={(value) => updatePanel('explorerWidth', value, false)} onCommit={(value) => updatePanel('explorerWidth', value, true)} />
        <Boundary region="editor"><EditorPane document={document} documentMeasure={panelSizes.documentMeasure} zoom={zoom.editor} threadPanelSize={panelSizes.threadPanel} composerSize={panelSizes.annotationComposer} createEditor={createEditor} onDocumentMeasure={(value, commit) => updatePanel('documentMeasure', value, commit)} onThreadPanelSize={(size, commit) => updatePanelSize('threadPanel', size, commit)} onComposerSize={(size, commit) => updatePanelSize('annotationComposer', size, commit)} onBufferChange={bufferChanged} onToggleSource={(source) => void perform(() => window.strata.setSourceMode(document.path, source))} onSave={save} onUndo={undoApplication} onRedo={redoApplication} onKeepHunk={(id) => void perform(() => window.strata.keepHunk(document.path, id), 'Kept.')} onRevertHunk={revert} onAddAnnotation={(kind: AnnotationKind, quote, text, from, to) => void perform(() => window.strata.addAnnotation(document.path, { kind, quote, text, from, to }), kind === 'suggestion' ? 'Suggestion added for the next Send.' : 'Annotation added on the exact quote.')} onAdjustAnnotation={(id, quote, from, to) => void perform(() => window.strata.requoteAnnotation(document.path, id, { quote, from, to }), 'Annotation moved to the new quote. Agents receive it on the next Send.')} onReply={(id, text) => void perform(() => window.strata.reply(document.path, id, text))} onResolve={(id) => void perform(async () => { await window.strata.resolveAnnotation(document.path, id); setSelectedAnnotation(null) }, 'Thread resolved. It stays until cleared.')} onAccept={(id) => void perform(() => window.strata.acceptSuggestion(document.path, id), 'Suggestion accepted as your change.')} onReject={(id) => void perform(() => window.strata.rejectSuggestion(document.path, id), 'Suggestion rejected.')} selectedAnnotation={selectedAnnotation} onSelectAnnotation={setSelectedAnnotation} jumpHunkId={jumpHunkId} jumpAnnotationId={jumpAnnotationId} /></Boundary>
        <Resizer axis="vertical" label="Resize right rail" value={panelSizes.rightRailWidth} min={240} max={440} invert onChange={(value) => updatePanel('rightRailWidth', value, false)} onCommit={(value) => updatePanel('rightRailWidth', value, true)} />
        <div data-pane="rightRail" style={{ width: panelSizes.rightRailWidth, flex: 'none', minWidth: 0, '--zoom': zoom.rightRail } as CSSProperties}><Boundary region="rightRail"><RightRail document={document} changesHeight={panelSizes.changesHeight} annotationsHeight={panelSizes.annotationsHeight} onHeight={updatePanel} onMarkReviewed={() => void perform(() => window.strata.markReviewed(document.path), 'All changes marked reviewed. Suggestions still need Accept or Reject.')} onJumpHunk={(hunk) => { setJumpHunkId(null); window.requestAnimationFrame(() => setJumpHunkId(hunk.id)) }} onKeepHunk={(id) => void perform(() => window.strata.keepHunk(document.path, id), 'Kept.')} onRevertHunk={revert} onAcceptAllSuggestions={(agentId) => void perform(async () => { const result = await window.strata.acceptAllSuggestions(document.path, agentId); report(`${result.accepted.length} suggestion${result.accepted.length === 1 ? '' : 's'} accepted${result.skipped.length > 0 ? `; ${result.skipped.length} overlapping skipped` : ''}.`) })} onRejectAllSuggestions={(agentId) => void perform(async () => { const rejected = await window.strata.rejectAllSuggestions(document.path, agentId); report(`${rejected.length} suggestion${rejected.length === 1 ? '' : 's'} rejected.`) })} onAcceptSuggestion={(id) => void perform(() => window.strata.acceptSuggestion(document.path, id), 'Suggestion accepted as your change.')} onRejectSuggestion={(id) => void perform(() => window.strata.rejectSuggestion(document.path, id), 'Suggestion rejected.')} onRevertAll={setRevertAll} onCopyAgentPrompt={() => void perform(() => window.strata.copyText(AGENT_PROMPT), 'Prompt copied. Paste it to your agent.')} onJumpAnnotation={(annotation) => { if (annotation.status === 'orphaned') { setJumpAnnotationId(null); setSelectedAnnotation(annotation); return } setJumpAnnotationId(null); window.requestAnimationFrame(() => { setJumpAnnotationId(annotation.id); setSelectedAnnotation(annotation) }) }} onClearResolved={() => void perform(() => window.strata.clearResolvedAnnotations(document.path), 'Resolved annotations cleared.')} onNudge={(id) => void perform(() => window.strata.nudge(document.path, id), 'Reattach prompt copied.')} onSetLead={(agentId) => void perform(() => window.strata.setLead(document.path, agentId))} onDisconnect={(attachment) => { if (attachment.queuedSendCount > 0) setDisconnecting(attachment); else disconnect(attachment) }} onSaveRound={(index) => window.strata.saveRound(document.path, index)} /></Boundary></div>
      </div>
      {composer && <SendComposer attachments={document.attachments} documentPath={document.path} size={panelSizes.sendComposer} zoom={zoom.composer} onSize={(value, commit) => updatePanelSize('sendComposer', value, commit)} onCancel={() => setComposer(false)} onPreview={preview} onSend={async (request) => { await flushBuffer(); const ids = await window.strata.send(document.path, request); setComposer(false); report(`Sent to ${ids.length} agent${ids.length === 1 ? '' : 's'}.`) }} />}
      {revertAll && <RevertAllDialog name={revertAll.name} hunks={revertAll.hunks} onCancel={() => setRevertAll(null)} onConfirm={() => {
        // Bottom-up, one revert per hunk: each is its own application step, so each is its own undo.
        const hunks = [...revertAll.hunks].sort((left, right) => right.newStart - left.newStart)
        setRevertAll(null)
        void perform(async () => { for (const hunk of hunks) await window.strata.revertHunk(document.path, hunk.id, true) }, `${hunks.length} changes by ${revertAll.name} reverted. Agents see the reverts as your changes.`)
      }} />}
      {mixedHunk && <MixedRevertDialog hunk={mixedHunk} onCancel={() => setMixedHunk(null)} onConfirm={() => void perform(() => window.strata.revertHunk(document.path, mixedHunk.id, true), 'Reverted. Your edits inside it were discarded.').then(() => setMixedHunk(null))} />}
      {disconnecting && <DisconnectDialog attachment={disconnecting} onCancel={() => setDisconnecting(null)} onConfirm={() => disconnect(disconnecting)} />}
      {document.recovery && <RecoveryDialog fileName={document.path.split('/').pop() ?? document.path} onChoose={(choice) => void perform(() => window.strata.resolveRecovery(document.path, choice), choice === 'recover' ? 'Recovered the buffer.' : 'Discarded the buffer and restored the disk copy.')} />}
      {document.conflicts[0] && <ConflictDialog conflict={document.conflicts[0]} fileName={document.path.split('/').pop() ?? document.path} onChoose={(choice) => void perform(() => window.strata.resolveConflict(document.path, document.conflicts[0]!.id, choice), choice === 'mine' ? 'Kept your block.' : 'Incoming block applied for review.')} />}
      {closingTab && <CloseTabDialog tab={closingTab} onChoose={(choice) => { if (choice === 'cancel') { setClosingTab(null); return } void perform(() => window.strata.closeDocument(closingTab.path, choice)).then(() => setClosingTab(null)) }} />}
      {themePanel}
      <Toast toast={toast} onDone={dismissToast} />
      {dragging && <div className="drop-overlay">Drop markdown files to open</div>}
    </div></AmbientContext.Provider>
  )
}
