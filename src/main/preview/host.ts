import { boundSnapshot } from './snapshot'
import { BrowserRecording } from './recording'
import { BrowserEvidenceStore } from './evidence'
import type { BrowserEvidenceTransfer } from '../../shared/browser-evidence'
import { captureWhenPainted } from './capture'
import { isLocalPage, isLocalPageSync } from '../local-link'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BaseWindow, BrowserWindow, WebContentsView, screen, session, type Rectangle, type Session, type WebContents } from 'electron'
import type { PreviewBoundsReport, PreviewNavigation, PreviewStateView, PreviewTabView, PreviewViewportRequest, PreviewViewportView } from '../../shared/contracts'
import { KNOWN_PRESETS, pageName, resolvePreviewAddress, resolveViewport, viewportSetting } from '../../shared/preview'
import { atomicWriteFile, PRIVATE_FILE_MODE } from '../storage'
import { logError, logWarn } from '../log'
import { guestPermissionDecision, guestWindowDisposition } from './guest-policy'
import { reportPreviewOwnerInput } from './owner-input'
import { withCleanPage } from './clean-capture'
import { PreviewFailure, PreviewTabModel, partitionFor, type PersistedPreviewTab, type PreviewTabRecord } from './tabs'
import { FOCUSED_EDITABLE_SCRIPT, findScript, focusScript, keyEvent, parseLocator, scrollScript, snapshotScript, waitConditionScript, type ParsedLocator } from './scripts'
import { CLEAR_STRATA_SCRIPT, describeScript, locateScript, outlineScript, scrollScript as pageScrollScript, type PageDescription, type PageIdentity, type PageMatch, type PageRect } from './inspect'
import { applyOverridesScript, CLEAR_OVERRIDES_SCRIPT, type OverrideTarget } from './overrides'

/**
 * The preview host (docs/plans/open/visual-review, phase 2): main-process
 * views positioned over a hole in Strata's window. Page instances live
 * independently of what the center shows; the renderer reports where the
 * hole is and whether an overlay is open, and the host draws or hides the
 * shown page accordingly. The same host answers the engine's browser
 * requests, one tab per thread at a time, and pauses an agent tab the moment
 * the owner interacts with it.
 */
export const PREVIEW_OPERATIONS = ['status', 'open', 'navigate', 'snapshot', 'click', 'type', 'press', 'scroll', 'evaluate', 'waitFor', 'resize', 'recordingStart', 'recordingStop'] as const
export type PreviewOperation = typeof PREVIEW_OPERATIONS[number]

export interface PreviewAutomationRequest {
  requestId: string
  threadId: string
  tabId?: string | undefined
  tabIdExplicit?: boolean | undefined
  operation: string
  input: unknown
  timeoutMs: number
}

export type PreviewAutomationOutcome =
  | { ok: true; result: unknown }
  | { ok: false; error: { _tag: string; message: string; detail?: unknown } }

export interface PreviewHostOptions {
  dataDirectory: string
  now?: () => number
  /** The engine's projects and threads, for a tab's working folder and an agent tab's project. */
  ownerActivity?(): void
  resolveProject(projectId: string): { workspaceRoot: string; title: string } | null
  resolveThread(threadId: string): { projectId: string; workingFolder: string } | null
}

interface TabRuntime {
  view: WebContentsView
  /** Serializes agent actions per tab so "queued actions stop" means something. */
  queue: Promise<void>
  /** Bumped when the owner takes control; a running action sees the change and stops. */
  epoch: number
  console: Array<{ level: string; text: string; timestamp: string }>
  actions: Array<{ id: string; action: string; status: 'running' | 'succeeded' | 'failed' | 'interrupted'; startedAt: string; completedAt?: string; error?: string }>
  /** Input Strata itself sent; anything else is the owner. */
  synthetic: number
  /** The device emulation last applied, so a fresh view is never asked to change what it has not drawn. */
  emulation: string
  /** The size the page was last shown at; a hidden page keeps it, so leaving the preview never reflows the page. */
  size: { width: number; height: number } | null
  popups: Set<BrowserWindow>
  ownerRevision: number
}

const DEFAULT_TIMEOUT_MS = 15_000
/** How long Show me outlines a found thing; a capture clears it sooner. */
const OUTLINE_MS = 2_500
/** A device size the comment was made at, found again by its label and size. */
const PRESET_BY_LABEL = (label: string, size: { width: number; height: number }): string | null => KNOWN_PRESETS.find((preset) => preset.label === label && preset.width === size.width && preset.height === size.height)?.id ?? null
const MAX_RESULT_BYTES = 1_000_000
const SNAPSHOT_LIMITS = { text: 20_000, elements: 200, nodes: 400 }

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}

export class PreviewHost {
  readonly #model = new PreviewTabModel()
  readonly #runtimes = new Map<string, TabRuntime>()
  readonly #options: PreviewHostOptions
  readonly #now: () => number
  readonly #listeners = new Set<() => void>()
  readonly #serving = new Map<string, number>()
  readonly #sessions = new Set<Session>()
  readonly #persistPath: string
  readonly #recordings = new Map<string, BrowserRecording>()
  readonly #recordingDestinations = new Map<string, string | null>()
  readonly #finishedRecordings = new Map<string, string>()
  readonly #evidence: BrowserEvidenceStore
  #window: BrowserWindow | null = null
  #parking: BaseWindow | null = null
  #shownTabId: string | null = null
  #bounds: Rectangle | null = null
  #overlay = false
  #hadFocus = false
  #registered = false
  #reveal: { tabId: string; at: number } | null = null
  #persistTimer: ReturnType<typeof setTimeout> | null = null
  #closed = false

  constructor(options: PreviewHostOptions) {
    this.#options = options
    this.#now = options.now ?? Date.now
    this.#persistPath = join(options.dataDirectory, 'preview-tabs.json')
    this.#evidence = new BrowserEvidenceStore(join(options.dataDirectory, 'browser-evidence'), () => this.#publish())
  }

  // ---- State

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  #publish(): void {
    for (const listener of this.#listeners) listener()
  }

