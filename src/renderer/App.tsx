import { SettingsDialog } from './components/SettingsDialog'
import { UsageDialog } from './components/UsageDialog'
import { TerminalDrawer } from './components/TerminalDrawer'
import { useWindowState } from './useWindowState'
import { useWebLinkPicker } from './useWebLinkPicker'
import { useLinkContextMenu } from './useLinkContextMenu'
import type { WindowAction } from '../shared/contracts'
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import type { ItemView, AnnotationContext, AnnotationKind, AnnotationView, AppView, AttachmentView, BufferOrigin, CreateDraftRequest, DocumentTabView, DocumentView, HoldVisualCommentInput, VisualAdjustmentView, VisualCaptureView, VisualMarkView, VisualPageCapture, VisualPointView, VisualRectView, HunkView, NavigationTab, PaneId, PanelSize, PaneZoom, PanelSizes, PreviewNavigation, PreviewViewportRequest, QuickSendRequest, RedoResult, ReviewTab, SendPreviewRequest, TableViewState, ThemePanelGeometry, UndoResult, VisualDestinationView, WalkthroughAction } from '../shared/contracts'
import { VisualSession, newVisualSession, type VisualSessionData, type VisualProposal } from './components/VisualSession'
import { toCaptureRect, toPagePoint, toPageRect } from '../core/visual-comments'
import { PreviewWindow } from './components/PreviewWindow'
import { PreviewRail } from './components/PreviewRail'
import { previewPillName } from '../shared/preview'
import { VisualCommentPanel, type VisualCardActions } from './components/VisualCommentCard'
import { visualImageUrl } from '../shared/visual-urls'
import { loadImage } from './visualImage'
import type { DraftAttachment } from './conversationDrafts'
import type { EditorHeading } from '../editor/headings'
import type { RendererEditorFactory, RendererEditorHandle } from './editorAdapter'
import { AmbientBackground, AmbientContext, AmbientDecor } from './components/AmbientDecor'
import { Boundary } from './components/Boundary'
import { ThemePanel } from './components/ThemePanel'
import { EditorPane, forgetClosedScroll } from './components/EditorPane'
import { forgetClosedEditors } from './components/EditorMount'
import { FileNameDialog } from './components/FileDialogs'
import { StrataIcon } from './components/Logo'
import { CloseTabDialog, ConflictDialog, DetachDialog, MixedRevertDialog, RecoveryDialog, ResolveSuggestionDialog, RevertAllDialog } from './components/Overlays'
import { Resizer } from './components/Resizer'
import { RightRail } from './components/RightRail'
import { forgetComposerDrafts, SendComposer } from './components/SendComposer'
import { ShortcutSheet } from './components/ShortcutSheet'
import { forgetReplyDrafts, ItemPanel } from './components/ItemPanel'
import { Toast } from './components/Toast'
import { TopBar } from './components/TopBar'
import { Contents } from './components/Contents'
import { NavigationRail, type LeftTab } from './components/NavigationRail'
import { ProjectsPanel } from './components/ProjectsPanel'
import { Conversation } from './components/Conversation'
import { EngineDialog } from './components/EngineDialog'
import { NewConversation } from './components/NewConversation'
import { AccountsDialog } from './components/AccountsDialog'
import { activitySnapshot, agentActivity, agentActivityMessage, ambientStyles, clampPanelSize, clampThemePanel, currentAnnotation, cycleTab, EMPTY_VIEW, hasUnsavedCounted, isZoomed, leftWindowWidth, overlayCoversPage, nextReviewTarget, PANEL_LIMITS, pendingCount, projectForPath, rendererThemeStyle, reviewTargets, shouldAdoptPushed, sideWindowCeiling, stepZoom, tabsToClose, threadTargets, type ActivitySnapshot, type ScreenBox, type NumericPanelKey, type ReviewTarget } from './model'
import { flushPendingBuffer, peekPendingBuffer, setPendingBuffer } from './pendingBuffer'
import { nextToast, type ToastAction, type ToastState } from './toasts'
import { consumeDocumentLaunch, readWorkspace, writeWorkspace } from './workspaceState'
import { draftAttachmentIds, readDraft, writeDraft, readNewConversationTarget, writeNewConversationTarget, type NewConversationTarget } from './conversationDrafts'
import { hasPrimaryModifier } from '../shared/primary-modifier'

/** Ctrl+Enter inside the annotation composer or a thread reply belongs to that form (§5.2). */
function insideOwnForm(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('.annotation-composer, .thread-panel, .editor-popover') !== null
}

type FileDialogState = { kind: 'new'; directory: string }

interface AppProps { createEditor: RendererEditorFactory }

function hasFileTransfer(dataTransfer: DataTransfer, includeDroppedFiles = false): boolean {
  return Array.from(dataTransfer.types).includes('Files') || includeDroppedFiles && dataTransfer.files.length > 0
}

