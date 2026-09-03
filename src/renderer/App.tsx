import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import type { AnnotationContext, AnnotationKind, AnnotationView, AppView, AttachmentView, BufferOrigin, DocumentTabView, HunkView, NavigationTab, PaneId, PanelSize, PaneZoom, PanelSizes, RedoResult, ReviewTab, SendPreviewRequest, TableViewState, ThemePanelGeometry, UndoResult, WalkthroughAction } from '../shared/contracts'
import type { EditorHeading } from '../editor/headings'
import type { RendererEditorFactory, RendererEditorHandle } from './editorAdapter'
import { Explorer } from './components/Explorer'
import { AmbientBackground, AmbientContext } from './components/AmbientDecor'
import { Boundary } from './components/Boundary'
import { ThemePanel } from './components/ThemePanel'
import { EditorPane, forgetClosedScroll } from './components/EditorPane'
import { forgetClosedEditors } from './components/EditorMount'
import { FileNameDialog, TrashFileDialog } from './components/FileDialogs'
import { StrataIcon } from './components/Logo'
import { CloseTabDialog, ConflictDialog, DisconnectDialog, MixedRevertDialog, RecoveryDialog, RevertAllDialog } from './components/Overlays'
import { Resizer } from './components/Resizer'
import { RightRail } from './components/RightRail'
import { forgetComposerDrafts, SendComposer } from './components/SendComposer'
import { ShortcutSheet } from './components/ShortcutSheet'
import { forgetReplyDrafts } from './components/ThreadPanel'
import { Toast } from './components/Toast'
import { TopBar } from './components/TopBar'
import { NavigationRail } from './components/NavigationRail'
import { activitySnapshot, agentActivity, agentActivityMessage, AGENT_PROMPT, ambientStyles, clampPanelSize, clampThemePanel, cycleTab, EMPTY_VIEW, hasUnsavedCounted, isZoomed, nextReviewTarget, pendingCount, rendererThemeStyle, reviewTargets, shouldAdoptPushed, stepZoom, tabsToClose, threadTargets, type ActivitySnapshot, type NumericPanelKey, type ReviewTarget } from './model'
import { flushPendingBuffer, peekPendingBuffer, setPendingBuffer } from './pendingBuffer'
import { nextToast, type ToastAction, type ToastState } from './toasts'
import { hasPrimaryModifier } from '../shared/primary-modifier'

/** Ctrl+Enter inside the annotation composer or a thread reply belongs to that form (§5.2). */
function insideOwnForm(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('.annotation-composer, .thread-panel, .editor-popover') !== null
}