  view(): PreviewStateView {
    return {
      tabs: this.#model.list().map(({ workingFolder: _folder, partition: _partition, ...tab }): PreviewTabView => ({ ...tab })),
      evidence: this.#evidence.view(),
      registered: this.#registered,
      serving: [...this.#serving.keys()],
      reveal: this.#reveal,
    }
  }

  setEvidenceTransfer(transfer: BrowserEvidenceTransfer): void { this.#evidence.setTransfer(transfer) }

  async evidenceAction(id: string, action: 'open' | 'retry'): Promise<string | null> {
    if (action === 'retry') { await this.#evidence.transfer(id); return null }
    const { record, bytes } = await this.#evidence.read(id)
    return `data:${record.mimeType};base64,${Buffer.from(bytes).toString('base64')}`
  }

  setRegistered(registered: boolean): void {
    if (this.#registered === registered) return
    this.#registered = registered
    this.#publish()
  }

  get operations(): readonly PreviewOperation[] {
    return PREVIEW_OPERATIONS
  }

  // ---- Windows and layout

  attachWindow(window: BrowserWindow): void {
    this.#window = window
    window.once('closed', () => { if (this.#window === window) { this.#window = null; this.#bounds = null } })
    const layout = () => { if (this.#window === window) this.#layout() }
    window.on('hide', layout)
    window.on('show', layout)
    for (const runtime of this.#runtimes.values()) this.#attachHidden(runtime.view)
    this.#layout()
  }

  /** A separate, non-focusable native window gives never-shown guests a compositor.
   * It sits beyond every display; attaching them outside the main window itself
   * leaves Chromium without a first frame on Electron 44/Linux. */
  #parkingWindow(): BaseWindow {
    if (this.#parking && !this.#parking.isDestroyed()) return this.#parking
    const displays = screen.getAllDisplays()
    const x = Math.min(...displays.map(display => display.bounds.x)) - 4097
    const y = Math.min(...displays.map(display => display.bounds.y)) - 4097
    const parking = new BaseWindow({ x, y, width: 4096, height: 4096, show: false, focusable: false, skipTaskbar: true, frame: false })
    parking.showInactive()
    this.#parking = parking
    return parking
  }

  #attachHidden(view: WebContentsView): void {
    const parking = this.#parkingWindow()
    if (!parking.contentView.children.includes(view)) {
      this.#attachView(parking, view)
      const bounds = view.getBounds()
      view.setBounds({ x: 0, y: 0, width: bounds.width || 1024, height: bounds.height || 768 })
    }
    view.setVisible(true)
  }

  #attachView(window: BaseWindow, view: WebContentsView): void {
    if (window.contentView.children.includes(view)) return
    const contents = view.webContents
    const throttling = contents.getBackgroundThrottling()
    // With background throttling disabled, Chromium skips the hide that releases
    // the old window's compositor. A transferred guest can then capture normally
    // while drawing nothing in its new window (Electron 44/Linux). Let the native
    // view hide before reparenting, then restore background rendering immediately.
    contents.setBackgroundThrottling(true)
    view.setVisible(false)
    try {
      window.contentView.addChildView(view)
      view.setVisible(true)
    } finally {
      contents.setBackgroundThrottling(throttling)
    }
  }

  /** The renderer says where the shown page sits; null hides it. Switching to a document keeps every page alive. */
  reportBounds(report: PreviewBoundsReport): void {
    this.#shownTabId = report.tabId
    this.#bounds = report.bounds ? { x: Math.round(report.bounds.x), y: Math.round(report.bounds.y), width: Math.max(0, Math.round(report.bounds.width)), height: Math.max(0, Math.round(report.bounds.height)) } : null
    this.#layout()
  }

  /** An overlay is open: the page hides beneath it and takes focus back when the overlay closes. */
  setOverlay(open: boolean): void {
    if (this.#overlay === open) return
    const shown = this.#shownTabId ? this.#runtimes.get(this.#shownTabId) : null
    if (open) this.#hadFocus = shown?.view.webContents.isFocused() ?? false
    this.#overlay = open
    this.#layout()
    if (!open && this.#hadFocus && shown && !shown.view.webContents.isDestroyed()) shown.view.webContents.focus()
  }

  #layout(): void {
    const window = this.#window
    if (!window || window.isDestroyed()) return
    for (const [id, runtime] of this.#runtimes) {
      const show = window.isVisible() && id === this.#shownTabId && this.#bounds !== null && !this.#overlay && this.#bounds.width > 0 && this.#bounds.height > 0
      const viewport = this.#model.get(id)?.viewport ?? { mode: 'fill' as const }
      if (show) {
        this.#attachView(window, runtime.view)
        runtime.view.setBounds(this.#bounds!)
        runtime.size = { width: this.#bounds!.width, height: this.#bounds!.height }
        runtime.view.setVisible(true)
        this.#emulate(runtime, viewport, this.#bounds!)
      } else {
        this.#attachHidden(runtime.view)
        runtime.view.setVisible(true)
        // A background page keeps the size it was last shown at, so parking never reflows it;
        // one with a narrowed viewport is drawn at that size, so a capture of it is exact.
        const hidden = runtime.size ?? { width: 1024, height: 768 }
        const bounds = viewport.mode === 'fill' ? { x: 0, y: 0, ...hidden } : { x: 0, y: 0, width: viewport.width, height: viewport.height }
        runtime.view.setBounds(bounds)
        this.#emulate(runtime, viewport, bounds)
      }
    }
  }

  /** A narrowed viewport is what the page sees whatever the hole's size; a hole smaller than it scales the picture down. */
  #emulate(runtime: TabRuntime, viewport: PreviewViewportView, bounds: Rectangle): void {
    const contents = runtime.view.webContents
    // Emulation needs a drawn page; a view that has not loaded anything yet gets it on its first document.
    if (contents.isDestroyed() || !contents.getURL()) return
    const scale = viewport.mode === 'fill' ? 1 : Math.max(0.05, Math.min(1, bounds.width / viewport.width, bounds.height / viewport.height))
    const key = viewport.mode === 'fill' ? '' : `${viewport.width}x${viewport.height}@${scale.toFixed(4)}`
    if (key === runtime.emulation) return
    runtime.emulation = key
    if (viewport.mode === 'fill') { contents.disableDeviceEmulation(); return }
    contents.enableDeviceEmulation({ screenPosition: 'desktop', screenSize: { width: viewport.width, height: viewport.height }, viewPosition: { x: 0, y: 0 }, deviceScaleFactor: 0, viewSize: { width: viewport.width, height: viewport.height }, scale })
  }

  /** Whether the tab is on screen right now, for status results. */
  #visible(tabId: string): boolean {
    return this.#shownTabId === tabId && this.#bounds !== null && !this.#overlay && this.#window?.isVisible() === true
  }

  // ---- Tabs

  #session(partition: string): Session {
    const guest = session.fromPartition(partition)
    if (!this.#sessions.has(guest)) {
      this.#sessions.add(guest)
      // Pages get no permission but fullscreen, and the shell's deny-all never reaches them.
      guest.setPermissionRequestHandler((_contents, permission, callback) => callback(guestPermissionDecision(permission)))
      guest.on('will-download', (event) => event.preventDefault())
      guest.setPermissionCheckHandler((_contents, permission) => guestPermissionDecision(permission))
    }
    return guest
  }

  #create(input: { projectId: string; workingFolder: string; kind: 'owner' | 'agent'; threadId: string | null; url: string; viewport?: PreviewViewportView; id?: string; openedAt?: number }): PreviewTabRecord {
    const partition = partitionFor(input.workingFolder)
    const view = new WebContentsView({ webPreferences: { partition, contextIsolation: true, sandbox: true, nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false, webviewTag: false, spellcheck: false } })
    this.#session(partition)
    const id = input.id ?? `tab_${randomUUID()}`
    const tab: PreviewTabRecord = {
      id, projectId: input.projectId, workingFolder: input.workingFolder, partition, kind: input.kind, threadId: input.threadId,
      openedUrl: input.url, url: input.url, title: '', loading: false, canGoBack: false, canGoForward: false,
      viewport: input.viewport ?? { mode: 'fill' }, paused: false, working: false, activity: null, error: null, openedAt: input.openedAt ?? this.#now(), document: 0,
    }
    const runtime: TabRuntime = { view, queue: Promise.resolve(), epoch: 0, console: [], actions: [], synthetic: 0, emulation: '', size: null, popups: new Set(), ownerRevision: 0 }
    this.#model.add(tab)
    this.#runtimes.set(id, runtime)
    this.#wire(id, view.webContents, runtime)
    view.setBackgroundColor('#ffffffff')
    // A background tab keeps running: an agent's page must not be throttled because the owner is looking elsewhere.
    this.#attachHidden(view)
    view.webContents.setBackgroundThrottling(false)
    return tab
  }

  #wire(id: string, contents: WebContents, runtime: TabRuntime): void {
    const update = (patch: Partial<PreviewTabRecord>) => { if (this.#model.update(id, patch)) { this.#schedulePersist(); this.#publish() } }
    const navigation = () => ({ url: contents.getURL(), canGoBack: contents.navigationHistory.canGoBack(), canGoForward: contents.navigationHistory.canGoForward() })
    contents.on('did-start-loading', () => update({ loading: true, error: null }))
    contents.on('did-stop-loading', () => update({ loading: false, ...navigation() }))
    contents.on('did-navigate', () => update({ ...navigation(), title: contents.getTitle(), document: (this.#model.get(id)?.document ?? 0) + 1 }))
    // The first document a view draws takes the narrowed viewport it was opened with.
    contents.on('dom-ready', () => this.#layout())
    contents.on('did-navigate-in-page', () => update(navigation()))
    contents.on('page-title-updated', (_event, title) => update({ title }))
    contents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
      if (!isMainFrame || code === -3) return
      update({ loading: false, error: `This page could not be opened (${description || code}).`, url: url || contents.getURL() })
    })
    contents.on('render-process-gone', (_event, details) => update({ error: `The page stopped (${details.reason}). Reload to try again.`, loading: false }))
    contents.on('console-message', (details) => {
      const level: unknown = details.level
      runtime.console.push({ level: typeof level === 'number' ? (['verbose', 'info', 'warning', 'error'][level] ?? 'info') : String(level ?? 'info'), text: details.message.slice(0, 2_000), timestamp: new Date(this.#now()).toISOString() })
      if (runtime.console.length > 200) runtime.console.splice(0, runtime.console.length - 200)
    })
    // Http and https pages, and local .html files a reply linked; anything else the page tries to reach is refused.
    contents.on('will-navigate', (event, url) => { if (!allowedGuestUrl(url)) event.preventDefault() })
    contents.setWindowOpenHandler((details) => {
      const disposition = guestWindowDisposition(details)
      const tab = this.#model.get(id)
      if (disposition === 'tab' && tab) {
        this.#create({ projectId: tab.projectId, workingFolder: tab.workingFolder, kind: tab.kind, threadId: tab.threadId, url: details.url })
        const created = this.#model.list().at(-1)
        if (created) { void this.#runtimes.get(created.id)?.view.webContents.loadURL(details.url).catch(() => undefined); this.#schedulePersist(); this.#publish() }
        return { action: 'deny' }
      }
      if (disposition === 'deny' || !tab) return { action: 'deny' }
      return { action: 'allow', overrideBrowserWindowOptions: { width: 720, height: 640, show: true, ...(this.#window && !this.#window.isDestroyed() ? { parent: this.#window } : {}), webPreferences: { partition: tab.partition, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true } } }
    })
    contents.on('did-create-window', popup => this.#wirePopup(popup, runtime))
    // Deliberate interaction in an agent tab takes control: queued actions stop, waiting ones are interrupted, completed ones stand.
    contents.on('input-event', (_event, input) => {
      if (runtime.synthetic > 0) return
      if (input.type !== 'mouseDown' && input.type !== 'keyDown' && input.type !== 'char' && input.type !== 'mouseWheel') return
      runtime.ownerRevision++
      reportPreviewOwnerInput(); this.#options.ownerActivity?.()
      const tab = this.#model.get(id)
      if (!tab || tab.kind !== 'agent') return
      this.takeControl(id)
    })
    contents.on('destroyed', () => { if (this.#runtimes.has(id)) this.#forget(id) })
  }

  #wirePopup(popup: BrowserWindow, runtime: TabRuntime): void {
    runtime.popups.add(popup)
    popup.once('closed', () => runtime.popups.delete(popup))
    const contents = popup.webContents
    contents.on('will-navigate', (event, url) => { if (!allowedGuestUrl(url)) event.preventDefault() })
    contents.on('will-redirect', (event, url) => { if (!allowedGuestUrl(url)) event.preventDefault() })
    contents.setWindowOpenHandler(details => guestWindowDisposition(details) === 'deny' ? { action: 'deny' } : { action: 'allow', overrideBrowserWindowOptions: { parent: popup, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } } })
    contents.on('did-create-window', child => this.#wirePopup(child, runtime))
    contents.on('before-input-event', () => { reportPreviewOwnerInput(); this.#options.ownerActivity?.() })
    contents.on('before-mouse-event', () => { reportPreviewOwnerInput(); this.#options.ownerActivity?.() })
  }

  #forget(id: string): void {
    const runtime = this.#runtimes.get(id)
    this.#runtimes.delete(id)
    this.#recordings.get(id)?.dispose()
    this.#recordings.delete(id)
    this.#recordingDestinations.delete(id)
    this.#model.remove(id)
    if (runtime) {
      for (const popup of runtime.popups) if (!popup.isDestroyed()) popup.destroy()
      runtime.epoch += 1
      if (this.#window && !this.#window.isDestroyed() && this.#window.contentView.children.includes(runtime.view)) this.#window.contentView.removeChildView(runtime.view)
    }
    if (this.#shownTabId === id) this.#shownTabId = null
    this.#schedulePersist()
    this.#publish()
  }

  /** An owner tab in the project's preview window; a blank address opens an empty tab for the address bar. */
  async openOwnerTab(input: { projectId: string; url?: string }): Promise<string> {
    const project = this.#options.resolveProject(input.projectId)
    if (!project) throw new Error(`Project was not found: ${input.projectId}`)
    const url = input.url ? await resolveOpenableAddress(input.url) : ''
    const tab = this.#create({ projectId: input.projectId, workingFolder: project.workspaceRoot, kind: 'owner', threadId: null, url })
    if (url) void this.#runtimes.get(tab.id)!.view.webContents.loadURL(url).catch(() => undefined)
    this.#schedulePersist()
    this.#publish()
    return tab.id
  }

  /** Closing a tab stops its pending work and the page with it. */
  closeTab(id: string): void {
    const runtime = this.#runtimes.get(id)
    if (!runtime) return
    runtime.epoch += 1
    this.#forget(id)
    runtime.view.webContents.close()
  }

  async navigate(id: string, navigation: PreviewNavigation): Promise<void> {
    const runtime = this.#runtimes.get(id)
    const tab = this.#model.get(id)
    if (!runtime || !tab) throw new Error('That tab is closed')
    const contents = runtime.view.webContents
    if ('url' in navigation) {
      const url = await resolveOpenableAddress(navigation.url)
      this.#model.update(id, { url, openedUrl: tab.url ? tab.openedUrl : url, error: null })
      this.#publish()
      await contents.loadURL(url).catch((error: unknown) => { if (!/ERR_ABORTED/.test(String(error))) throw error })
      return
    }
    if (navigation.action === 'back' && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack()
    else if (navigation.action === 'forward' && contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward()
    else if (navigation.action === 'reload') contents.reload()
    else if (navigation.action === 'stop') contents.stop()
  }

  resize(id: string, request: PreviewViewportRequest): PreviewViewportView {
    if (!this.#model.get(id)) throw new Error('That tab is closed')
    const resolved = resolveViewport(request)
    if ('error' in resolved) throw new Error(resolved.error)
    this.#model.update(id, { viewport: resolved.viewport })
    this.#layout()
    this.#schedulePersist()
    this.#publish()
    return resolved.viewport
  }

  /** The owner takes control of an agent tab; nothing queued survives, nothing is replayed later. An owner tab has nothing to pause. */
  takeControl(id: string): void {
    const tab = this.#model.get(id)
    const runtime = this.#runtimes.get(id)
    if (!tab || !runtime || tab.paused || tab.kind !== 'agent') return
    runtime.epoch += 1
    this.#model.update(id, { paused: true, working: false, activity: 'Paused: you took control' })
    this.#publish()
  }

  resume(id: string): void {
    const tab = this.#model.get(id)
    if (!tab) throw new Error('That tab is closed')
    if (!tab.paused) return
    this.#model.update(id, { paused: false, activity: null })
    this.#publish()
  }

  /** A real input landing in a tab, for the test probe: the same path an owner's click takes. */
  humanInput(id: string, point: { x: number; y: number }): void {
    const runtime = this.#runtimes.get(id)
    if (!runtime) throw new Error('That tab is closed')
    runtime.view.webContents.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 })
    runtime.view.webContents.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 })
    // The input-event listener fires as the event reaches the page; a paused tab must not wait on that.
    this.takeControl(id)
  }

  // ---- Persistence: the owner's tabs come back when a window reopens

  #schedulePersist(): void {
    if (this.#closed) return
    if (this.#persistTimer) clearTimeout(this.#persistTimer)
    this.#persistTimer = setTimeout(() => { this.#persistTimer = null; void this.persist() }, 300)
    this.#persistTimer.unref?.()
  }

  async persist(): Promise<void> {
    try { await atomicWriteFile(this.#persistPath, `${JSON.stringify({ formatVersion: 1, tabs: this.#model.persisted() }, null, 2)}\n`, { mode: PRIVATE_FILE_MODE }) }
    catch (error) { logError('preview', 'Preview tabs could not be remembered', error) }
  }

  async restore(): Promise<void> {
    await this.#evidence.restore()
    let tabs: PersistedPreviewTab[] = []
    try {
      const raw = JSON.parse(await readFile(this.#persistPath, 'utf8')) as { formatVersion?: unknown; tabs?: unknown }
      if (raw.formatVersion === 1 && Array.isArray(raw.tabs)) tabs = raw.tabs.filter((tab): tab is PersistedPreviewTab => typeof tab === 'object' && tab !== null && typeof (tab as PersistedPreviewTab).id === 'string' && typeof (tab as PersistedPreviewTab).projectId === 'string' && typeof (tab as PersistedPreviewTab).url === 'string')
    } catch { return }
    for (const saved of tabs) {
      const project = this.#options.resolveProject(saved.projectId)
      if (!project) continue
      const tab = this.#create({ id: saved.id, projectId: saved.projectId, workingFolder: project.workspaceRoot, kind: 'owner', threadId: null, url: saved.url, viewport: saved.viewport ?? { mode: 'fill' }, openedAt: saved.openedAt })
      this.#model.update(tab.id, { title: saved.title })
      if (saved.url) void this.#runtimes.get(tab.id)!.view.webContents.loadURL(saved.url).catch(() => undefined)
    }
    this.#publish()
  }

  async shutdown(): Promise<void> {
    this.#closed = true
    for (const recording of this.#recordings.values()) recording.dispose()
    this.#recordings.clear()
    this.#recordingDestinations.clear()
    if (this.#persistTimer) clearTimeout(this.#persistTimer)
    await this.persist()
    for (const [id, runtime] of [...this.#runtimes]) { this.#runtimes.delete(id); runtime.epoch += 1; for (const popup of runtime.popups) if (!popup.isDestroyed()) popup.destroy(); try { runtime.view.webContents.close() } catch { /* already gone */ } }
    this.#parking?.destroy(); this.#parking = null
  }

  // ---- Captures and one-shot queries (phases 3 and 4)

  async viewportOf(id: string): Promise<{ width: number; height: number; scroll: { x: number; y: number }; deviceScale: number }> {
    const contents = this.#contents(id)
    return await contents.executeJavaScript('({ width: window.innerWidth, height: window.innerHeight, scroll: { x: Math.round(window.scrollX), y: Math.round(window.scrollY) }, deviceScale: window.devicePixelRatio || 1 })', true) as { width: number; height: number; scroll: { x: number; y: number }; deviceScale: number }
  }

  /** A frame from a shown or parked tab, waiting for its compositor when needed. */
  async #captureImage(id: string, rect?: Rectangle): Promise<Electron.NativeImage> {
    const contents = this.#contents(id)
    return captureWhenPainted(contents, `Preview tab ${id}`, this.#now, rect)
  }

  /** The visible frame, or a rect of it, as PNG bytes in device pixels. */
  async capture(id: string, rect?: Rectangle): Promise<{ bytes: Uint8Array; width: number; height: number; cssWidth: number; cssHeight: number; scroll: { x: number; y: number }; deviceScale: number }> {
    const viewport = await this.viewportOf(id)
    const image = await this.#captureImage(id, rect)
    const size = image.getSize()
    const cssWidth = rect?.width ?? viewport.width
    // The picture may be scaled down to fit the window; the ratio maps its pixels back to the page's own units.
    return { bytes: new Uint8Array(image.toPNG()), width: size.width, height: size.height, cssWidth, cssHeight: rect?.height ?? viewport.height, scroll: viewport.scroll, deviceScale: cssWidth > 0 && size.width > 0 ? size.width / cssWidth : viewport.deviceScale }
  }

  /** A one-shot page query: runs once, returns bounded data, leaves nothing behind. */
  async query<T>(id: string, script: string): Promise<T> {
    return await this.#contents(id).executeJavaScript(script, true) as T
  }

  // ---- Marking up a running page (phase 3): one-shot queries driven from Strata's own interface

  tab(id: string): PreviewTabRecord | null {
    return this.#model.get(id) ?? null
  }

  /** The frame Annotate opens on: anything Strata drew in the page is cleared first, so the capture is the page alone. */
  async captureFrame(id: string): Promise<{ bytes: Uint8Array; width: number; height: number; cssWidth: number; cssHeight: number; scroll: { x: number; y: number }; scale: number; page: { url: string; title: string; viewport: { width: number; height: number }; preset: string | null; deviceScale: number; document: number } }> {
    const tab = this.#model.get(id)
    if (!tab) throw new Error('That tab is closed')
    await this.query(id, CLEAR_STRATA_SCRIPT).catch(() => undefined)
    const measured = await this.viewportOf(id)
    const frame = await this.capture(id)
    return {
      bytes: frame.bytes, width: frame.width, height: frame.height, cssWidth: frame.cssWidth, cssHeight: frame.cssHeight, scroll: frame.scroll, scale: frame.deviceScale,
      page: { url: tab.url, title: tab.title, viewport: { width: measured.width, height: measured.height }, preset: tab.viewport.mode === 'preset' ? tab.viewport.label : null, deviceScale: measured.deviceScale, document: tab.document },
    }
  }

  /** What is at a point or in a box of the page, in page pixels. */
  async describe(id: string, target: { point: { x: number; y: number } } | { rect: PageRect }): Promise<PageDescription | null> {
    return await this.query<PageDescription | null>(id, describeScript(target))
  }

  /** Whether a marked thing is found right now: exactly one visible match. */
  async locate(id: string, identity: Pick<PageIdentity, 'selector' | 'testIds' | 'role' | 'name'>): Promise<PageMatch | null> {
    const match = await this.query<{ matches: number; rect: PageRect | null; scroll: { x: number; y: number } } | null>(id, locateScript(identity))
    return match && match.rect && match.matches === 1 ? { rect: match.rect, scroll: match.scroll, matches: 1 } : match ? { rect: match.rect ?? { x: 0, y: 0, width: 0, height: 0 }, scroll: match.scroll, matches: match.matches } : null
  }

  async scroll(id: string, move: { by: { x: number; y: number } } | { to: { x: number; y: number } }): Promise<{ x: number; y: number }> {
    const runtime = this.#runtimes.get(id); if (runtime) runtime.ownerRevision++
    return await this.query<{ x: number; y: number }>(id, pageScrollScript(move))
  }

  /** Adjustments: the whole set of Strata's overrides at once; returns the marks that were found and styled. */
  async applyOverrides(id: string, targets: OverrideTarget[]): Promise<string[]> {
    const runtime = this.#runtimes.get(id); if (runtime) runtime.ownerRevision++
    return await this.query<string[]>(id, applyOverridesScript(targets))
  }

  /** Removes only Strata's overrides; the page's own styles, live or not, are left as they are. */
  async clearOverrides(id: string): Promise<void> {
    const runtime = this.#runtimes.get(id); if (runtime) runtime.ownerRevision++
    await this.query(id, CLEAR_OVERRIDES_SCRIPT).catch(() => undefined)
  }

  /**
   * A page opened out of sight at a given size, for a comparison when the original tab is gone or shows
   * another size: no tab, no strip entry, gone again when the work is done. Storage is the project's.
   */
  async withScratchView<T>(input: { workingFolder: string; url: string; viewport: { width: number; height: number }; timeoutMs?: number }, work: (contents: WebContents) => Promise<T>): Promise<T> {
    const partition = partitionFor(input.workingFolder)
    this.#session(partition)
    const view = new WebContentsView({ webPreferences: { partition, contextIsolation: true, sandbox: true, nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false, webviewTag: false, spellcheck: false } })
    const contents = view.webContents
    contents.setBackgroundThrottling(false)
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('will-navigate', (event, url) => { if (!allowedGuestUrl(url)) event.preventDefault() })
    try {
      this.#attachHidden(view)
      view.setBounds({ x: 0, y: 0, width: input.viewport.width, height: input.viewport.height })
      view.setVisible(true)

      await this.#load(contents, input.url, 'load', input.timeoutMs ?? DEFAULT_TIMEOUT_MS, () => undefined)
      return await work(contents)
    } finally {
      if (this.#parking && !this.#parking.isDestroyed() && this.#parking.contentView.children.includes(view)) this.#parking.contentView.removeChildView(view)
      if (!contents.isDestroyed()) contents.close()
    }
  }

  /** A frame from any web contents with the page's own size and scroll; the caller controls clean capture. */
  async frameOf(contents: WebContents): Promise<{ bytes: Uint8Array; width: number; height: number; cssWidth: number; cssHeight: number; scroll: { x: number; y: number }; scale: number }> {
    const viewport = await contents.executeJavaScript('({ width: window.innerWidth, height: window.innerHeight, scroll: { x: Math.round(window.scrollX), y: Math.round(window.scrollY) }, deviceScale: window.devicePixelRatio || 1 })', true) as { width: number; height: number; scroll: { x: number; y: number }; deviceScale: number }
    const image = await captureWhenPainted(contents, 'Preview page', this.#now)
    const size = image.getSize()
    return { bytes: new Uint8Array(image.toPNG()), width: size.width, height: size.height, cssWidth: viewport.width, cssHeight: viewport.height, scroll: viewport.scroll, scale: viewport.width > 0 && size.width > 0 ? size.width / viewport.width : viewport.deviceScale }
  }

  /** Comparisons share the tab queue and restore only the unchanged owner's view. */
  async compareInPlace<T>(id: string, work: (contents: WebContents) => Promise<T>): Promise<T> {
    const runtime = this.#runtimes.get(id)
    if (!runtime) throw new Error(`Preview tab ${id} is closed`)
    const previous = runtime.queue
    let release!: () => void
    runtime.queue = new Promise<void>(resolve => { release = resolve })
    await previous
    const epoch = runtime.epoch, revision = runtime.ownerRevision, document = this.#model.get(id)?.document
    const unchanged = () => this.#runtimes.get(id) === runtime && runtime.epoch === epoch && runtime.ownerRevision === revision && this.#model.get(id)?.document === document
    try {
      const scroll = (await this.viewportOf(id)).scroll
      return await withCleanPage(this.#contents(id), async () => {
        try {
          const result = await work(this.#contents(id))
          if (!unchanged()) throw new PreviewFailure('PreviewAutomationControlInterruptedError', 'The page changed during comparison. Try again from the current page.')
          return result
        } finally { if (unchanged()) await this.query(id, pageScrollScript({ to: scroll })).catch(() => undefined) }
      }, unchanged)
    } finally { release() }
  }

  /** The web contents behind a tab, for a comparison run in place. */
  contentsOf(id: string): WebContents {
    return this.#contents(id)
  }

  /** Show me: the size and scroll the comment was made at, then an outline on each thing still found with confidence. */
  async show(id: string, state: { viewport: { width: number; height: number; preset: string | null }; scroll: { x: number; y: number } | null; marks: Array<{ id: string; identity: Pick<PageIdentity, 'selector' | 'testIds' | 'role' | 'name'> }> }): Promise<string[]> {
    const tab = this.#model.get(id)
    if (!tab) throw new Error('That tab is closed')
    const current = tab.viewport.mode === 'fill' ? null : { width: tab.viewport.width, height: tab.viewport.height }
    if (!current || current.width !== state.viewport.width || current.height !== state.viewport.height) {
      const preset = state.viewport.preset ? PRESET_BY_LABEL(state.viewport.preset, state.viewport) : null
      this.resize(id, preset ? { mode: 'preset', preset } : { mode: 'freeform', width: state.viewport.width, height: state.viewport.height })
    }
    this.#reveal = { tabId: id, at: this.#now() }
    this.#publish()
    if (state.scroll) await this.scroll(id, { to: state.scroll }).catch(() => undefined)
    const outlined: string[] = []
    for (const mark of state.marks) {
      const rect = await this.query<PageRect | null>(id, outlineScript(mark.identity, OUTLINE_MS)).catch(() => null)
      if (rect) outlined.push(mark.id)
    }
    return outlined
  }

  #contents(id: string): WebContents {
    const runtime = this.#runtimes.get(id)
    if (!runtime || runtime.view.webContents.isDestroyed()) throw new PreviewFailure('PreviewAutomationTabNotFoundError', `Preview tab ${id} is closed`)
    return runtime.view.webContents
  }

  // ---- The engine's browser requests

  async handle(request: PreviewAutomationRequest): Promise<PreviewAutomationOutcome> {
    if (!(PREVIEW_OPERATIONS as readonly string[]).includes(request.operation)) return { ok: false, error: { _tag: 'PreviewAutomationUnsupportedClientError', message: `Strata does not do ${request.operation}` } }
    this.#serving.set(request.threadId, (this.#serving.get(request.threadId) ?? 0) + 1)
    this.#publish()
    try {
      const result = await this.#run(request)
      return { ok: true, result: result === undefined ? null : result }
    } catch (error) {
      if (error instanceof PreviewFailure) return { ok: false, error: { _tag: error.tag, message: error.message, ...(error.detail !== undefined ? { detail: error.detail } : {}) } }
      logWarn('preview', `Browser request ${request.operation} failed: ${error instanceof Error ? error.message : String(error)}`)
      return { ok: false, error: { _tag: 'PreviewAutomationExecutionError', message: error instanceof Error ? error.message : String(error) } }
    } finally {
      const count = (this.#serving.get(request.threadId) ?? 1) - 1
      if (count <= 0) this.#serving.delete(request.threadId); else this.#serving.set(request.threadId, count)
      this.#publish()
    }
  }

  async #run(request: PreviewAutomationRequest): Promise<unknown> {
    const input = record(request.input)
    const operation = request.operation as PreviewOperation
    if (operation === 'status') {
      const tab = request.tabId !== undefined ? this.#model.get(request.tabId) : this.#model.currentFor(request.threadId)
      return tab ? this.#status(tab.id) : { available: false, visible: false, tabId: null, url: null, title: null, loading: false }
    }
    if (operation === 'open') return this.#open(request, input)
    const tab = this.#model.resolve(request.threadId, request.tabId)
    return this.#act(tab.id, operation, request, async (runtime, epoch) => {
      const contents = this.#contents(tab.id)
      const timeout = typeof input.timeoutMs === 'number' ? input.timeoutMs : request.timeoutMs || DEFAULT_TIMEOUT_MS
      const check = () => { if (runtime.epoch !== epoch) throw new PreviewFailure('PreviewAutomationControlInterruptedError', 'The owner took control of this tab. Resume it to continue.') }
      switch (operation) {
        case 'navigate': {
          const url = typeof input.url === 'string' ? input.url : this.#targetUrl(record(input.target))
          const resolved = resolvePreviewAddress(url)
          if ('error' in resolved) throw new PreviewFailure('PreviewAutomationExecutionError', resolved.error)
          this.#model.update(tab.id, { url: resolved.url, error: null })
          this.#publish()
          await this.#load(contents, resolved.url, (input.readiness === 'domContentLoaded' || input.readiness === 'none' ? input.readiness : 'load'), timeout, check)
          return this.#status(tab.id)
        }
        case 'resize': {
          const mode = input.mode === 'preset' || input.mode === 'freeform' ? input.mode : 'fill'
          const request2: PreviewViewportRequest = mode === 'fill' ? { mode: 'fill' } : mode === 'preset' ? { mode: 'preset', preset: String(input.preset ?? '') } : { mode: 'freeform', width: Number(input.width), height: Number(input.height) }
          const viewport = this.resize(tab.id, request2)
          // The renderer lays the hole out from the new setting; wait until the page measures that size.
          const deadline = this.#now() + Math.min(timeout, 5_000)
          let measured = await this.viewportOf(tab.id)
          const fits = () => viewport.mode === 'fill' ? true : Math.abs(measured.width - viewport.width) <= 1 && Math.abs(measured.height - viewport.height) <= 1
          while (!fits() && this.#now() < deadline) { await delay(50); check(); measured = await this.viewportOf(tab.id) }
          return { tabId: tab.id, setting: viewportSetting(viewport), viewport: { width: measured.width, height: measured.height } }
        }
        case 'recordingStart': {
          let recording = this.#recordings.get(tab.id)
          if (!recording) { const destination = this.#evidence.destination; recording = await BrowserRecording.start(contents); this.#recordings.set(tab.id, recording); this.#recordingDestinations.set(tab.id, destination); this.#finishedRecordings.delete(tab.id) }
          return { tabId: tab.id, recording: true, startedAt: recording.startedAt }
        }
        case 'recordingStop': {
          let id = this.#finishedRecordings.get(tab.id)
          const recording = this.#recordings.get(tab.id)
          if (recording) {
            try {
              const bytes = await recording.stop()
              const artifact = await this.#evidence.save({ tabId: tab.id, threadId: request.threadId, bytes, mimeType: 'video/webm', name: `${pageName(tab.url, tab.title)} recording`, destination: this.#recordingDestinations.get(tab.id) ?? null })
              id = artifact.id; this.#finishedRecordings.set(tab.id, id)
            } finally { this.#recordings.delete(tab.id); this.#recordingDestinations.delete(tab.id) }
          }
          if (!id) throw new PreviewFailure('PreviewAutomationExecutionError', `No recording was started in tab ${tab.id}`)
          try { return await this.#evidence.transfer(id) }
          catch (error) { throw new PreviewFailure('PreviewAutomationRecordingTransferError', error instanceof Error ? error.message : String(error), { evidenceId: id }) }
        }
        case 'snapshot': return withCleanPage(contents, async () => {
          const page = await contents.executeJavaScript(snapshotScript(SNAPSHOT_LIMITS), true) as Record<string, unknown>
          const image = await this.#captureImage(tab.id)
          const size = image.getSize()
          await this.#evidence.save({ tabId: tab.id, threadId: request.threadId, bytes: image.toPNG(), mimeType: 'image/png', name: pageName(tab.url, tab.title) })
          return {
            ...boundSnapshot({ ...page, loading: contents.isLoading(), consoleEntries: runtime.console.slice(-50), networkEntries: [], actionTimeline: runtime.actions.slice(-50) }),
            screenshot: { mimeType: 'image/png', data: image.toPNG().toString('base64'), width: size.width, height: size.height },
          }
        }, () => runtime.epoch === epoch)
        case 'click': {
          const point = typeof input.x === 'number' && typeof input.y === 'number'
            ? { x: input.x, y: input.y }
            : await this.#locate(contents, input, { scroll: true }).then((found) => ({ x: found.rect.x + found.rect.width / 2, y: found.rect.y + found.rect.height / 2 }))
          check()
          this.#synthetic(runtime, () => {
            contents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y })
            contents.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 })
            contents.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 })
          })
          await delay(30)
          return null
        }
        case 'type': {
          const text = String(input.text ?? '')
          if (input.selector !== undefined || input.locator !== undefined) {
            const found = await this.#locate(contents, input, { scroll: true })
            if (!found.editable) throw new PreviewFailure('PreviewAutomationTargetNotEditableError', 'That target does not take text', { selectorKind: input.locator !== undefined ? 'locator' : 'selector', selectorLength: String(input.locator ?? input.selector).length })
            const focused = await contents.executeJavaScript(focusScript(found.selector, input.clear === true), true) as boolean
            if (!focused) throw new PreviewFailure('PreviewAutomationTargetNotEditableError', 'That target could not take focus', { selectorKind: input.locator !== undefined ? 'locator' : 'selector' })
          } else {
            const editable = await contents.executeJavaScript(FOCUSED_EDITABLE_SCRIPT, true) as boolean
            if (!editable) throw new PreviewFailure('PreviewAutomationTargetNotEditableError', 'Nothing editable has focus', { selectorKind: 'focused-element' })
            if (input.clear === true) await contents.executeJavaScript(`(() => { const el = document.activeElement; if (el && 'value' in el) { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })) } })()`, true)
          }
          check()
          await this.#synthetic(runtime, () => contents.insertText(text))
          return null
        }
        case 'press': {
          const key = keyEvent(String(input.key ?? ''))
          const modifiers = Array.isArray(input.modifiers) ? input.modifiers.flatMap((value) => value === 'Control' ? ['control'] : value === 'Shift' ? ['shift'] : value === 'Alt' ? ['alt'] : value === 'Meta' ? ['meta'] : []) as Array<'control' | 'shift' | 'alt' | 'meta'> : []
          check()
          this.#synthetic(runtime, () => {
            contents.sendInputEvent({ type: 'keyDown', keyCode: key.keyCode, modifiers })
            if (key.char !== null) contents.sendInputEvent({ type: 'char', keyCode: key.char, modifiers })
            contents.sendInputEvent({ type: 'keyUp', keyCode: key.keyCode, modifiers })
          })
          await delay(30)
          return null
        }
        case 'scroll': {
          const deltaX = typeof input.deltaX === 'number' ? input.deltaX : 0
          const deltaY = typeof input.deltaY === 'number' ? input.deltaY : 0
          const selector = input.selector !== undefined || input.locator !== undefined ? (await this.#locate(contents, input, { scroll: false })).selector : null
          const scrolled = await contents.executeJavaScript(scrollScript(selector, deltaX, deltaY), true) as boolean
          if (!scrolled) throw new PreviewFailure('PreviewAutomationInvalidSelectorError', 'Nothing matched the scroll container')
          return null
        }
        case 'evaluate': {
          const expression = String(input.expression ?? '')
          const outcome = await contents.executeJavaScript(`(async () => { try { const value = (${expression}); return { ok: true, value: ${input.awaitPromise === false ? 'value' : 'await value'} } } catch (error) { return { ok: false, error: String(error && error.message || error) } } })()`, true).catch((error: unknown) => ({ ok: false, error: error instanceof Error ? error.message : String(error) })) as { ok: boolean; value?: unknown; error?: string }
          if (!outcome.ok) throw new PreviewFailure('PreviewAutomationExecutionError', outcome.error ?? 'The expression failed')
          const serialized = JSON.stringify(outcome.value ?? null)
          if (serialized && Buffer.byteLength(serialized, 'utf8') > MAX_RESULT_BYTES) throw new PreviewFailure('PreviewAutomationResultTooLargeError', 'The result is too large to return', { maximumBytes: MAX_RESULT_BYTES })
          return outcome.value ?? null
        }
        case 'waitFor': {
          const locator = input.selector !== undefined || input.locator !== undefined ? parseLocator({ ...(typeof input.selector === 'string' ? { selector: input.selector } : {}), ...(typeof input.locator === 'string' ? { locator: input.locator } : {}) }) : undefined
          const script = waitConditionScript({ ...(locator ? { locator } : {}), ...(typeof input.text === 'string' ? { text: input.text } : {}), ...(typeof input.urlIncludes === 'string' ? { urlIncludes: input.urlIncludes } : {}) })
          const deadline = this.#now() + timeout
          for (;;) {
            check()
            const done = await contents.executeJavaScript(script, true).catch(() => false) as boolean
            if (done) return null
            if (this.#now() >= deadline) throw new PreviewFailure('PreviewAutomationTimeoutError', `Nothing matched within ${timeout} ms`)
            await delay(100)
          }
        }
        default:
          throw new PreviewFailure('PreviewAutomationUnsupportedClientError', `Strata does not do ${operation}`)
      }
    })
  }

  async #open(request: PreviewAutomationRequest, input: Record<string, unknown>): Promise<unknown> {
    const thread = this.#options.resolveThread(request.threadId)
    if (!thread) throw new PreviewFailure('PreviewAutomationExecutionError', `Thread ${request.threadId} is not in a project Strata knows`)
    const explicit = request.tabId !== undefined && request.tabIdExplicit !== false
    let tab = explicit ? this.#model.resolve(request.threadId, request.tabId) : input.reuseExistingTab === false ? null : request.tabId ? this.#model.get(request.tabId) : this.#model.currentFor(request.threadId)
    if (!tab) {
      tab = this.#create({ projectId: thread.projectId, workingFolder: thread.workingFolder, kind: 'agent', threadId: request.threadId, url: '' })
      this.#publish()
    }
    this.#model.setCurrent(request.threadId, tab.id)
    if (input.open !== false) this.#reveal = { tabId: tab.id, at: this.#now() }
    const tabId = tab.id
    return this.#act(tabId, 'open', request, async (runtime, epoch) => {
      const contents = this.#contents(tabId)
      if (typeof input.url === 'string' && input.url) {
        const resolved = resolvePreviewAddress(input.url)
        if ('error' in resolved) throw new PreviewFailure('PreviewAutomationExecutionError', resolved.error)
        this.#model.update(tabId, { url: resolved.url, openedUrl: this.#model.get(tabId)?.url ? this.#model.get(tabId)!.openedUrl : resolved.url, error: null })
        this.#publish()
        await this.#load(contents, resolved.url, 'load', request.timeoutMs || DEFAULT_TIMEOUT_MS, () => { if (runtime.epoch !== epoch) throw new PreviewFailure('PreviewAutomationControlInterruptedError', 'The owner took control of this tab.') })
      }
      return this.#status(tabId)
    })
  }

  #targetUrl(target: Record<string, unknown>): string {
    if (target.kind === 'url' && typeof target.url === 'string') return target.url
    if (target.kind === 'environment-port' && typeof target.port === 'number') return `${target.protocol === 'https' ? 'https' : 'http'}://localhost:${target.port}${typeof target.path === 'string' ? target.path : ''}`
    throw new PreviewFailure('PreviewAutomationExecutionError', 'Provide a url or an environment port')
  }

  async #load(contents: WebContents, url: string, readiness: 'load' | 'domContentLoaded' | 'none', timeoutMs: number, check: () => void): Promise<void> {
    const loading = contents.loadURL(url).catch((error: unknown) => { if (!/ERR_ABORTED/.test(String(error))) throw new PreviewFailure('PreviewAutomationExecutionError', `The page could not be opened (${error instanceof Error ? error.message : String(error)})`) })
    if (readiness === 'none') return
    const deadline = this.#now() + timeoutMs
    let settled = false
    let failed: Error | null = null
    void loading.then(() => { settled = true }, (error: unknown) => { failed = error instanceof Error ? error : new Error(String(error)) })
    const ready = () => readiness === 'domContentLoaded' ? !contents.isLoadingMainFrame() || settled : !contents.isLoading()
    while (!(settled && ready())) {
      if (failed) throw failed
      check()
      if (this.#now() >= deadline) throw new PreviewFailure('PreviewAutomationTimeoutError', `The page did not finish loading within ${timeoutMs} ms`)
      await delay(50)
    }
  }

  async #locate(contents: WebContents, input: Record<string, unknown>, options: { scroll: boolean }): Promise<{ rect: { x: number; y: number; width: number; height: number }; selector: string; editable: boolean; visible: boolean }> {
    let locator: ParsedLocator
    try { locator = parseLocator({ ...(typeof input.selector === 'string' ? { selector: input.selector } : {}), ...(typeof input.locator === 'string' ? { locator: input.locator } : {}) }) }
    catch (error) { throw new PreviewFailure('PreviewAutomationInvalidSelectorError', error instanceof Error ? error.message : String(error)) }
    const found = await contents.executeJavaScript(findScript(locator, options), true) as { invalid?: string; missing?: boolean; rect?: { x: number; y: number; width: number; height: number }; selector?: string; editable?: boolean; visible?: boolean }
    if (found.invalid) throw new PreviewFailure('PreviewAutomationInvalidSelectorError', `That selector is not valid: ${found.invalid}`, { selectorKind: input.locator !== undefined ? 'locator' : 'selector', selectorLength: String(input.locator ?? input.selector).length })
    if (found.missing || !found.rect || !found.selector) throw new PreviewFailure('PreviewAutomationExecutionError', `Nothing on the page matched ${input.locator ?? input.selector}`)
    if (options.scroll) {
      await delay(30)
      const again = await contents.executeJavaScript(findScript(locator), true) as { rect?: { x: number; y: number; width: number; height: number } }
      if (again.rect) found.rect = again.rect
    }
    return { rect: found.rect, selector: found.selector, editable: found.editable === true, visible: found.visible !== false }
  }

  /** One agent action on one tab, serialized behind the tab's earlier actions and stopped by a control change. */
  async #act<T>(tabId: string, action: string, request: PreviewAutomationRequest, task: (runtime: TabRuntime, epoch: number) => Promise<T>): Promise<T> {
    const runtime = this.#runtimes.get(tabId)
    if (!runtime) throw new PreviewFailure('PreviewAutomationTabNotFoundError', `Preview tab ${tabId} is closed`)
    const tab = this.#model.get(tabId)
    if (tab?.paused) throw new PreviewFailure('PreviewAutomationControlInterruptedError', 'The owner took control of this tab. Resume it to continue.')
    const previous = runtime.queue
    let release!: () => void
    runtime.queue = new Promise<void>((resolve) => { release = resolve })
    await previous
    try {
      if (this.#model.get(tabId)?.paused) throw new PreviewFailure('PreviewAutomationControlInterruptedError', 'The owner took control of this tab. Resume it to continue.')
      const epoch = runtime.epoch
      const entry = { id: `action-${this.#now().toString(36)}-${runtime.actions.length}`, action, status: 'running' as const, startedAt: new Date(this.#now()).toISOString() }
      runtime.actions.push(entry)
      if (runtime.actions.length > 100) runtime.actions.splice(0, runtime.actions.length - 100)
      this.#model.update(tabId, { working: true, activity: this.#describe(action, request) })
      this.#publish()
      try {
        const result = await task(runtime, epoch)
        if (runtime.epoch !== epoch) throw new PreviewFailure('PreviewAutomationControlInterruptedError', 'The owner took control before the operation finished. Already executed page code cannot be undone.')
        Object.assign(entry, { status: 'succeeded', completedAt: new Date(this.#now()).toISOString() })
        return result
      } catch (error) {
        const interrupted = error instanceof PreviewFailure && error.tag === 'PreviewAutomationControlInterruptedError'
        Object.assign(entry, { status: interrupted ? 'interrupted' : 'failed', completedAt: new Date(this.#now()).toISOString(), error: error instanceof Error ? error.message : String(error) })
        throw error
      } finally {
        const current = this.#model.get(tabId)
        if (current) this.#model.update(tabId, { working: false, activity: current.paused ? current.activity : null })
        this.#publish()
      }
    } finally { release() }
  }

  #describe(action: string, request: PreviewAutomationRequest): string {
    const input = record(request.input)
    const target = typeof input.locator === 'string' ? input.locator : typeof input.selector === 'string' ? input.selector : typeof input.text === 'string' ? input.text : typeof input.urlIncludes === 'string' ? input.urlIncludes : ''
    const semantic = target.match(/^role=[a-z]+\[name=["']?([^"'\]]*)["']?\]$/i)
    const plain = semantic?.[1] ?? (target.startsWith('text=') ? target.slice(5) : '')
    switch (action) {
      case 'open': case 'navigate': return 'opening a page'
      case 'snapshot': return 'reading the page'
      case 'click': return plain ? `clicking ${plain}` : 'clicking'
      case 'type': return (input.selector !== undefined || input.locator !== undefined) && plain ? `typing into ${plain}` : 'typing'
      case 'press': return `pressing ${String(input.key ?? 'a key')}`
      case 'scroll': return 'scrolling'
      case 'evaluate': return 'checking the page'
      case 'waitFor': return plain ? `waiting for ${plain}` : 'waiting'
      case 'resize': return 'changing the size'
      default: return 'working'
    }
  }

  #synthetic<T>(runtime: TabRuntime, send: () => T): T {
    runtime.synthetic += 1
    try { return send() } finally { setTimeout(() => { runtime.synthetic = Math.max(0, runtime.synthetic - 1) }, 250) }
  }

  async #status(tabId: string): Promise<unknown> {
    const tab = this.#model.get(tabId)
    if (!tab) return { available: false, visible: false, tabId: null, url: null, title: null, loading: false }
    const measured = await this.viewportOf(tabId).catch(() => null)
    return { available: true, visible: this.#visible(tabId), tabId, url: tab.url || null, title: tab.title || null, loading: tab.loading, viewportSetting: viewportSetting(tab.viewport), ...(measured ? { viewport: { width: measured.width, height: measured.height } } : {}) }
  }

  /** The tab's name for a card or a status pill. */
  pageNameOf(tabId: string): string {
    const tab = this.#model.get(tabId)
    return tab ? pageName(tab.url, tab.title) : 'a closed tab'
  }
}

/** Web pages and existing local .html files are the only addresses a preview tab loads. */
function allowedGuestUrl(url: string): boolean {
  return /^https?:/i.test(url) || isLocalPageSync(url)
}

async function resolveOpenableAddress(input: string): Promise<string> {
  const raw = input.trim()
  if (/^file:/i.test(raw)) {
    if (await isLocalPage(raw)) return raw
    throw new Error(`${raw} is not a .html file on this computer, so the preview cannot show it`)
  }
  const resolved = resolvePreviewAddress(raw)
  if ('error' in resolved) throw new Error(resolved.error)
  return resolved.url
}