export function App({ createEditor }: AppProps) {
  const [view, setView] = useState<AppView>(EMPTY_VIEW)
  const [ready, setReady] = useState(false)
  const [toast, setToast] = useState<ToastState | null>(null)
  const [composer, setComposer] = useState(false)
  const [closingTab, setClosingTab] = useState<DocumentTabView | null>(null)
  const [mixedHunk, setMixedHunk] = useState<HunkView | null>(null)
  const [revertAll, setRevertAll] = useState<{ name: string; hunks: HunkView[] } | null>(null)
  const [detaching, setDetaching] = useState<AttachmentView | null>(null)
  const [selectedAnnotation, setSelectedAnnotation] = useState<AnnotationView | null>(null)
  const engineNavigationIntent = useRef(0)
  const engineNavigationTimer = useRef<number | null>(null)
  const [savedWorkspace] = useState(readWorkspace)
  useEffect(consumeDocumentLaunch, [])
  const [conversationCentered, setConversationCentered] = useState(savedWorkspace.conversationCentered)
  /** Preview windows (docs/plans/open/visual-review, phase 2): one per project, a third kind of center content. */
  const [previews, setPreviews] = useState<string[]>(savedWorkspace.previews)
  const [previewCentered, setPreviewCentered] = useState<string | null>(savedWorkspace.previewCentered)
  const [previewNavigationTab, setPreviewNavigationTab] = useState<'projects' | 'conversation'>('projects')
  const [projectQuery, setProjectQuery] = useState('')
  const [activePreviewTabs, setActivePreviewTabs] = useState<Record<string, string>>({})
  const [documentPicker, setDocumentPicker] = useState<NewConversationTarget | null>(readNewConversationTarget)
  useEffect(() => { writeNewConversationTarget(documentPicker) }, [documentPicker])
  const previewShown = previewCentered !== null && previews.includes(previewCentered) ? previewCentered : null
  const centerConversationId = conversationCentered && !previewShown ? (documentPicker ? '__new__' : view.engine.activeThreadId) : null
  /** Conversation tabs stay listed while a document shows and survive restarts. */
  const [conversationTabs, setConversationTabs] = useState<string[]>(savedWorkspace.conversationTabs)
  useEffect(() => {
    if (!ready) return
    // The engine restores its active thread independently, sometimes after the first view.
    const id = view.engine.activeThreadId
    if (conversationCentered && !documentPicker && id && !conversationTabs.includes(id)) {
      setConversationTabs((current) => current.includes(id) ? current : [...current, id])
      return
    }
    writeWorkspace({ conversationCentered, conversationTabs, previews, previewCentered: previewShown })
  }, [ready, view.engine.activeThreadId, conversationCentered, conversationTabs, documentPicker, previews, previewShown])
  const [confirmResolve, setConfirmResolve] = useState(false)
  /** The annotation session (docs/plans/open/visual-review): over a staged composer image, or over a held comment's draft. */
  // Annotate on a page (docs/plans/open/visual-review, phase 3): the frames captured from a live tab and the page they came from.
  const [annotating, setAnnotating] = useState<{ sessionId: string; identity: string | null; destination: VisualDestinationView; data: VisualSessionData; tabId: string; projectId: string; captures: VisualCaptureView[]; page: VisualPageCapture['page'] } | null>(null)
  const annotationClose = useRef<(() => Promise<void>) | null>(null)
  const annotationLoaded = useRef<string | null>(null)
  useEffect(() => {
    const identity = view.engine.identity
    if (!identity || annotationLoaded.current === identity) return
    annotationLoaded.current = identity
    try {
      const saved = JSON.parse(localStorage.getItem(`stratamd.annotation.${identity}`) ?? 'null')
      if (saved?.identity === identity && saved.sessionId && saved.destination && Array.isArray(saved.captures) && saved.data?.marks) setAnnotating(saved)
    } catch { /* An unreadable recovery record is left in place. */ }
  }, [view.engine.identity])
  useLayoutEffect(() => {
    if (annotating?.identity) localStorage.setItem(`stratamd.annotation.${annotating.identity}`, JSON.stringify(annotating))
  }, [annotating])
  useEffect(() => {
    if (annotating && annotating.projectId !== previewShown) void window.strata.clearPreviewOverrides(annotating.tabId).catch(() => undefined)
  }, [previewShown, annotating?.sessionId])
  const [visualFallback, setVisualFallback] = useState<{ id: string; reason: string; url: string | null } | null>(null)
  const [visualSession, setVisualSession] = useState<{ kind: 'staged'; id: string; name: string; width: number; height: number; projectId: string; destination: VisualDestinationView } | { kind: 'comment'; id: string } | null>(null)
  /** A visual comment's card opened from the conversation, with its history and actions. */
  const [visualOpen, setVisualOpen] = useState<string | null>(null)
  /** Staged images whose bytes moved into a held visual comment; the composer drops them without a discard. */
  const [consumedStaged, setConsumedStaged] = useState<string[]>([])
  /** The engine dialog: pairing, server, version, connection state (§5.1). */
  const [terminalOpen, setTerminalOpen] = useState(false)
  const [engineDialog, setEngineDialog] = useState(() => sessionStorage.getItem('stratamd.reopen-engine-dialog') === '1')
  useEffect(() => { sessionStorage.removeItem('stratamd.reopen-engine-dialog') }, [])
  useEffect(() => { if (view.engine.managed?.state === 'failed') setEngineDialog(true) }, [view.engine.managed?.state])
  /** The picker (§5.7): from Projects with no document, or from a document, carrying the popover's pending comment when there is one. */
  const [usageOpen, setUsageOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [accountsDialog, setAccountsDialog] = useState(false)
  /** The window width, for the side windows' layout budget (§6.9). */
  const [windowWidth, setWindowWidth] = useState(() => window.innerWidth)
  useEffect(() => {
    const onResize = () => setWindowWidth(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  const [jumpHunkId, setJumpHunkId] = useState<string | null>(null)
  const [jumpAnnotationId, setJumpAnnotationId] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  useLayoutEffect(() => {
    const dismissDropOverlay = () => setDragging(false)
    // Capture all mouse buttons, even when a child stops the event. A canceled
    // or completed drag must also clear the overlay if dragleave was missed.
    window.addEventListener('pointerdown', dismissDropOverlay, true)
    window.addEventListener('dragend', dismissDropOverlay, true)
    window.addEventListener('drop', dismissDropOverlay, true)
    window.addEventListener('blur', dismissDropOverlay)
    return () => {
      window.removeEventListener('pointerdown', dismissDropOverlay, true)
      window.removeEventListener('dragend', dismissDropOverlay, true)
      window.removeEventListener('drop', dismissDropOverlay, true)
      window.removeEventListener('blur', dismissDropOverlay)
    }
  }, [])
  const [rightRailCollapsed, setRightRailCollapsed] = useState(false)
  const [panelSizes, setPanelSizes] = useState<PanelSizes>(EMPTY_VIEW.settings.panelSizes)
  const [zoom, setZoom] = useState<PaneZoom>(EMPTY_VIEW.settings.zoom)
  const [themeOpen, setThemeOpen] = useState(false)
  const [themeHighlight, setThemeHighlight] = useState<string | null>(null)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [fileDialog, setFileDialog] = useState<FileDialogState | null>(null)
  const [headingState, setHeadingState] = useState<{ path: string; headings: readonly EditorHeading[]; activeId: string | null }>({ path: '', headings: [], activeId: null })
  const [jumpHeading, setJumpHeading] = useState<{ id: string; token: number } | null>(null)
  const editorHandle = useRef<RendererEditorHandle | null>(null)
  const zoomRef = useRef<PaneZoom>(EMPTY_VIEW.settings.zoom)
  // Shortcuts that act on the tab list read it from here. The keydown listener
  // below re-registers in a passive effect after a tab switch commits, and a
  // key that lands in that gap would otherwise cycle from the previous list
  // and stop on the tab that is already active (a race the shell-keyboard
  // spec caught under load). A layout effect updates the ref before anything
  // can observe the new DOM.
  const latestTabs = useRef(view.tabs)
  useLayoutEffect(() => { latestTabs.current = view.tabs }, [view.tabs])
  // The same for the active document: the source toggle read a mode from the
  // previous closure and toggled back to it (view-sync spec, under load).
  const latestDocument = useRef(view.activeDocument)
  useLayoutEffect(() => { latestDocument.current = view.activeDocument }, [view.activeDocument])
  /** What this window last committed, so a push that merely echoes it never overrides a drag in progress (§5.14). */
  const committedPanels = useRef<PanelSizes | null>(null)
  const committedZoom = useRef<PaneZoom | null>(null)
  /** Pending changes and open suggestions seen per document, for the agent-activity note (§5.4). */
  const activitySeen = useRef(new Map<string, ActivitySnapshot>())
  const showTarget = useRef<(target: ReviewTarget) => void>(() => undefined)
  /** The last comment or question stepped to with F8 / Shift+F8. */
  const threadCursor = useRef<string | null>(null)
  /** The rail row or key press that opened the thread; the jump moves focus into the editor before the panel mounts. */
  const threadOpener = useRef<HTMLElement | null>(null)
  const rememberThreadOpener = () => { threadOpener.current = globalThis.document.activeElement instanceof HTMLElement ? globalThis.document.activeElement : null }
  const hoveredPane = useRef<PaneId | null>(null)
  const zoomPersist = useRef<number | null>(null)
  const mirrorTimer = useRef<number | null>(null)
  const typingTimer = useRef<number | null>(null)
  /** The last change stepped to with F7 / Shift+F7, so the next press continues from it. */
  const reviewCursor = useRef<string | null>(null)
  const windowState = useWindowState()
  const document = view.activeDocument
  const headings = document && headingState.path === document.path ? headingState.headings : []
  const activeHeadingId = document && headingState.path === document.path ? headingState.activeId : null

  const report = useCallback((message: string, action?: ToastAction) => setToast((current) => nextToast(current, { message, tone: 'info', ...(action ? { action } : {}) })), [])
  const reportError = useCallback((message: string) => setToast((current) => nextToast(current, { message, tone: 'error' })), [])
  const dismissToast = useCallback(() => setToast(null), [])
  const perform = useCallback(async (job: () => Promise<unknown>, message?: string) => {
    try { await job(); if (message) report(message) }
    catch (error) { reportError(error instanceof Error ? error.message : 'The action failed') }
  }, [report, reportError])
  const cancelEngineNavigation = useCallback(() => {
    engineNavigationIntent.current += 1
    if (engineNavigationTimer.current !== null) window.clearTimeout(engineNavigationTimer.current)
    engineNavigationTimer.current = null
  }, [])
  useEffect(() => () => { if (engineNavigationTimer.current !== null) window.clearTimeout(engineNavigationTimer.current) }, [])
  const selectNavigationTab = useCallback((tab: NavigationTab) => {
    if (!document) return
    void perform(() => window.strata.updateReadingState(document.path, { navigationTab: tab }))
  }, [document, perform])
  /** Opens a document item inside Conversation, or returns to the transcript. */
  const showThread = useCallback((annotation: AnnotationView | null) => {
    setSelectedAnnotation(annotation)
    if (annotation !== null) selectNavigationTab('conversation')
    setConfirmResolve(false)
  }, [selectNavigationTab])
  const selectLeftTab = useCallback((tab: LeftTab) => {
    cancelEngineNavigation()
    if (previewShown) {
      if (tab !== 'contents') setPreviewNavigationTab(tab)
    } else if (!conversationCentered) selectNavigationTab(tab)
  }, [cancelEngineNavigation, selectNavigationTab, conversationCentered, previewShown])
  const selectReviewTab = useCallback((tab: ReviewTab) => {
    if (!document) return
    void perform(() => window.strata.updateReadingState(document.path, { reviewTab: tab }))
  }, [document, perform])
  const updateWalkthrough = useCallback((action: WalkthroughAction) => {
    if (!document) return
    void perform(() => window.strata.updateWalkthrough(document.path, action))
  }, [document, perform])
  const openTheme = useCallback(() => { setThemeOpen(true); void perform(() => window.strata.openThemeSample()) }, [perform])

  useEffect(() => {
    let mounted = true
    let receivedPush = false
    let previousDocument: string | null | undefined
    const adopt = (next: AppView) => {
      const path = next.activeDocument?.path ?? null
      // Closing the active tab selects a replacement without requesting document mode.
      const previousDocumentClosed = previousDocument != null && !next.tabs.some((tab) => tab.path === previousDocument)
      if (previousDocument !== undefined && path && path !== previousDocument && !previousDocumentClosed) { setConversationCentered(false); setPreviewCentered(null) }
      previousDocument = path
      setView(next)
      if (shouldAdoptPushed(next.settings.panelSizes, committedPanels.current)) {
        committedPanels.current = next.settings.panelSizes
        setPanelSizes(next.settings.panelSizes)
      }
      if (shouldAdoptPushed(next.settings.zoom, committedZoom.current)) {
        committedZoom.current = next.settings.zoom
        setZoom(next.settings.zoom); zoomRef.current = next.settings.zoom
      }
    }
    const noticeActivity = (next: AppView) => {
      const current = next.activeDocument
      if (!current) return
      const activity = agentActivity(activitySeen.current.get(current.path) ?? null, current)
      activitySeen.current.set(current.path, activitySnapshot(current))
      for (const path of activitySeen.current.keys()) if (!next.tabs.some((tab) => tab.path === path)) activitySeen.current.delete(path)
      if (!activity) return
      report(agentActivityMessage(activity), { label: 'Show', run: () => showTarget.current(activity.target) })
      if (!globalThis.document.hasFocus()) window.strata.flashWindow?.()
    }
    void window.strata.getState().then((next) => {
      if (!mounted) return
      if (!receivedPush) adopt(next)
      if (next.activeDocument) activitySeen.current.set(next.activeDocument.path, activitySnapshot(next.activeDocument))
      setReady(true)
    }).catch((error: unknown) => { reportError(error instanceof Error ? error.message : 'Could not load StrataMD'); setReady(true) })
    const unsubscribe = window.strata.subscribe((next) => {
      if (!mounted) return
      receivedPush = true
      adopt(next)
      noticeActivity(next)
    })
    return () => { mounted = false; unsubscribe() }
  }, [report, reportError])

  useEffect(() => {
    if (!ready || view.engine.state !== 'connected' || (view.engine.managed && view.engine.managed.state !== 'running')) return
    // Wait for automatic pairing to finish before sweeping this connection's staged images.
    void window.strata.retainConversationAttachments?.(draftAttachmentIds()).catch((error: unknown) => reportError(error instanceof Error ? error.message : 'Could not tidy staged attachments'))
  }, [ready, view.engine.identity, view.engine.state, view.engine.managed?.state, reportError])

  useEffect(() => () => {
    if (mirrorTimer.current !== null) window.clearTimeout(mirrorTimer.current)
    if (typingTimer.current !== null) window.clearTimeout(typingTimer.current)
  }, [])

  const applyZoom = useCallback((next: PaneZoom, immediate = false) => {
    zoomRef.current = next
    setZoom(next)
    if (zoomPersist.current !== null) window.clearTimeout(zoomPersist.current)
    const persist = () => { zoomPersist.current = null; committedZoom.current = next; void perform(() => window.strata.updateSettings({ zoom: next })) }
    if (immediate) persist()
    else zoomPersist.current = window.setTimeout(persist, 250)
  }, [perform])
  const zoomPane = useCallback((pane: PaneId, direction: 1 | -1) => {
    const current = zoomRef.current
    applyZoom({ ...current, [pane]: stepZoom(current[pane], direction) })
  }, [applyZoom])
  const resetZoom = useCallback(() => applyZoom({ explorer: 1, editor: 1, rightRail: 1, composer: 1, themePanel: 1 }, true), [applyZoom])

  useEffect(() => {
    const paneOf = (target: EventTarget | null): PaneId | null => {
      const pane = target instanceof Element ? target.closest<HTMLElement>('[data-pane]')?.dataset.pane : undefined
      return pane === 'explorer' || pane === 'editor' || pane === 'rightRail' || pane === 'composer' || pane === 'themePanel' ? pane : null
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
      if (event.target instanceof Element && event.target.closest('.strata-mermaid-viewport')) return
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

  const commitPanels = useCallback((next: PanelSizes) => {
    committedPanels.current = next
    void perform(() => window.strata.updateSettings({ panelSizes: next }))
  }, [perform])
  const updateThemePanel = useCallback((geometry: ThemePanelGeometry, commit: boolean) => {
    setPanelSizes((sizes) => ({ ...sizes, themePanel: geometry }))
    if (commit) commitPanels({ ...panelSizes, themePanel: geometry })
  }, [commitPanels, panelSizes])
  const themePanel = themeOpen && (
    <ThemePanel
      theme={view.settings.theme}
      zoom={zoom.themePanel}
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
    if (commit) commitPanels({ ...panelSizes, [key]: clamped })
  }, [commitPanels, panelSizes])

  const updatePanelSize = useCallback((key: 'annotationComposer' | 'sendComposer', value: PanelSize, commit: boolean) => {
    setPanelSizes((sizes) => ({ ...sizes, [key]: value }))
    if (commit) commitPanels({ ...panelSizes, [key]: value })
  }, [commitPanels, panelSizes])

  // One left width for every tab (decided 2026-09-04); the handle between it and the editor edits it.
  const thread = document ? currentAnnotation(document, selectedAnnotation) : null
  const rightRailVisible = previewShown !== null || (Boolean(document) && !conversationCentered)
  const rightRailWidth = rightRailVisible && !rightRailCollapsed ? panelSizes.rightRailWidth : 0
  const leftWidth = leftWindowWidth({ ...panelSizes, rightRailWidth }, windowWidth)
  const leftMin = PANEL_LIMITS.explorerWidth[0]
  const leftMax = sideWindowCeiling(leftMin, windowWidth, rightRailWidth)
  const rightMax = sideWindowCeiling(PANEL_LIMITS.rightRailWidth[0], windowWidth, leftWidth)
  const resizeLeft = (value: number, commit: boolean) => updatePanel('explorerWidth', value, commit)
  const threadEmpty = (
    <div className="empty-subtle thread-empty">
      No item open.
      <small>Click a highlighted passage, or a row under Items, to read it here.</small>
    </div>
  )
  const resolveThread = (current: DocumentView, open: AnnotationView) => void perform(async () => { await window.strata.resolveAnnotation(current.path, open.id); showThread(null) }, 'Thread resolved. It stays until cleared.')
  const threadNode = (current: DocumentView, open: AnnotationView) => (
    <ItemPanel
      key={open.id}
      annotation={open}
      visible={!conversationCentered && current.reading.navigationTab === 'conversation'}
      documentPath={current.path}
      onReply={(text) => void perform(() => window.strata.reply(current.path, open.id, text))}
      // Resolving an open suggestion is neither Accept nor Reject: confirm first (PRD §6.5).
      onResolve={() => open.kind === 'suggestion' && open.status === 'open' ? setConfirmResolve(true) : resolveThread(current, open)}
      onAnswer={(answer) => void perform(() => window.strata.answerDecision(current.path, open.id, answer), 'Decision answered. It is selected in the next Send.')}
      onReopen={() => void perform(() => window.strata.reopenDecision(current.path, open.id), 'Decision reopened.')}
      onAccept={() => void perform(() => window.strata.acceptSuggestion(current.path, open.id), 'Suggestion accepted as your change.')}
      onReject={() => void perform(() => window.strata.rejectSuggestion(current.path, open.id), 'Suggestion rejected.')}
      onClose={() => showThread(null)}
      opener={threadOpener}
    />
  )
  const reconnectEngine = () => void perform(() => window.strata.reconnectEngine())
  const pickerDocument = documentPicker?.path && document?.path === documentPicker.path ? document : null
  const beginNewConversation = (projectId?: string) => {
    cancelEngineNavigation()
    const currentProject = projectId ?? (conversationCentered ? documentPicker?.projectId : document ? projectForPath(view.engine, document.path)?.id : undefined) ?? view.engine.projects.find((project) => project.threads.some((thread) => thread.id === view.engine.activeThreadId))?.id ?? view.engine.projects[0]?.id
    setDocumentPicker({ path: null, ...(currentProject ? { projectId: currentProject } : {}) })
    setConversationCentered(true)
    setPreviewCentered(null)
  }
  useEffect(() => {
    const start = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'n') {
        event.preventDefault()
        if (!globalThis.document.querySelector('[role="dialog"]')) beginNewConversation()
      }
    }
    window.addEventListener('keydown', start)
    return () => window.removeEventListener('keydown', start)
  }, [documentPicker?.projectId, view.engine.activeThreadId, view.engine.projects, document?.path, conversationCentered])
  const openUsage = () => { setAccountsDialog(false); setUsageOpen(true) }
  const openAccounts = () => {
    setUsageOpen(false)
    setEngineDialog(false)
    setAccountsDialog(true)
    // The probe on open (§5.13): a fresh usage reading while the modal is up; a failure keeps the last measurement.
    void window.strata.refreshAccounts().catch(() => undefined)
  }
  const openSettings = () => { setAccountsDialog(false); setEngineDialog(false); setSettingsOpen(true) }
  const settingsDialogNode = settingsOpen && <SettingsDialog engine={view.engine} onClose={() => setSettingsOpen(false)} />
  const engineDialogNode = engineDialog && <EngineDialog engine={view.engine} onPair={async (request) => { sessionStorage.setItem('stratamd.reopen-engine-dialog', '1'); try { await window.strata.pairEngine(request) } catch (error) { sessionStorage.removeItem('stratamd.reopen-engine-dialog'); throw error }; report('Paired. Projects and threads come from this server now.') }} onReconnect={reconnectEngine} onClose={() => setEngineDialog(false)} onOpenAccounts={openAccounts} />
  const usageDialogNode = usageOpen && <UsageDialog connected={view.engine.state === 'connected'} onClose={() => setUsageOpen(false)} onAccounts={openAccounts} />
  const accountsDialogNode = accountsDialog && <AccountsDialog onOpenSettings={openSettings} onOpenUsage={openUsage} engine={view.engine} onPark={(instanceId, parked) => void perform(() => window.strata.parkAccount(instanceId, parked))} onTerminalDefault={(driver, selection) => void perform(() => window.strata.setTerminalDefault(driver, selection))} onClose={() => setAccountsDialog(false)} onOpenEngine={() => { setAccountsDialog(false); setEngineDialog(true) }} />
  const runConversation = {
    ...(document ? { onDocumentContext: () => setComposer(true) } : {}),
    onReconnect: reconnectEngine,
    onCopyText: (text: string) => void perform(() => window.strata.copyText(text), 'Message copied.'),
    onStart: (threadId: string, input: Parameters<typeof window.strata.startConversationTurn>[1]) => window.strata.startConversationTurn(threadId, input),
    onStop: (threadId: string) => void perform(() => window.strata.stopConversationTurn(threadId), 'Stop requested.'),
    onApproval: (threadId: string, requestId: string, decision: 'accept' | 'decline') => void perform(() => window.strata.answerEngineApproval(threadId, requestId, decision)),
    onUserInput: (threadId: string, requestId: string, answers: Record<string, unknown>) => void perform(() => window.strata.answerEngineUserInput(threadId, requestId, answers)),
    onQueueReply: (threadId: string, item: ItemView, text: string) => void perform(() => window.strata.queueItemReply(threadId, item.id, text)),
    onDismissItem: (threadId: string, item: ItemView) => void perform(() => window.strata.dismissItem(threadId, item.id)),
    // A changed Markdown file opens as a document; the center leaves the conversation or preview for it (§6.9).
    onOpenDocument: (path: string) => { setConversationCentered(false); setPreviewCentered(null); void perform(() => window.strata.openDocument(path)) },
  }
  const activeEngineThread = view.engine.projects.flatMap((project) => project.threads).find((candidate) => candidate.id === view.engine.activeThreadId) ?? null
  const activeThreadProject = view.engine.projects.find((project) => project.threads.some((candidate) => candidate.id === view.engine.activeThreadId)) ?? null
  const allVisual = view.engine.projects.flatMap((project) => project.visualComments ?? [])
  const visualById = (id: string) => allVisual.find((comment) => comment.id === id) ?? null
  /** Adjustments on the live page: the whole set at once, then the requested appearance comes back as a frame. */
  const adjustOn = (tabId: string) => async (adjustments: VisualAdjustmentView[], marks: VisualMarkView[]): Promise<VisualCaptureView | null> => {
    if (adjustments.length === 0) { await window.strata.clearPreviewOverrides(tabId); return null }
    const targets = new Map<string, { markId: string; identity: NonNullable<VisualMarkView['identity']>; declarations: Record<string, string> }>()
    for (const adjustment of adjustments) {
      const mark = marks.find((candidate) => candidate.id === adjustment.markId)
      if (!mark?.identity) continue
      const target = targets.get(mark.id) ?? { markId: mark.id, identity: mark.identity, declarations: {} }
      target.declarations[adjustment.property] = adjustment.value
      targets.set(mark.id, target)
    }
    const result = await window.strata.adjustPreview(tabId, [...targets.values()])
    return result.capture
  }
  /** Mark on a page: the click or box goes to the live page in its own pixels and the answer comes back in capture pixels. */
  const describeOn = (tabId: string, capture: VisualCaptureView) => async (target: { point: VisualPointView } | { rect: VisualRectView }): Promise<VisualProposal | null> => {
    const scale = capture.scale ?? 1
    const proposal = await window.strata.describePreview(tabId, 'point' in target ? { point: toPagePoint(target.point, scale) } : { rect: toPageRect(target.rect, scale) })
    return proposal ? { kind: proposal.kind, label: proposal.label, rect: toCaptureRect(proposal.rect, scale), found: proposal.found, ...(proposal.identity ? { identity: proposal.identity } : {}) } : null
  }
  /** A pasted or picked image opens the session over its staged bytes; the destination is the active conversation now. */
  const markUpImage = (attachment: DraftAttachment) => {
    if (attachment.kind !== 'image') return
    if (!activeEngineThread || !activeThreadProject) { report('Open a conversation before marking up an image.'); return }
    const destination = { threadId: activeEngineThread.id, threadTitle: activeEngineThread.title }
    const projectId = activeThreadProject.id
    void perform(async () => {
      const image = await loadImage(visualImageUrl('staged', attachment.id))
      setVisualSession({ kind: 'staged', id: attachment.id, name: attachment.name, width: image.naturalWidth, height: image.naturalHeight, projectId, destination })
    })
  }
  const holdVisual = async (input: HoldVisualCommentInput) => {
    const id = await window.strata.holdVisualComment(input)
    if (input.source) setConsumedStaged((current) => [...current, input.source!.staged])
    return id
  }
  /** Send now: one turn carrying only this comment, to the destination the session recorded. */
  const sendVisual = async (id: string, threadId: string) => {
    const thread = view.engine.projects.flatMap((project) => project.threads).find((candidate) => candidate.id === threadId)
    if (!thread) throw new Error('The conversation this comment goes to is no longer listed')
    await window.strata.startConversationTurn(thread.id, { text: '', model: thread.model, instanceId: thread.providerInstanceId, effort: thread.effort, access: thread.access, ...(thread.options ? { options: thread.options } : {}), visual: [id] })
  }
  const visualActions: VisualCardActions = {
    onOpen: (comment) => { if (comment.draft) { setVisualOpen(null); setVisualSession({ kind: 'comment', id: comment.id }) } else setVisualOpen(comment.id) },
    onAccept: (comment) => void perform(() => window.strata.actVisualComment(comment.id, 'accept'), 'Accepted. Nothing was sent.'),
    onReopen: (comment) => void perform(async () => { await window.strata.actVisualComment(comment.id, 'reopen'); setVisualOpen(null); setVisualSession({ kind: 'comment', id: comment.id }) }),
    onRetry: (comment) => void perform(() => window.strata.actVisualComment(comment.id, 'retry'), 'Sending again.'),
    onDiscard: (comment) => void perform(() => window.strata.actVisualComment(comment.id, 'discard'), 'Visual comment discarded.'),
    onCompare: (comment) => { setVisualFallback(null); setVisualOpen(comment.id) },
    // Show me: the original tab when it still shows the page, else the saved evidence with a way to open the page.
    onShowMe: (comment) => void perform(async () => {
      const result = await window.strata.showVisualComment(comment.id)
      if (result.shown) {
        const tab = previewTabs.find((candidate) => candidate.id === result.tabId)
        if (tab) { showPreview(tab.projectId); setActivePreviewTabs((current) => ({ ...current, [tab.projectId]: tab.id })) }
        setVisualOpen(null)
        const total = (comment.draft ?? comment.revisions.at(-1))?.marks.filter((mark) => mark.kind === 'element').length ?? 0
        report(total === 0 ? 'Showing the page at the size and scroll of the comment.' : result.outlined.length === total ? 'Showing the page as it was marked; the marked things are outlined.' : result.outlined.length === 0 ? 'Showing the page at the size and scroll of the comment. The marked things were not found; a selected row, an open dialog, or unsaved form does not come back.' : `Showing the page as it was marked; ${result.outlined.length} of ${total} marked things outlined.`)
      } else {
        setVisualFallback({ id: comment.id, reason: result.reason, url: result.url })
        setVisualOpen(comment.id)
      }
    }),
  }
  const visualSessionNode = (() => {
    if (!visualSession) return null
    if (visualSession.kind === 'staged') {
      const capture = { id: visualSession.id, url: visualImageUrl('staged', visualSession.id), width: visualSession.width, height: visualSession.height }
      return <VisualSession key={visualSession.id} capture={capture} source={{ staged: visualSession.id, name: visualSession.name }} projectId={visualSession.projectId} destination={visualSession.destination} place={`Pasted image · ${visualSession.width} × ${visualSession.height}`} onHold={holdVisual} onSend={(id) => sendVisual(id, visualSession.destination.threadId)} onCancelAttachment={async () => {
        const key = `thread:${visualSession.destination.threadId}`
        const draft = readDraft(key)
        const attachments = (draft.attachments ?? []).filter(attachment => attachment.kind !== 'image' || attachment.id !== visualSession.id)
        if (!writeDraft(key, { ...draft, attachments })) throw new Error(`Could not remove ${visualSession.name} from the saved draft`)
        setConsumedStaged(current => [...current, visualSession.id])
        await window.strata.discardConversationAttachment(visualSession.id)
      }} onClose={() => setVisualSession(null)} onError={reportError} />
    }
    const comment = visualById(visualSession.id)
    const capture = comment?.captures[0]
    if (!comment?.draft || !capture) return null
    const destination = comment.draft.destination
    // A held page comment reopens over its captures; the live tab answers Mark again while it still shows that page.
    const liveTab = comment.anchor.kind === 'page' ? view.preview.tabs.find((tab) => tab.id === (comment.anchor as { instance: string }).instance && tab.url.replace(/#.*$/, '') === (comment.anchor as { url: string }).url.replace(/#.*$/, '')) ?? null : null
    const clean = comment.captures.filter((frame) => !frame.requested)
    return <VisualSession key={comment.id} capture={capture} captures={clean.length ? clean : comment.captures} commentId={comment.id} {...(comment.anchor.kind === 'page' ? { page: { tabId: comment.anchor.instance, url: comment.anchor.url, title: comment.anchor.title, viewport: comment.anchor.viewport, preset: comment.anchor.preset, deviceScale: capture.scale ?? 1, captures: clean.map(frame => ({ id: frame.id, width: frame.width, height: frame.height, scroll: frame.scroll ?? { x: 0, y: 0 }, scale: frame.scale ?? 1 })) } } : {})} projectId={comment.projectId} destination={destination} place={comment.place} initial={{ text: comment.draft.text, marks: comment.draft.marks, strokes: comment.draft.strokes, adjustments: comment.draft.adjustments, requested: comment.captures.find(capture => capture.id === comment.draft?.requestedCaptureId) }} describe={liveTab ? describeOn(liveTab.id, clean.at(-1) ?? capture) : undefined} onAdjust={liveTab ? adjustOn(liveTab.id) : undefined} adjustStatus={liveTab ? 'shown live' : 'not shown: the page is not open'} onHold={holdVisual} onSend={(id) => sendVisual(id, destination.threadId)} onClose={() => { setVisualSession(null); if (liveTab) void window.strata.clearPreviewOverrides(liveTab.id).catch(() => undefined) }} onError={reportError} />
  })()
  const visualPanelNode = visualOpen && visualById(visualOpen) ? <VisualCommentPanel comment={visualById(visualOpen)!} actions={visualActions} notice={visualFallback?.id === visualOpen ? visualFallback.reason : null} onOpenPage={visualFallback?.id === visualOpen && visualFallback.url ? () => { const url = visualFallback.url!; const projectId = visualById(visualOpen)!.projectId; setVisualOpen(null); setVisualFallback(null); showPreview(projectId); void perform(async () => { const id = await window.strata.openPreviewTab({ projectId, url }); setActivePreviewTabs((current) => ({ ...current, [projectId]: id })) }) } : undefined} onClose={() => { setVisualOpen(null); setVisualFallback(null) }} /> : null
  // ---- Preview windows (docs/plans/open/visual-review, phase 2)
  const previewTabs = view.preview.tabs
  const previewProjectIds = [...new Set([...previews, ...previewTabs.map((tab) => tab.projectId)])].filter((id) => view.engine.projects.some((project) => project.id === id))
  const showPreview = (projectId: string) => {
    setPreviews((current) => current.includes(projectId) ? current : [...current, projectId])
    setPreviewCentered(projectId)
    setDocumentPicker(null)
  }
  const openPreview = (projectId: string) => {
    showPreview(projectId)
    if (!previewTabs.some((tab) => tab.projectId === projectId)) void perform(async () => { const id = await window.strata.openPreviewTab({ projectId }); setActivePreviewTabs((current) => ({ ...current, [projectId]: id })) })
  }
  const closePreview = (projectId: string) => void perform(async () => {
    for (const tab of previewTabs.filter((candidate) => candidate.projectId === projectId)) await window.strata.closePreviewTab(tab.id)
    setPreviews((current) => current.filter((id) => id !== projectId))
    setPreviewCentered((current) => current === projectId ? null : current)
  })
  // An agent's open reveals its window: the pill appears and the tab strip lists the tab; the owner's center stays where it was.
  const revealAt = useRef(0)
  useEffect(() => {
    const reveal = view.preview.reveal
    if (!reveal || reveal.at === revealAt.current) return
    revealAt.current = reveal.at
    const tab = previewTabs.find((candidate) => candidate.id === reveal.tabId)
    if (tab) setPreviews((current) => current.includes(tab.projectId) ? current : [...current, tab.projectId])
  }, [view.preview.reveal])
  // The overlay layer reports one boolean: while a modal is open, or an overlay sits over the page's hole, the page hides beneath it.
  // A panel or popover elsewhere in the shell leaves the page showing.
  const overlayReported = useRef<boolean | null>(null)
  useEffect(() => {
    const selector = '[role="dialog"], [aria-modal="true"], .modal-backdrop, .visual-session, .theme-panel, [role="menu"], :popover-open, .drop-overlay'
    const boxOf = (element: Element): ScreenBox => { const rect = element.getBoundingClientRect(); return { x: rect.left, y: rect.top, width: rect.width, height: rect.height } }
    const modal = (element: Element) => element.getAttribute('aria-modal') === 'true' || element.classList.contains('modal-backdrop')
    let frame = 0
    const check = () => {
      frame = 0
      const hole = globalThis.document.querySelector('.preview-hole')
      const overlays = [...globalThis.document.querySelectorAll(selector)].map((element) => ({ box: boxOf(element), modal: modal(element) }))
      const open = overlayCoversPage(hole ? boxOf(hole) : null, overlays)
      if (overlayReported.current === open) return
      overlayReported.current = open
      void window.strata.reportOverlay(open).catch(() => undefined)
    }
    const schedule = () => { if (frame === 0) frame = window.requestAnimationFrame(check) }
    const observer = new MutationObserver(schedule)
    // Style joins the list because a dragged panel moves through its inline style; a popover closing fires toggle without any mutation.
    observer.observe(globalThis.document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['open', 'popover', 'hidden', 'role', 'class', 'style'] })
    globalThis.document.addEventListener('toggle', schedule, true)
    window.addEventListener('resize', schedule)
    window.addEventListener('scroll', schedule, true)
    check()
    return () => {
      observer.disconnect()
      globalThis.document.removeEventListener('toggle', schedule, true)
      window.removeEventListener('resize', schedule)
      window.removeEventListener('scroll', schedule, true)
      if (frame) window.cancelAnimationFrame(frame)
    }
  }, [])
  const previewPills = previewProjectIds.map((projectId) => {
    const project = view.engine.projects.find((candidate) => candidate.id === projectId)!
    const tabs = previewTabs.filter((tab) => tab.projectId === projectId)
    const active = tabs.find((tab) => tab.id === activePreviewTabs[projectId]) ?? tabs.find((tab) => tab.kind === 'owner') ?? tabs[0] ?? null
    return { id: projectId, name: previewPillName(project.title, active ? { url: active.url, title: active.title } : null), active: previewShown === projectId, held: (project.visualComments ?? []).some((comment) => comment.status === 'held') }
  })
  const topBarPreviews = { previewPills, onOpenPreviewPill: showPreview, onClosePreviewPill: closePreview, onOpenPreview: () => { const projectId = activeThreadProject?.id ?? view.engine.projects[0]?.id; if (projectId) openPreview(projectId); else report('Add a project before opening a preview.') } }
  // Annotate on a page: the frame is captured into the evidence store, the live view hides, and the session opens over the stage.
  const annotateDestination = (projectId: string): VisualDestinationView | null => {
    const project = view.engine.projects.find((candidate) => candidate.id === projectId)
    const thread = project?.threads.find((candidate) => candidate.id === view.engine.activeThreadId) ?? project?.threads[0]
    return thread ? { threadId: thread.id, threadTitle: thread.title } : null
  }
  const startAnnotate = (tabId: string, projectId: string) => void perform(async () => {
    if (annotating) { showPreview(annotating.projectId); report('Hold the current annotation before starting another.'); return }
    const destination = annotateDestination(projectId)
    if (!destination) throw new Error('Open a conversation before annotating this page.')
    const result = await window.strata.capturePreviewFrame(tabId)
    setAnnotating({ sessionId: `annotation-${crypto.randomUUID()}`, identity: view.engine.identity ?? null, destination, data: newVisualSession(), tabId, projectId, captures: [result.capture], page: result.page })
  })
  const annotateOverlay = (() => {
    if (!annotating || annotating.projectId !== previewShown) return null
    const destination = annotating.destination
    if (!destination) return null
    const capture = annotating.captures.at(-1)!
    const liveTab = previewTabs.find((tab) => tab.id === annotating.tabId) ?? null
    const pageInput: NonNullable<HoldVisualCommentInput['page']> = { tabId: annotating.tabId, captures: annotating.captures.map((frame) => ({ id: frame.id, width: frame.width, height: frame.height, scroll: frame.scroll ?? { x: 0, y: 0 }, scale: frame.scale ?? 1 })), url: annotating.page.url, title: annotating.page.title, viewport: annotating.page.viewport, preset: annotating.page.preset, deviceScale: annotating.page.deviceScale }
    const changed = !liveTab || liveTab.document !== annotating.page.document || liveTab.url.replace(/#.*$/, '') !== annotating.page.url.replace(/#.*$/, '')
    return <VisualSession key={annotating.sessionId} sessionId={annotating.sessionId} session={annotating.data} setSession={next => setAnnotating(current => current?.sessionId === annotating.sessionId ? { ...current, data: typeof next === 'function' ? next(current.data) : next } : current)} closeRequest={annotationClose} capture={capture} captures={annotating.captures} page={pageInput} projectId={annotating.projectId} destination={destination}
      place={`${annotating.page.title || 'Page'} · ${annotating.page.preset ? annotating.page.preset.toLowerCase() : 'window size'}`}
      describe={changed ? undefined : describeOn(annotating.tabId, capture)}
      onScroll={changed ? undefined : async (delta) => { await window.strata.scrollPreview(annotating.tabId, { by: delta }); const next = await window.strata.capturePreviewFrame(annotating.tabId); setAnnotating((current) => current && current.tabId === annotating.tabId ? { ...current, captures: [...current.captures, next.capture] } : current) }}
      notice={changed ? 'The live page changed while you were marking. Your note and the captured frame are kept; new marks are regions.' : null}
      onAdjust={changed ? undefined : adjustOn(annotating.tabId)} adjustStatus={changed ? 'not shown: the page changed' : 'shown live'}
      onHold={holdVisual} onSend={(id) => sendVisual(id, destination.threadId)} onClose={() => { const tabId = annotating.tabId; if (annotating.identity) localStorage.removeItem(`stratamd.annotation.${annotating.identity}`); setAnnotating(null); void window.strata.clearPreviewOverrides(tabId).catch(() => undefined) }} onError={reportError} />
  })()
  const previewNode = previewShown ? (() => {
    const project = view.engine.projects.find((candidate) => candidate.id === previewShown)
    const tabs = previewTabs.filter((tab) => tab.projectId === previewShown)
    const activeTabId = (tabs.find((tab) => tab.id === activePreviewTabs[previewShown]) ?? tabs.find((tab) => tab.kind === 'owner') ?? tabs[0])?.id ?? null
    const annotate = { active: annotating !== null && annotating.projectId === previewShown, disabled: annotateDestination(previewShown) === null, onToggle: () => { if (annotating) void annotationClose.current?.(); else if (activeTabId) startAnnotate(activeTabId, previewShown) }, overlay: annotateOverlay }
    return <main className="island editor-island preview-island" data-pane="editor" style={{ '--zoom': zoom.editor } as CSSProperties}><AmbientDecor variant="editor" /><PreviewWindow projectId={previewShown} projectTitle={project?.title ?? 'Project'} tabs={tabs} activeTabId={activeTabId} engine={view.engine} annotate={annotate}
      onSelectTab={(id) => setActivePreviewTabs((current) => ({ ...current, [previewShown]: id }))}
      onNewTab={() => void perform(async () => { const id = await window.strata.openPreviewTab({ projectId: previewShown }); setActivePreviewTabs((current) => ({ ...current, [previewShown]: id })) })}
      onCloseTab={(id) => void perform(() => window.strata.closePreviewTab(id))}
      onNavigate={(id, navigation: PreviewNavigation) => void perform(() => window.strata.navigatePreview(id, navigation))}
      onResize={(id, viewport: PreviewViewportRequest) => void perform(() => window.strata.resizePreview(id, viewport))}
      onResume={(id) => void perform(() => window.strata.resumePreviewTab(id), 'The agent may continue. Nothing it was doing is replayed.')} /></main>
  })() : null
  const previewRailNode = previewShown ? <div data-pane="rightRail" style={{ width: panelSizes.rightRailWidth, flex: 'none', minWidth: 0, '--zoom': zoom.rightRail } as CSSProperties}><Boundary region="rightRail"><PreviewRail projectId={previewShown} engine={view.engine} tabs={previewTabs.filter((tab) => tab.projectId === previewShown)} serving={view.preview.serving} visualComments={view.engine.projects.find((candidate) => candidate.id === previewShown)?.visualComments ?? []} visualActions={visualActions} upperReviewHeight={panelSizes.upperReviewHeight} onHeight={(value, commit) => updatePanel('upperReviewHeight', value, commit)} onOpenConversation={(id) => { showCenterConversation(id); void perform(() => window.strata.openConversation(id)) }} onStop={(id) => void perform(() => window.strata.stopConversationTurn(id), 'Stop requested.')} /></Boundary></div> : null
  /** A held comment opens back into the session; anything sent opens its card. */
  const openVisual = (id: string) => { const comment = visualById(id); if (comment?.draft) { setVisualOpen(null); setVisualSession({ kind: 'comment', id }) } else setVisualOpen(id) }
  const runVisual = { visualComments: activeThreadProject?.visualComments ?? [], onOpenVisual: openVisual, onShowVisual: (id: string) => { const comment = visualById(id); if (comment) visualActions.onShowMe?.(comment) }, onMarkUpImage: markUpImage, consumedAttachmentIds: consumedStaged }
  /** Shows a thread in the center and keeps its tab listed until closed. */
  const showCenterConversation = (threadId: string) => {
    setDocumentPicker(null)
    setConversationTabs((current) => current.includes(threadId) ? current : [...current, threadId])
    setConversationCentered(true)
    setPreviewCentered(null)
  }
  const closeConversationTab = (threadId: string) => {
    if (threadId === "__new__") { setDocumentPicker(null); setConversationCentered(false); return }
    setConversationTabs((current) => current.filter((id) => id !== threadId))
    if (centerConversationId === threadId) setConversationCentered(false)
    if (view.engine.activeThreadId === threadId) {
      if (previewShown) setPreviewNavigationTab('projects')
      else selectNavigationTab('projects')
    }
  }
  const openEngineThread = (threadId: string) => void perform(async () => {
    setDocumentPicker(null)
    cancelEngineNavigation()
    const intent = engineNavigationIntent.current
    await window.strata.openConversation(threadId)
    if (engineNavigationIntent.current !== intent) return
    setConversationTabs((current) => current.includes(threadId) ? current : [...current, threadId])
    // Leave one double-click window before navigating so the same title can enter inline rename.
    engineNavigationTimer.current = window.setTimeout(() => {
      engineNavigationTimer.current = null
      if (engineNavigationIntent.current !== intent) return
      if (previewShown) setPreviewNavigationTab('conversation')
      else if (conversationCentered || !document) showCenterConversation(threadId)
      else selectNavigationTab('conversation')
    }, 180)
  })
  const engineThreads = view.engine.projects.flatMap((project) => project.threads)
  const conversationTabViews = conversationTabs.flatMap((id) => { const thread = engineThreads.find((candidate) => candidate.id === id); return thread && thread.lifecycle !== 'settled' ? [{ id, name: thread.title, attention: thread.attention, active: centerConversationId === id }] : [] })
  if (documentPicker) conversationTabViews.push({ id: '__new__', name: 'New thread', attention: 0, active: centerConversationId === '__new__' })
  const topBarConversations = { conversationTabs: conversationTabViews, onOpenConversationTab: (id: string) => void perform(async () => { if (id === '__new__') { if (documentPicker?.path) await window.strata.openDocument(documentPicker.path); setPreviewCentered(null); setConversationCentered(true); return }; await window.strata.openConversation(id); showCenterConversation(id) }), onCloseConversation: closeConversationTab }
  const projectsNode = <ProjectsPanel query={projectQuery} engine={view.engine} onReconnect={reconnectEngine} onOpenThread={openEngineThread} onBeginRename={cancelEngineNavigation} onNewThread={beginNewConversation} onOpenPreview={openPreview} onAddProject={(input) => void perform(() => window.strata.createEngineProject(input), 'Project added.')} onAction={(id, action) => void perform(() => window.strata.actOnEngineThread(id, action))} onUpdate={(id, change) => void perform(() => window.strata.updateEngineThread(id, change))} onCopyThreadId={(id) => void perform(() => window.strata.copyText(id), 'Thread ID copied.')} onOpenEngine={() => setEngineDialog(true)} onOpenAccounts={openAccounts} attachedThreadIds={new Set(document?.attachments.map((attachment) => attachment.agent.id) ?? [])} />
  const conversationItems = document?.items ?? []
  const itemActions = document ? {
    items: conversationItems,
    onReplyItem: (item: import('../shared/contracts').ItemView, text: string) => item.annotationId && void perform(() => window.strata.reply(document.path, item.annotationId!, text)),
    onOpenItem: (item: import('../shared/contracts').ItemView) => { const annotation = item.annotationId ? document.annotations.find((candidate) => candidate.id === item.annotationId) : null; if (annotation) showThread(annotation) },
    onActItem: (item: import('../shared/contracts').ItemView, action: 'accept' | 'reject' | 'keep' | 'revert') => {
      if (item.annotationId && action === 'accept') void perform(() => window.strata.acceptSuggestion(document.path, item.annotationId!), 'Suggestion accepted.')
      if (item.annotationId && action === 'reject') void perform(() => window.strata.rejectSuggestion(document.path, item.annotationId!), 'Suggestion rejected.')
      const hunk = item.hunkId ? document.pendingHunks.find((candidate) => candidate.id === item.hunkId) : null
      if (hunk && action === 'keep') void perform(() => window.strata.keepHunk(document.path, hunk.id), 'Kept.')
      if (hunk && action === 'revert') revert(hunk)
    },
  } : {}
  const sideConversation = <Conversation visible={previewShown ? previewNavigationTab === 'conversation' : !conversationCentered && document?.reading.navigationTab === 'conversation'} engine={view.engine} passage={!previewShown && thread && document ? threadNode(document, thread) : undefined} placement="side" {...runConversation} {...runVisual} {...(previewShown ? {} : itemActions)} onMove={() => { if (view.engine.activeThreadId) showCenterConversation(view.engine.activeThreadId) }} />
  // The center conversation is the editor pane for zoom: Ctrl+wheel and Ctrl+= over it scale the editor factor, as they do over a document (§6.9).
  const centerConversation = <main className="island editor-island conversation-island" data-pane="editor" style={{ '--zoom': zoom.editor } as CSSProperties}><AmbientDecor variant="editor" />{documentPicker && (documentPicker.path === null || pickerDocument) ? <NewConversation key={`${documentPicker.path ?? "new"}:${documentPicker.projectId ?? "current"}`} engine={view.engine} {...(documentPicker.projectId ? { projectId: documentPicker.projectId } : {})} document={pickerDocument} {...(documentPicker.comment ? { comment: documentPicker.comment } : {})} onProjectChange={(projectId) => setDocumentPicker((current) => current && current.projectId !== projectId ? { ...current, projectId } : current)} onBeforeSend={async () => { if (pickerDocument) await flushBuffer() }} onStarted={showCenterConversation} /> : <Conversation engine={view.engine} placement="center" documentMeasure={panelSizes.documentMeasure} onDocumentMeasure={(value, commit) => updatePanel('documentMeasure', value, commit)} {...runConversation} {...runVisual} {...itemActions} {...(document ? { onMove: () => { setConversationCentered(false); selectNavigationTab('conversation') } } : {})} />}</main>

  const flushBuffer = useCallback(async () => {
    if (mirrorTimer.current !== null) window.clearTimeout(mirrorTimer.current)
    mirrorTimer.current = null
    await flushPendingBuffer()
  }, [])
  const onWindowAction = (action: WindowAction) => void perform(async () => {
    if (action === 'close') await flushBuffer()
    await window.strataWindow[action]()
  })

  const previewPath = document?.path
  const preview = useCallback(async (request: SendPreviewRequest) => {
    if (previewPath === undefined) return []
    await flushBuffer()
    return window.strata.previewSend(previewPath, request)
  }, [flushBuffer, previewPath])

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
    // Drafts belong to open documents; a closed tab's unsent note goes with it (§5.16).
    forgetComposerDrafts(openPaths)
    forgetReplyDrafts(openPaths)
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
    if (document.recipients.length === 0) {
      // Any document can start a thread (§3.10); the picker replaces Send until one is attached (§5.7).
      setDocumentPicker({ path: document.path })
      setConversationCentered(true)
    } else if (document.canSend || document.recipients.some((recipient) => !recipient.attached)) setComposer(true)
    else report('Nothing to send. Make an edit or add an annotation first.')
  }, [document, flushBuffer, report])
  const startThreadWithComment = useCallback((comment: CreateDraftRequest) => {
    if (!document) return
    setDocumentPicker({ path: document.path, comment }); setConversationCentered(true)
  }, [document])

  const addAnnotation = useCallback((kind: Exclude<AnnotationKind, 'decision'>, quote: string, text: string, from: number, to: number, context?: AnnotationContext) => {
    if (!document) return
    void perform(async () => {
      const id = await window.strata.addAnnotation(document.path, { kind, quote, text, from, to, ...(context ? { context } : {}) })
      if (context) {
        const next = await window.strata.getState()
        const created = next.activeDocument?.path === document.path
          ? next.activeDocument.annotations.find((annotation) => annotation.id === id)
          : null
        if (created) showThread(created)
      }
    }, kind === 'suggestion' ? 'Suggestion added for the next Send.' : 'Annotation added on the exact quote.')
  }, [document, perform])

  const addPassageDecision = useCallback((quote: string, prompt: string, options: string[], from: number, to: number) => {
    if (!document) return
    void perform(() => window.strata.addAnnotation(document.path, {
      kind: 'decision', anchor: 'quote', quote, text: prompt, options, from, to,
    }), 'Decision added on the selected passage.')
  }, [document, perform])

  const holdDraft = useCallback((draft: CreateDraftRequest) => {
    if (!document) return
    void perform(() => window.strata.holdDraft(document.path, draft), 'Draft held privately.')
  }, [document, perform])

  const quickSend = useCallback((draft: QuickSendRequest) => {
    if (!document) return
    void perform(async () => {
      await flushBuffer()
      const ids = await window.strata.quickSend(document.path, draft)
      report(`Sent to ${ids.length} agent${ids.length === 1 ? '' : 's'}.`)
    })
  }, [document, flushBuffer, perform, report])

  const addRailDecision = useCallback((prompt: string, options: string[], anchor: 'document' | EditorHeading) => {
    if (!document) return
    void perform(async () => {
      await flushBuffer()
      if (anchor === 'document') {
        await window.strata.addAnnotation(document.path, {
          kind: 'decision', anchor: 'document', quote: '', text: prompt, options, from: 0, to: 0,
        })
        report('Document decision added.')
        return
      }
      const source = editorHandle.current?.headingSource?.(anchor.id)
      if (!source) throw new Error('That heading no longer exists. Choose it again.')
      if (!source.atx) throw new Error('Only # headings can carry a decision.')
      await window.strata.addAnnotation(document.path, {
        kind: 'decision', anchor: 'heading', quote: source.quote, text: prompt, options, from: source.from, to: source.to,
      })
      report('Decision added to the heading.')
    })
  }, [document, flushBuffer, perform, report])

  const dropFiles = useCallback((event: React.DragEvent) => {
    if (!hasFileTransfer(event.dataTransfer, true) || event.dataTransfer.files.length === 0) return
    event.preventDefault()
    setDragging(false)
    const files = Array.from(event.dataTransfer.files).filter((file) => /\.(?:md|markdown)$/iu.test(file.name))
    if (files.length === 0) { report('Drop a .md or .markdown file.'); return }
    const openDroppedFiles = window.strata.openDroppedFiles
    if (!openDroppedFiles) { report('Drag and drop is unavailable in this window.'); return }
    void perform(() => openDroppedFiles(files))
  }, [perform, report])
  const enterFiles = useCallback((event: React.DragEvent) => {
    if (!hasFileTransfer(event.dataTransfer)) return
    event.preventDefault()
    setDragging(true)
  }, [])
  const overFiles = useCallback((event: React.DragEvent) => {
    if (hasFileTransfer(event.dataTransfer)) event.preventDefault()
  }, [])
  const leaveFiles = useCallback((event: React.DragEvent) => {
    if (dragging && event.currentTarget === event.target) setDragging(false)
  }, [dragging])

  const closeTab = useCallback((tab: DocumentTabView) => {
    if (tab.dirty) setClosingTab(tab)
    else void perform(() => window.strata.closeDocument(tab.path))
  }, [perform])

  /** Tab menu bulk close (§5.16): saved tabs close; tabs with unsaved edits stay open and are counted. */
  const closeTabs = useCallback((mode: 'others' | 'all' | 'saved', keepPath: string) => {
    const { close, keptDirty } = tabsToClose(view.tabs, mode, keepPath)
    void perform(async () => {
      for (const tab of close) await window.strata.closeDocument(tab.path)
    }, keptDirty > 0 ? `${close.length} tab${close.length === 1 ? '' : 's'} closed. ${keptDirty} with unsaved edits stayed open.` : close.length > 0 ? `${close.length} tab${close.length === 1 ? '' : 's'} closed.` : undefined)
  }, [perform, view.tabs])

  // Explorer file operations (§5.10). Each is a renderer-only bridge; an older main without it says so.
  const bridgeMissing = useCallback(() => report('This action needs a restarted StrataMD to pick up the new build.'), [report])
  const newFile = useCallback((directory: string) => {
    const create = window.strata.createFile
    if (!create) { bridgeMissing(); return }
    void perform(async () => {
      const path = await create(directory)
      report(`Created ${path.split('/').pop() ?? path}.`)
    })
  }, [bridgeMissing, perform, report])
  const newFileHere = useCallback(() => {
    const directory = document ? document.path.slice(0, document.path.lastIndexOf('/')) || '/' : null
    if (!directory) { report('Open a document first. Ctrl+N then makes a new file beside it.'); return }
    newFile(directory)
  }, [document, newFile, report])
  const openFile = useCallback(() => {
    const dialog = window.strata.openFileDialog
    if (!dialog) { bridgeMissing(); return }
    void perform(dialog)
  }, [bridgeMissing, perform])
  const confirmFileDialog = useCallback((name?: string) => {
    const dialog = fileDialog
    setFileDialog(null)
    if (!dialog) return
    const create = window.strata.createFile
    if (!create) { bridgeMissing(); return }
    void perform(async () => { const path = await create(dialog.directory, name); report(`Created ${path.split('/').pop() ?? path}.`) })
  }, [bridgeMissing, fileDialog, perform, report])

  const jumpTo = useCallback((target: ReviewTarget) => {
    if (target.kind === 'hunk' || target.kind === 'suggestion') selectReviewTab('changes')
    else selectReviewTab('annotations')
    if (target.kind === 'hunk') { setJumpHunkId(null); window.requestAnimationFrame(() => setJumpHunkId(target.id)) }
    else { setJumpAnnotationId(null); window.requestAnimationFrame(() => setJumpAnnotationId(target.id)) }
  }, [selectReviewTab])
  showTarget.current = (target) => { reviewCursor.current = target.id; jumpTo(target) }

  /** F7 / Shift+F7: the next pending change or open suggestion in document order (PRD §6.1). */
  const stepReview = useCallback((direction: 1 | -1) => {
    if (!document) return
    const target = nextReviewTarget(reviewTargets(document), reviewCursor.current, direction)
    if (!target) { report('No changes waiting for review.'); return }
    reviewCursor.current = target.id
    jumpTo(target)
  }, [document, jumpTo, report])

  /** F8 / Shift+F8: the next open comment or question, opening its thread (§5.12). */
  const stepThread = useCallback((direction: 1 | -1) => {
    if (!document) return
    const target = nextReviewTarget(threadTargets(document), threadCursor.current, direction)
    if (!target) { report('No open comments or questions.'); return }
    threadCursor.current = target.id
    const annotation = document.annotations.find((item) => item.id === target.id) ?? null
    rememberThreadOpener()
    selectReviewTab('annotations')
    setJumpAnnotationId(null)
    window.requestAnimationFrame(() => { setJumpAnnotationId(target.id); showThread(annotation) })
  }, [document, report, selectReviewTab, showThread])

  useEffect(() => {
    const modalOpen = () => globalThis.document.querySelector('[aria-modal="true"]') !== null
    const key = (event: KeyboardEvent) => {
      const primary = hasPrimaryModifier(event)
      const lower = event.key.toLowerCase()
      if (primary && event.code === 'Backquote' && !event.altKey && !modalOpen()) { event.preventDefault(); setTerminalOpen(open => !open); return }
      // Keys that work with or without an open document.
      if (event.key === 'F1' && !primary && !event.altKey) {
        event.preventDefault()
        if (!modalOpen()) setShortcutsOpen(true)
        return
      }
      if (lower === 'o' && primary && !event.shiftKey && !event.altKey) {
        if (modalOpen()) return
        event.preventDefault()
        openFile()
        return
      }
      if (lower === 'n' && primary && !event.shiftKey && !event.altKey) {
        if (modalOpen()) return
        event.preventDefault()
        newFileHere()
        return
      }
      if (!document) return
      if (event.key === 'Enter' && primary && !composer) {
        // A form of its own (the annotation composer, a thread reply) submits itself (§5.2).
        if (insideOwnForm(event.target)) return
        event.preventDefault()
        void perform(openComposer)
      } else if (lower === 's' && primary) {
        event.preventDefault()
        void perform(saveDocument, document.pendingHunks.length > 0 ? `Saved. ${document.pendingHunks.length} change${document.pendingHunks.length === 1 ? '' : 's'} still waiting for review.` : 'Saved.')
      } else if (event.key === '/' && primary) {
        // The editor handles its own shortcut and reports the view it switched
        // to; toggling again here from a copy of the mode that is still in
        // flight would flip it straight back.
        if (event.target instanceof Element && event.target.closest('.prosemirror-host')) return
        event.preventDefault()
        const current = latestDocument.current ?? document
        if (current.sourceOnly) report('This document can only open in source view.')
        else void perform(() => window.strata.setSourceMode(current.path, !current.sourceMode))
      } else if (lower === 'w' && primary && !event.shiftKey && !event.altKey) {
        // Closes the active tab through the same confirmation a click gets (PRD §6.9).
        if (modalOpen()) return
        event.preventDefault()
        const active = latestTabs.current.find((tab) => tab.active)
        if (active) closeTab(active)
      } else if ((event.key === 'Tab' && event.ctrlKey && !event.altKey && !event.metaKey) || ((event.key === 'PageDown' || event.key === 'PageUp') && primary && !event.altKey)) {
        if (modalOpen()) return
        event.preventDefault()
        const backwards = event.key === 'PageUp' || (event.key === 'Tab' && event.shiftKey)
        const next = cycleTab(latestTabs.current, backwards ? -1 : 1)
        if (next) void perform(() => window.strata.openDocument(next.path))
      } else if (event.key === 'F7' && !primary && !event.altKey) {
        if (modalOpen()) return
        event.preventDefault()
        stepReview(event.shiftKey ? -1 : 1)
      } else if (event.key === 'F8' && !primary && !event.altKey) {
        if (modalOpen()) return
        event.preventDefault()
        stepThread(event.shiftKey ? -1 : 1)
      }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [closeTab, composer, document, newFileHere, openComposer, openFile, perform, report, saveDocument, stepReview, stepThread])

  const terminalProject = view.engine.projects.find(project => project.threads.some(thread => thread.id === centerConversationId)) ?? (document ? projectForPath(view.engine, document.path) : null) ?? view.engine.projects[0]
  const terminalThread = terminalProject?.threads.find(thread => thread.id === centerConversationId)
  const linkEngine = useRef(view.engine.identity)
  useLayoutEffect(() => { linkEngine.current = view.engine.identity }, [view.engine.identity])
  const webLinks = useWebLinkPicker({
    scope: view.engine.identity ?? null,
    projectFor: origin => {
      const documentProject = document ? projectForPath(view.engine, document.path)?.id : null
      if (origin?.closest('.terminal-drawer')) return terminalProject?.id ?? null
      if (origin?.closest('.thread-panel') && documentProject) return documentProject
      if (origin?.closest('.conversation-panel, .conversation-discussion')) return activeThreadProject?.id ?? null
      return documentProject ?? activeThreadProject?.id ?? view.engine.projects[0]?.id ?? null
    },
    openInternal: async (url, projectId) => {
      const identity = view.engine.identity
      const id = await window.strata.openPreviewTab({ projectId, url })
      if (linkEngine.current !== identity) return
      setActivePreviewTabs(current => ({ ...current, [projectId]: id }))
      showPreview(projectId)
      if (activeThreadProject?.id === projectId) setPreviewNavigationTab('conversation')
    },
    onError: report,
  })
  const linkMenu = useLinkContextMenu({
    documentFor: origin => {
      if (origin.closest('.conversation-panel, .conversation-discussion')) return activeThreadProject?.workspaceRoot ? `${activeThreadProject.workspaceRoot}/.conversation.md` : ''
      return document?.path ?? ''
    },
    onCopy: (text, notice) => void perform(() => window.strata.copyText(text), notice),
  })
  const terminalNode = terminalOpen ? <TerminalDrawer target={terminalProject ? { threadId: terminalThread?.id ?? `strata-project-${terminalProject.id}`, terminalId: 'term-1' } : null} cwd={terminalThread?.worktreePath ?? terminalProject?.workspaceRoot ?? ''} engineState={view.engine.state} themeKey={view.settings.theme} onOpenLink={(url, event) => webLinks.activate(url, event, terminalProject?.id ?? null)} onClose={() => setTerminalOpen(false)} /> : null
  const fileDialogs = (
    <>
      {fileDialog?.kind === 'new' && <FileNameDialog title="New file" action="Create" initial="untitled.md" onCancel={() => setFileDialog(null)} onConfirm={confirmFileDialog} />}
      {shortcutsOpen && <ShortcutSheet onClose={() => setShortcutsOpen(false)} />}
    </>
  )
  if (!ready) return <div className="boot-screen"><StrataIcon /><span>Opening StrataMD…</span></div>
  if (!document) return (
    <AmbientContext.Provider value={ambientStyles(view.settings.theme)}><div className="app-shell empty-shell" data-new-conversation={Boolean(documentPicker && conversationCentered)} style={rendererThemeStyle(view.settings.theme)} data-theme-highlight={themeHighlight ?? undefined} data-transcript-style={view.settings.theme.active.values['surfaces.transcript-style'] ?? 'panel'} data-transcript-shadow={view.settings.theme.active.values['surfaces.transcript-shadow-style'] ?? 'none'} data-motion={view.settings.animatedBackground} data-ambient-background={ambientStyles(view.settings.theme).background} data-ambient-windows={ambientStyles(view.settings.theme).windows} data-dragging={dragging} onDragEnter={enterFiles} onDragOver={overFiles} onDragLeave={leaveFiles} onDrop={dropFiles}>
      <AmbientBackground /><TopBar windowState={windowState} onWindowAction={onWindowAction} tabs={view.tabs} canSend={false} hasAgents={false} pending={0} pendingUnsaved={false} onOpenTab={(path) => { setConversationCentered(false); setPreviewCentered(null); void perform(() => window.strata.openDocument(path)) }} onCloseTab={setClosingTab} onCopyPath={(path) => void perform(() => window.strata.copyText(path), 'Path copied.')} onCloseOthers={(path) => closeTabs('others', path)} onCloseAll={() => closeTabs('all', '')} onCloseSaved={() => closeTabs('saved', '')} onOpenFile={openFile} onSend={() => undefined} zoomed={isZoomed(zoom)} onResetZoom={resetZoom} onOpenTheme={openTheme} engine={view.engine} onOpenEngine={() => setEngineDialog(true)} onOpenSettings={openSettings} onOpenAccounts={openAccounts} onToggleTerminal={() => setTerminalOpen(open => !open)} onOpenUsage={openUsage} {...topBarConversations} {...topBarPreviews} />
      <div className="workspace">
        <div data-pane="explorer" style={{ width: leftWidth, flex: 'none', '--zoom': zoom.explorer } as CSSProperties}><Boundary region="explorer"><NavigationRail projectQuery={projectQuery} onProjectQueryChange={setProjectQuery} selected={previewShown ? previewNavigationTab : 'projects'} documentOpen={false} previewOpen={Boolean(previewShown)} projects={projectsNode} conversation={sideConversation} contents={null} conversationCount={activeEngineThread?.attention ?? 0} onSelect={selectLeftTab} /></Boundary></div>
        <Resizer axis="vertical" label="Resize left window" value={leftWidth} min={leftMin} max={leftMax} onChange={(value) => resizeLeft(value, false)} onCommit={(value) => resizeLeft(value, true)} />
        <div className="center-column">{previewNode ? <Boundary region="editor">{previewNode}</Boundary> : <main className="island editor-island empty-editor-island" data-pane="editor" style={{ '--zoom': zoom.editor } as CSSProperties}>
          <Boundary region="editor">{conversationCentered ? centerConversation : <div className="empty-welcome"><StrataIcon /><h1>Open a markdown file</h1><p>Open a file from disk, or drop one here.</p><button type="button" className="keep-button large" onClick={openFile}>Open file</button></div>}</Boundary>
        </main>}{terminalNode}</div>
        {previewShown && <Resizer axis="vertical" label="Resize right rail" expanded={!rightRailCollapsed} onToggle={() => setRightRailCollapsed((collapsed) => !collapsed)} value={panelSizes.rightRailWidth} min={PANEL_LIMITS.rightRailWidth[0]} max={rightMax} invert onChange={(value) => updatePanel('rightRailWidth', value, false)} onCommit={(value) => updatePanel('rightRailWidth', value, true)} />}
        {previewShown && !rightRailCollapsed && previewRailNode}
      </div>
      {dragging && <div className="drop-overlay">Drop markdown files to open</div>}
      {settingsDialogNode}
      {engineDialogNode}
      {accountsDialogNode}
      {usageDialogNode}
      {themePanel}
      {webLinks.picker}
      {linkMenu.menu}
      {fileDialogs}
      {visualPanelNode}
      {visualSessionNode}
      <Toast toast={toast} onDone={dismissToast} />
    </div></AmbientContext.Provider>
  )

  const save = () => void perform(saveDocument, document.pendingHunks.length > 0 ? `Saved. ${document.pendingHunks.length} change${document.pendingHunks.length === 1 ? '' : 's'} still waiting for review.` : 'Saved.')
  const revert = (hunk: HunkView) => hunk.status === 'mixed' ? setMixedHunk(hunk) : void perform(() => window.strata.revertHunk(document.path, hunk.id), `Change by ${hunk.author?.name ?? 'someone else'} reverted. Agents see the revert as your change.`)
  const detach = (attachment: AttachmentView) => void perform(
    () => window.strata.detachThread(document.path, attachment.agent.id),
    `${attachment.agent.name} detached.`,
  ).then(() => setDetaching(null))

  return (
    <AmbientContext.Provider value={ambientStyles(view.settings.theme)}><div className="app-shell" data-new-conversation={Boolean(documentPicker && conversationCentered)} style={rendererThemeStyle(view.settings.theme)} data-theme-highlight={themeHighlight ?? undefined} data-transcript-style={view.settings.theme.active.values['surfaces.transcript-style'] ?? 'panel'} data-transcript-shadow={view.settings.theme.active.values['surfaces.transcript-shadow-style'] ?? 'none'} data-motion={view.settings.animatedBackground} data-ambient-background={ambientStyles(view.settings.theme).background} data-ambient-windows={ambientStyles(view.settings.theme).windows} data-dragging={dragging} onDragEnter={enterFiles} onDragOver={overFiles} onDragLeave={leaveFiles} onDrop={dropFiles}>
      <AmbientBackground />
      <TopBar windowState={windowState} onWindowAction={onWindowAction} tabs={view.tabs} canSend={document.canSend || document.recipients.some((recipient) => !recipient.attached)} hasAgents={document.recipients.length > 0} pending={pendingCount(document)} pendingUnsaved={hasUnsavedCounted(document)} onOpenTab={(path) => { setConversationCentered(false); setPreviewCentered(null); void perform(() => window.strata.openDocument(path)) }} onCloseTab={closeTab} onCopyPath={(path) => void perform(() => window.strata.copyText(path), 'Path copied.')} onCloseOthers={(path) => closeTabs('others', path)} onCloseAll={() => closeTabs('all', '')} onCloseSaved={() => closeTabs('saved', '')} onOpenFile={openFile} onSend={() => void perform(openComposer)} zoomed={isZoomed(zoom)} onResetZoom={resetZoom} onOpenTheme={openTheme} engine={view.engine} onOpenEngine={() => setEngineDialog(true)} onOpenSettings={openSettings} onOpenAccounts={openAccounts} onToggleTerminal={() => setTerminalOpen(open => !open)} onOpenUsage={openUsage} onStartThread={() => void perform(openComposer)} {...topBarConversations} {...topBarPreviews} />
      <div className="workspace">
        <div data-pane="explorer" style={{ width: leftWidth, flex: 'none', '--zoom': zoom.explorer } as CSSProperties}><Boundary region="explorer"><NavigationRail projectQuery={projectQuery} onProjectQueryChange={setProjectQuery} selected={previewShown ? previewNavigationTab : conversationCentered ? 'projects' : document.reading.navigationTab} documentOpen={!conversationCentered && !previewShown} previewOpen={Boolean(previewShown)} projects={projectsNode} conversation={sideConversation} contents={conversationCentered ? null : <Contents headings={headings} drafts={document.drafts} activeId={activeHeadingId} walkthrough={document.reading.walkthrough} content={document.content} onJump={(id) => setJumpHeading({ id, token: Date.now() })} onWalkthrough={updateWalkthrough} />} conversationCount={activeEngineThread?.attention ?? 0} onSelect={selectLeftTab} /></Boundary></div>
        <Resizer axis="vertical" label="Resize left window" value={leftWidth} min={leftMin} max={leftMax} onChange={(value) => resizeLeft(value, false)} onCommit={(value) => resizeLeft(value, true)} />
        <div className="center-column"><Boundary region="editor">{previewNode ?? (conversationCentered ? centerConversation : <EditorPane editorRef={editorHandle} document={document} walkthrough={document.reading.walkthrough} headings={headings} onWalkthrough={updateWalkthrough} onJumpHeading={(id) => setJumpHeading({ id, token: Date.now() })} documentMeasure={panelSizes.documentMeasure} zoom={zoom.editor} composerSize={panelSizes.annotationComposer} createEditor={createEditor} onDocumentMeasure={(value, commit) => updatePanel('documentMeasure', value, commit)} onComposerSize={(size, commit) => updatePanelSize('annotationComposer', size, commit)} onBufferChange={bufferChanged} onToggleSource={(source) => void perform(() => window.strata.setSourceMode(document.path, source))} onSave={save} onUndo={undoApplication} onRedo={redoApplication} onKeepHunk={(id) => void perform(() => window.strata.keepHunk(document.path, id), 'Kept.')} onRevertHunk={revert} onTableView={(state: TableViewState) => void perform(() => window.strata.updateTableView(document.path, state))} onAddAnnotation={addAnnotation} onAddDecision={addPassageDecision} onHoldDraft={holdDraft} onQuickSend={quickSend} onStartThread={startThreadWithComment} activeConversationId={view.engine.activeThreadId} onAdjustAnnotation={(id, quote, from, to) => void perform(() => window.strata.requoteAnnotation(document.path, id, { quote, from, to }), 'Annotation moved to the new quote. Agents receive it on the next Send.')} onAccept={(id) => void perform(() => window.strata.acceptSuggestion(document.path, id), 'Suggestion accepted as your change.')} onReject={(id) => void perform(() => window.strata.rejectSuggestion(document.path, id), 'Suggestion rejected.')} selectedAnnotation={selectedAnnotation} onSelectAnnotation={(annotation) => { threadOpener.current = null; showThread(annotation) }} jumpHunkId={jumpHunkId} jumpAnnotationId={jumpAnnotationId} jumpHeading={jumpHeading} onHeadings={(next, activeId, durationMs) => { setHeadingState({ path: document.path, headings: next, activeId }); globalThis.document.documentElement.dataset.headingIndexMs = durationMs.toFixed(3) }} />)}</Boundary>{terminalNode}</div>
        {rightRailVisible && <Resizer axis="vertical" label="Resize right rail" expanded={!rightRailCollapsed} onToggle={() => setRightRailCollapsed((collapsed) => !collapsed)} value={panelSizes.rightRailWidth} min={PANEL_LIMITS.rightRailWidth[0]} max={rightMax} invert onChange={(value) => updatePanel('rightRailWidth', value, false)} onCommit={(value) => updatePanel('rightRailWidth', value, true)} />}
        {rightRailVisible && !rightRailCollapsed && (previewRailNode ?? <div data-pane="rightRail" style={{ width: panelSizes.rightRailWidth, flex: 'none', minWidth: 0, '--zoom': zoom.rightRail } as CSSProperties}><Boundary region="rightRail"><RightRail document={document} headings={headings} onAddDecision={addRailDecision} selectedTab={document.reading.reviewTab} upperReviewHeight={panelSizes.upperReviewHeight} onSelectTab={selectReviewTab} onHeight={(value, commit) => updatePanel('upperReviewHeight', value, commit)} onMarkReviewed={() => void perform(() => window.strata.markReviewed(document.path), 'All changes marked reviewed. Suggestions still need Accept or Reject.')} onJumpHunk={(hunk) => { setJumpHunkId(null); window.requestAnimationFrame(() => setJumpHunkId(hunk.id)) }} onKeepHunk={(id) => void perform(() => window.strata.keepHunk(document.path, id), 'Kept.')} onRevertHunk={revert} onAcceptAllSuggestions={(agentId) => void perform(async () => { const result = await window.strata.acceptAllSuggestions(document.path, agentId); report(`${result.accepted.length} suggestion${result.accepted.length === 1 ? '' : 's'} accepted${result.skipped.length > 0 ? `; ${result.skipped.length} overlapping skipped` : ''}.`) })} onRejectAllSuggestions={(agentId) => void perform(async () => { const rejected = await window.strata.rejectAllSuggestions(document.path, agentId); report(`${rejected.length} suggestion${rejected.length === 1 ? '' : 's'} rejected.`) })} onAcceptSuggestion={(id) => void perform(() => window.strata.acceptSuggestion(document.path, id), 'Suggestion accepted as your change.')} onRejectSuggestion={(id) => void perform(() => window.strata.rejectSuggestion(document.path, id), 'Suggestion rejected.')} onRevertAll={setRevertAll} onKeepAll={(group) => void perform(async () => { for (const hunk of group.hunks) await window.strata.keepHunk(document.path, hunk.id) }, `${group.hunks.length} changes by ${group.name} kept.`)} onJumpAnnotation={(annotation) => { rememberThreadOpener(); if (annotation.status === 'orphaned' || annotation.anchor === 'document') { setJumpAnnotationId(null); showThread(annotation); return } setJumpAnnotationId(null); window.requestAnimationFrame(() => { setJumpAnnotationId(annotation.id); showThread(annotation) }) }} onClearResolved={() => void perform(() => window.strata.clearResolvedAnnotations(document.path), 'Resolved annotations cleared.')} onStop={(id) => void perform(() => window.strata.stopConversationTurn(id), 'Turn stopped.')} onOpenConversation={(id) => { showCenterConversation(id); void perform(() => window.strata.openConversation(id)) }} onSetLead={(agentId) => void perform(() => window.strata.setLead(document.path, agentId))} onDetach={(attachment) => { if (attachment.queuedSendCount > 0) setDetaching(attachment); else detach(attachment) }} onSaveRound={(index) => window.strata.saveRound(document.path, index)} visualComments={projectForPath(view.engine, document.path)?.visualComments ?? []} visualActions={visualActions} serving={view.preview.serving} /></Boundary></div>)}
      </div>
      {confirmResolve && document && thread && (
        // Above every island: inside the left window the editor would paint over it.
        <ResolveSuggestionDialog
          onCancel={() => setConfirmResolve(false)}
          onConfirm={() => { setConfirmResolve(false); resolveThread(document, thread) }}
        />
      )}
      {composer && <SendComposer threads={engineThreads} recipients={document.recipients} drafts={document.drafts} leadAgentId={document.leadAgentId} activeConversationId={view.engine.activeThreadId} documentPath={document.path} size={panelSizes.sendComposer} zoom={zoom.composer} onSize={(value, commit) => updatePanelSize('sendComposer', value, commit)} onCancel={() => setComposer(false)} onPreview={preview} onDiscardDraft={(id) => void perform(() => window.strata.discardDraft(document.path, id), 'Draft discarded.')} onSend={async (request) => { await flushBuffer(); const ids = await window.strata.send(document.path, request); setComposer(false); report(`Sent to ${ids.length} agent${ids.length === 1 ? '' : 's'}.`) }} />}
      {revertAll && <RevertAllDialog name={revertAll.name} hunks={revertAll.hunks} onCancel={() => setRevertAll(null)} onConfirm={() => {
        // Bottom-up, one revert per hunk: each is its own application step, so each is its own undo.
        const hunks = [...revertAll.hunks].sort((left, right) => right.newStart - left.newStart)
        setRevertAll(null)
        void perform(async () => { for (const hunk of hunks) await window.strata.revertHunk(document.path, hunk.id, true) }, `${hunks.length} changes by ${revertAll.name} reverted. Agents see the reverts as your changes.`)
      }} />}
      {mixedHunk && <MixedRevertDialog hunk={mixedHunk} onCancel={() => setMixedHunk(null)} onConfirm={() => void perform(() => window.strata.revertHunk(document.path, mixedHunk.id, true), 'Reverted. Your edits inside it were discarded.').then(() => setMixedHunk(null))} />}
      {detaching && <DetachDialog attachment={detaching} onCancel={() => setDetaching(null)} onConfirm={() => detach(detaching)} />}
      {document.recovery && <RecoveryDialog fileName={document.path.split('/').pop() ?? document.path} onChoose={(choice) => void perform(() => window.strata.resolveRecovery(document.path, choice), choice === 'recover' ? 'Recovered the buffer.' : 'Discarded the buffer and restored the disk copy.')} />}
      {document.conflicts[0] && <ConflictDialog conflict={document.conflicts[0]} fileName={document.path.split('/').pop() ?? document.path} onChoose={(choice) => void perform(() => window.strata.resolveConflict(document.path, document.conflicts[0]!.id, choice), choice === 'mine' ? 'Kept your block.' : 'Incoming block applied for review.')} />}
      {closingTab && <CloseTabDialog tab={closingTab} onChoose={(choice) => { if (choice === 'cancel') { setClosingTab(null); return } void perform(() => window.strata.closeDocument(closingTab.path, choice)).then(() => setClosingTab(null)) }} />}
      {settingsDialogNode}
      {engineDialogNode}
      {accountsDialogNode}
      {usageDialogNode}
      {themePanel}
      {webLinks.picker}
      {linkMenu.menu}
      {fileDialogs}
      {visualPanelNode}
      {visualSessionNode}
      <Toast toast={toast} onDone={dismissToast} />
      {dragging && <div className="drop-overlay">Drop markdown files to open</div>}
    </div></AmbientContext.Provider>
  )
}