type FileDialogState =
  | { kind: 'new'; directory: string }
  | { kind: 'rename'; path: string }
  | { kind: 'trash'; path: string }

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
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [fileDialog, setFileDialog] = useState<FileDialogState | null>(null)
  const [headingState, setHeadingState] = useState<{ path: string; headings: readonly EditorHeading[]; activeId: string | null }>({ path: '', headings: [], activeId: null })
  const [jumpHeading, setJumpHeading] = useState<{ id: string; token: number } | null>(null)
  const editorHandle = useRef<RendererEditorHandle | null>(null)
  const zoomRef = useRef<PaneZoom>(EMPTY_VIEW.settings.zoom)
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
  const selectNavigationTab = useCallback((tab: NavigationTab) => {
    if (!document) return
    void perform(() => window.strata.updateReadingState(document.path, { navigationTab: tab }))
  }, [document, perform])
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
    const adopt = (next: AppView) => {
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

  const updatePanelSize = useCallback((key: 'threadPanel' | 'annotationComposer' | 'sendComposer', value: PanelSize, commit: boolean) => {
    setPanelSizes((sizes) => ({ ...sizes, [key]: value }))
    if (commit) commitPanels({ ...panelSizes, [key]: value })
  }, [commitPanels, panelSizes])

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
    if (document.attachments.length === 0) {
      await window.strata.copyForAgent(document.path, '', false)
      report('Copied for your agent')
    } else if (document.canSend) setComposer(true)
    else report('Nothing to send. Make an edit or add an annotation first.')
  }, [document, flushBuffer, report])

  const addAnnotation = useCallback((kind: Exclude<AnnotationKind, 'decision'>, quote: string, text: string, from: number, to: number, context?: AnnotationContext) => {
    if (!document) return
    void perform(async () => {
      const id = await window.strata.addAnnotation(document.path, { kind, quote, text, from, to, ...(context ? { context } : {}) })
      if (context) {
        const next = await window.strata.getState()
        const created = next.activeDocument?.path === document.path
          ? next.activeDocument.annotations.find((annotation) => annotation.id === id)
          : null
        if (created) setSelectedAnnotation(created)
      }
    }, kind === 'suggestion' ? 'Suggestion added for the next Send.' : 'Annotation added on the exact quote.')
  }, [document, perform])

  const addPassageDecision = useCallback((quote: string, prompt: string, options: string[], from: number, to: number) => {
    if (!document) return
    void perform(() => window.strata.addAnnotation(document.path, {
      kind: 'decision', anchor: 'quote', quote, text: prompt, options, from, to,
    }), 'Decision added on the selected passage.')
  }, [document, perform])

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
    const directory = document ? document.path.slice(0, document.path.lastIndexOf('/')) || '/' : view.explorer[0]?.path
    if (!directory) { report('Add a folder first, then make a new file in it.'); return }
    newFile(directory)
  }, [document, newFile, report, view.explorer])
  const openFile = useCallback(() => {
    const dialog = window.strata.openFileDialog
    if (!dialog) { bridgeMissing(); return }
    void perform(dialog)
  }, [bridgeMissing, perform])
  const revealFile = useCallback((path: string) => {
    const reveal = window.strata.revealFile
    if (!reveal) { bridgeMissing(); return }
    void perform(() => reveal(path))
  }, [bridgeMissing, perform])
  const confirmFileDialog = useCallback((name?: string) => {
    const dialog = fileDialog
    setFileDialog(null)
    if (!dialog) return
    if (dialog.kind === 'new') {
      const create = window.strata.createFile
      if (!create) { bridgeMissing(); return }
      void perform(async () => { const path = await create(dialog.directory, name); report(`Created ${path.split('/').pop() ?? path}.`) })
    } else if (dialog.kind === 'rename') {
      const renameFile = window.strata.renameFile
      if (!renameFile || !name) { if (!renameFile) bridgeMissing(); return }
      void perform(async () => { const path = await renameFile(dialog.path, name); report(`Renamed to ${path.split('/').pop() ?? path}.`) })
    } else {
      const trash = window.strata.trashFile
      if (!trash) { bridgeMissing(); return }
      void perform(() => trash(dialog.path), `${dialog.path.split('/').pop() ?? 'File'} moved to the trash.`)
    }
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
    window.requestAnimationFrame(() => { setJumpAnnotationId(target.id); setSelectedAnnotation(annotation) })
  }, [document, report, selectReviewTab])

  useEffect(() => {
    const modalOpen = () => globalThis.document.querySelector('[aria-modal="true"]') !== null
    const key = (event: KeyboardEvent) => {
      const primary = hasPrimaryModifier(event)
      const lower = event.key.toLowerCase()
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
      } else if (event.key === 'F8' && !primary && !event.altKey) {
        if (modalOpen()) return
        event.preventDefault()
        stepThread(event.shiftKey ? -1 : 1)
      }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [closeTab, composer, document, newFileHere, openComposer, openFile, perform, report, saveDocument, stepReview, stepThread, view.tabs])

  const fileDialogs = (
    <>
      {fileDialog?.kind === 'new' && <FileNameDialog title="New file" action="Create" initial="untitled.md" onCancel={() => setFileDialog(null)} onConfirm={confirmFileDialog} />}
      {fileDialog?.kind === 'rename' && <FileNameDialog title={`Rename ${fileDialog.path.split('/').pop() ?? ''}`} action="Rename" initial={fileDialog.path.split('/').pop() ?? ''} onCancel={() => setFileDialog(null)} onConfirm={confirmFileDialog} />}
      {fileDialog?.kind === 'trash' && <TrashFileDialog name={fileDialog.path.split('/').pop() ?? fileDialog.path} onCancel={() => setFileDialog(null)} onConfirm={() => confirmFileDialog()} />}
      {shortcutsOpen && <ShortcutSheet onClose={() => setShortcutsOpen(false)} />}
    </>
  )
  const explorerFileActions = {
    onOpenFile: openFile,
    onNewFile: (directory: string) => setFileDialog({ kind: 'new', directory }),
    onRename: (path: string) => setFileDialog({ kind: 'rename', path }),
    onTrash: (path: string) => setFileDialog({ kind: 'trash', path }),
    onReveal: revealFile,
  }
  const explorer = (activePath?: string) => <Explorer embedded folders={view.explorer} {...(activePath === undefined ? {} : { activePath })} scanning={scanning} {...explorerFileActions} onOpen={(path) => void perform(() => window.strata.openDocument(path))} onScan={(path) => { setScanning(true); void perform(() => window.strata.scanFolder(path), 'Folder prepared. Every markdown file in it is remembered.').finally(() => setScanning(false)) }} onRefresh={() => void perform(() => window.strata.refreshExplorer(), 'Explorer refreshed')} onAddFolder={() => void perform(() => window.strata.addFolder())} onForget={(path) => void perform(() => window.strata.forgetDocument(path), 'Document forgotten')} onCopyPath={(path) => void perform(() => window.strata.copyText(path), 'Path copied.')} onRemoveFolder={(path) => void perform(() => window.strata.removeFolder(path), 'Folder removed from the list. Its documents stay remembered.')} />

  if (!ready) return <div className="boot-screen"><StrataIcon /><span>Opening StrataMD…</span></div>
  if (!document) return (
    <AmbientContext.Provider value={ambientStyles(view.settings.theme)}><div className="app-shell empty-shell" style={rendererThemeStyle(view.settings.theme)} data-theme-highlight={themeHighlight ?? undefined} data-motion={view.settings.animatedBackground} data-ambient-background={ambientStyles(view.settings.theme).background} data-ambient-windows={ambientStyles(view.settings.theme).windows} data-dragging={dragging} onDragEnter={(event) => { event.preventDefault(); setDragging(true) }} onDragOver={(event) => event.preventDefault()} onDragLeave={(event) => { if (event.currentTarget === event.target) setDragging(false) }} onDrop={dropFiles}>
      <AmbientBackground /><TopBar tabs={view.tabs} canSend={false} hasAgents={false} pending={0} pendingUnsaved={false} onOpenTab={(path) => void perform(() => window.strata.openDocument(path))} onCloseTab={setClosingTab} onCopyPath={(path) => void perform(() => window.strata.copyText(path), 'Path copied.')} onCloseOthers={(path) => closeTabs('others', path)} onCloseAll={() => closeTabs('all', '')} onCloseSaved={() => closeTabs('saved', '')} onSend={() => undefined} onCopy={() => undefined} zoomed={isZoomed(zoom)} onResetZoom={resetZoom} onOpenTheme={openTheme} />
      <div className="workspace">
        <div data-pane="explorer" style={{ width: panelSizes.explorerWidth, flex: 'none', '--zoom': zoom.explorer } as CSSProperties}><Boundary region="explorer"><NavigationRail selected="files" files={explorer()} headings={[]} activeHeadingId={null} walkthrough={{ active: false, level: 'h2', current: null, excluded: [], markers: [] }} content="" onSelect={() => undefined} onJumpHeading={() => undefined} onWalkthrough={() => undefined} /></Boundary></div>
        <Resizer axis="vertical" label="Resize file explorer" value={panelSizes.explorerWidth} min={160} max={340} onChange={(value) => updatePanel('explorerWidth', value, false)} onCommit={(value) => updatePanel('explorerWidth', value, true)} />
        <main className="island editor-island empty-editor-island" data-pane="editor" style={{ '--zoom': zoom.editor } as CSSProperties}>
          <Boundary region="editor"><div className="empty-welcome"><StrataIcon /><h1>Open a markdown file</h1><p>Choose a folder, then open a document from the explorer.</p><button type="button" className="keep-button large" onClick={() => void perform(() => window.strata.addFolder())}>Add folder</button></div></Boundary>
        </main>
      </div>
      {dragging && <div className="drop-overlay">Drop markdown files to open</div>}
      {themePanel}
      {fileDialogs}
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
      <TopBar tabs={view.tabs} canSend={document.canSend} hasAgents={document.attachments.length > 0} pending={pendingCount(document)} pendingUnsaved={hasUnsavedCounted(document)} onOpenTab={(path) => void perform(() => window.strata.openDocument(path))} onCloseTab={closeTab} onCopyPath={(path) => void perform(() => window.strata.copyText(path), 'Path copied.')} onCloseOthers={(path) => closeTabs('others', path)} onCloseAll={() => closeTabs('all', '')} onCloseSaved={() => closeTabs('saved', '')} onSend={() => void perform(openComposer)} onCopy={() => void perform(openComposer)} zoomed={isZoomed(zoom)} onResetZoom={resetZoom} onOpenTheme={openTheme} />
      <div className="workspace">
        <div data-pane="explorer" style={{ width: panelSizes.explorerWidth, flex: 'none', '--zoom': zoom.explorer } as CSSProperties}><Boundary region="explorer"><NavigationRail selected={document.reading.navigationTab} files={explorer(document.path)} headings={headings} activeHeadingId={activeHeadingId} walkthrough={document.reading.walkthrough} content={document.content} onSelect={selectNavigationTab} onJumpHeading={(id) => setJumpHeading({ id, token: Date.now() })} onWalkthrough={updateWalkthrough} /></Boundary></div>
        <Resizer axis="vertical" label="Resize file explorer" value={panelSizes.explorerWidth} min={160} max={340} onChange={(value) => updatePanel('explorerWidth', value, false)} onCommit={(value) => updatePanel('explorerWidth', value, true)} />
        <Boundary region="editor"><EditorPane editorRef={editorHandle} document={document} walkthrough={document.reading.walkthrough} headings={headings} onWalkthrough={updateWalkthrough} onJumpHeading={(id) => setJumpHeading({ id, token: Date.now() })} documentMeasure={panelSizes.documentMeasure} zoom={zoom.editor} threadPanelSize={panelSizes.threadPanel} composerSize={panelSizes.annotationComposer} createEditor={createEditor} onDocumentMeasure={(value, commit) => updatePanel('documentMeasure', value, commit)} onThreadPanelSize={(size, commit) => updatePanelSize('threadPanel', size, commit)} onComposerSize={(size, commit) => updatePanelSize('annotationComposer', size, commit)} onBufferChange={bufferChanged} onToggleSource={(source) => void perform(() => window.strata.setSourceMode(document.path, source))} onSave={save} onUndo={undoApplication} onRedo={redoApplication} onKeepHunk={(id) => void perform(() => window.strata.keepHunk(document.path, id), 'Kept.')} onRevertHunk={revert} onTableView={(state: TableViewState) => void perform(() => window.strata.updateTableView(document.path, state))} onAddAnnotation={addAnnotation} onAddDecision={addPassageDecision} onAdjustAnnotation={(id, quote, from, to) => void perform(() => window.strata.requoteAnnotation(document.path, id, { quote, from, to }), 'Annotation moved to the new quote. Agents receive it on the next Send.')} onReply={(id, text) => void perform(() => window.strata.reply(document.path, id, text))} onResolve={(id) => void perform(async () => { await window.strata.resolveAnnotation(document.path, id); setSelectedAnnotation(null) }, 'Thread resolved. It stays until cleared.')} onAnswerDecision={(id, answer) => void perform(() => window.strata.answerDecision(document.path, id, answer), 'Decision answered. It is selected in the next Send.')} onReopenDecision={(id) => void perform(() => window.strata.reopenDecision(document.path, id), 'Decision reopened.')} onAccept={(id) => void perform(() => window.strata.acceptSuggestion(document.path, id), 'Suggestion accepted as your change.')} onReject={(id) => void perform(() => window.strata.rejectSuggestion(document.path, id), 'Suggestion rejected.')} selectedAnnotation={selectedAnnotation} onSelectAnnotation={(annotation) => { threadOpener.current = null; setSelectedAnnotation(annotation) }} jumpHunkId={jumpHunkId} jumpAnnotationId={jumpAnnotationId} jumpHeading={jumpHeading} onHeadings={(next, activeId, durationMs) => { setHeadingState({ path: document.path, headings: next, activeId }); globalThis.document.documentElement.dataset.headingIndexMs = durationMs.toFixed(3) }} threadOpener={threadOpener} /></Boundary>
        <Resizer axis="vertical" label="Resize right rail" value={panelSizes.rightRailWidth} min={240} max={440} invert onChange={(value) => updatePanel('rightRailWidth', value, false)} onCommit={(value) => updatePanel('rightRailWidth', value, true)} />
        <div data-pane="rightRail" style={{ width: panelSizes.rightRailWidth, flex: 'none', minWidth: 0, '--zoom': zoom.rightRail } as CSSProperties}><Boundary region="rightRail"><RightRail document={document} headings={headings} onAddDecision={addRailDecision} selectedTab={document.reading.reviewTab} upperReviewHeight={panelSizes.upperReviewHeight} onSelectTab={selectReviewTab} onHeight={(value, commit) => updatePanel('upperReviewHeight', value, commit)} onMarkReviewed={() => void perform(() => window.strata.markReviewed(document.path), 'All changes marked reviewed. Suggestions still need Accept or Reject.')} onJumpHunk={(hunk) => { setJumpHunkId(null); window.requestAnimationFrame(() => setJumpHunkId(hunk.id)) }} onKeepHunk={(id) => void perform(() => window.strata.keepHunk(document.path, id), 'Kept.')} onRevertHunk={revert} onAcceptAllSuggestions={(agentId) => void perform(async () => { const result = await window.strata.acceptAllSuggestions(document.path, agentId); report(`${result.accepted.length} suggestion${result.accepted.length === 1 ? '' : 's'} accepted${result.skipped.length > 0 ? `; ${result.skipped.length} overlapping skipped` : ''}.`) })} onRejectAllSuggestions={(agentId) => void perform(async () => { const rejected = await window.strata.rejectAllSuggestions(document.path, agentId); report(`${rejected.length} suggestion${rejected.length === 1 ? '' : 's'} rejected.`) })} onAcceptSuggestion={(id) => void perform(() => window.strata.acceptSuggestion(document.path, id), 'Suggestion accepted as your change.')} onRejectSuggestion={(id) => void perform(() => window.strata.rejectSuggestion(document.path, id), 'Suggestion rejected.')} onRevertAll={setRevertAll} onKeepAll={(group) => void perform(async () => { for (const hunk of group.hunks) await window.strata.keepHunk(document.path, hunk.id) }, `${group.hunks.length} changes by ${group.name} kept.`)} onCopyAgentPrompt={() => void perform(() => window.strata.copyText(AGENT_PROMPT), 'Prompt copied. Paste it to your agent.')} onJumpAnnotation={(annotation) => { rememberThreadOpener(); if (annotation.status === 'orphaned' || annotation.anchor === 'document') { setJumpAnnotationId(null); setSelectedAnnotation(annotation); return } setJumpAnnotationId(null); window.requestAnimationFrame(() => { setJumpAnnotationId(annotation.id); setSelectedAnnotation(annotation) }) }} onClearResolved={() => void perform(() => window.strata.clearResolvedAnnotations(document.path), 'Resolved annotations cleared.')} onNudge={(id) => void perform(() => window.strata.nudge(document.path, id), 'Reattach prompt copied.')} onSetLead={(agentId) => void perform(() => window.strata.setLead(document.path, agentId))} onDisconnect={(attachment) => { if (attachment.queuedSendCount > 0) setDisconnecting(attachment); else disconnect(attachment) }} onSaveRound={(index) => window.strata.saveRound(document.path, index)} /></Boundary></div>
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
      {fileDialogs}
      <Toast toast={toast} onDone={dismissToast} />
      {dragging && <div className="drop-overlay">Drop markdown files to open</div>}
    </div></AmbientContext.Provider>
  )
}
