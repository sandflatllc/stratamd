import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BrowserWindow, WebContentsView, session, type Rectangle, type Session, type WebContents } from 'electron'
import type { PreviewBoundsReport, PreviewNavigation, PreviewStateView, PreviewTabView, PreviewViewportRequest, PreviewViewportView } from '../../shared/contracts'
import { pageName, resolvePreviewAddress, resolveViewport, viewportSetting } from '../../shared/preview'
import { atomicWriteFile, PRIVATE_FILE_MODE } from '../storage'
import { logError, logWarn } from '../log'
import { guestPermissionDecision, guestWindowDisposition } from './guest-policy'
import { screenshotPlan } from './capture-budget'
import { PreviewFailure, PreviewTabModel, partitionFor, type PersistedPreviewTab, type PreviewTabRecord } from './tabs'
import { FOCUSED_EDITABLE_SCRIPT, findScript, focusScript, keyEvent, parseLocator, scrollScript, snapshotScript, waitConditionScript, type ParsedLocator } from './scripts'

/**
 * The preview host (docs/plans/open/visual-review, phase 2): main-process
 * views positioned over a hole in Strata's window. Page instances live
 * independently of what the center shows; the renderer reports where the
 * hole is and whether an overlay is open, and the host draws or hides the
 * shown page accordingly. The same host answers the engine's browser
 * requests, one tab per thread at a time, and pauses an agent tab the moment
 * the owner interacts with it.
 */
export const PREVIEW_OPERATIONS = ['status', 'open', 'navigate', 'snapshot', 'click', 'type', 'press', 'scroll', 'evaluate', 'waitFor', 'resize'] as const
export type PreviewOperation = typeof PREVIEW_OPERATIONS[number]

export interface PreviewAutomationRequest {
  requestId: string
  threadId: string
  tabId?: string | undefined
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
}

const DEFAULT_TIMEOUT_MS = 15_000
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
  #window: BrowserWindow | null = null
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
      registered: this.#registered,
      serving: [...this.#serving.keys()],
      reveal: this.#reveal,
    }
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
    for (const runtime of this.#runtimes.values()) this.#attachHidden(runtime.view)
    this.#layout()
  }

  /**
   * Every page keeps a painted widget: a background tab sits behind Strata's
   * own view, where the window's opaque shell hides it and no input reaches it,
   * so it keeps running and can be captured without being brought forward.
   */
  #attachHidden(view: WebContentsView): void {
    const window = this.#window
    if (!window || window.isDestroyed() || window.contentView.children.includes(view)) return
    view.setBounds(this.#bounds ?? { x: 0, y: 0, width: 1024, height: 768 })
    view.setVisible(true)
    window.contentView.addChildView(view, 0)
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
      const show = id === this.#shownTabId && this.#bounds !== null && !this.#overlay && this.#bounds.width > 0 && this.#bounds.height > 0
      this.#attachHidden(runtime.view)
      const viewport = this.#model.get(id)?.viewport ?? { mode: 'fill' as const }
      if (show) {
        runtime.view.setBounds(this.#bounds!)
        // The shown page sits on top of everything; the others go back behind the shell.
        window.contentView.addChildView(runtime.view)
        runtime.view.setVisible(true)
        this.#emulate(runtime, viewport, this.#bounds!)
      } else {
        window.contentView.addChildView(runtime.view, 0)
        runtime.view.setVisible(true)
        // A background page with a narrowed viewport is drawn at that size, so a capture of it is exact.
        const bounds = viewport.mode === 'fill' ? this.#bounds ?? { x: 0, y: 0, width: 1024, height: 768 } : { x: 0, y: 0, width: viewport.width, height: viewport.height }
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
    return this.#shownTabId === tabId && this.#bounds !== null && !this.#overlay && this.#window !== null
  }

  // ---- Tabs

  #session(partition: string): Session {
    const guest = session.fromPartition(partition)
    if (!this.#sessions.has(guest)) {
      this.#sessions.add(guest)
      // Pages get no permission but fullscreen, and the shell's deny-all never reaches them.
      guest.setPermissionRequestHandler((_contents, permission, callback) => callback(guestPermissionDecision(permission)))
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
      viewport: input.viewport ?? { mode: 'fill' }, paused: false, working: false, activity: null, error: null, openedAt: input.openedAt ?? this.#now(),
    }
    const runtime: TabRuntime = { view, queue: Promise.resolve(), epoch: 0, console: [], actions: [], synthetic: 0, emulation: '' }
    this.#model.add(tab)
    this.#runtimes.set(id, runtime)
    this.#wire(id, view.webContents, runtime)
    view.setBackgroundColor('#ffffffff')
    // A background tab keeps running: an agent's page must not be throttled because the owner is looking elsewhere.
    view.webContents.setBackgroundThrottling(false)
    this.#attachHidden(view)
    return tab
  }

  #wire(id: string, contents: WebContents, runtime: TabRuntime): void {
    const update = (patch: Partial<PreviewTabRecord>) => { if (this.#model.update(id, patch)) { this.#schedulePersist(); this.#publish() } }
    const navigation = () => ({ url: contents.getURL(), canGoBack: contents.navigationHistory.canGoBack(), canGoForward: contents.navigationHistory.canGoForward() })
    contents.on('did-start-loading', () => update({ loading: true, error: null }))
    contents.on('did-stop-loading', () => update({ loading: false, ...navigation() }))
    contents.on('did-navigate', () => update({ ...navigation(), title: contents.getTitle() }))
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
    // Only http and https pages; anything else the page tries to reach is refused.
    contents.on('will-navigate', (event, url) => { if (!/^https?:/i.test(url)) event.preventDefault() })
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
    // Deliberate interaction in an agent tab takes control: queued actions stop, waiting ones are interrupted, completed ones stand.
    contents.on('input-event', (_event, input) => {
      if (runtime.synthetic > 0) return
      if (input.type !== 'mouseDown' && input.type !== 'keyDown' && input.type !== 'char' && input.type !== 'mouseWheel') return
      const tab = this.#model.get(id)
      if (!tab || tab.kind !== 'agent') return
      this.takeControl(id)
    })
    contents.on('destroyed', () => { if (this.#runtimes.has(id)) this.#forget(id) })
  }

  #forget(id: string): void {
    const runtime = this.#runtimes.get(id)
    this.#runtimes.delete(id)
    this.#model.remove(id)
    if (runtime) {
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
    let url = ''
    if (input.url) {
      const resolved = resolvePreviewAddress(input.url)
      if ('error' in resolved) throw new Error(resolved.error)
      url = resolved.url
    }
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
      const resolved = resolvePreviewAddress(navigation.url)
      if ('error' in resolved) throw new Error(resolved.error)
      this.#model.update(id, { url: resolved.url, openedUrl: tab.url ? tab.openedUrl : resolved.url, error: null })
      this.#publish()
      await contents.loadURL(resolved.url).catch((error: unknown) => { if (!/ERR_ABORTED/.test(String(error))) throw error })
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
    if (this.#persistTimer) clearTimeout(this.#persistTimer)
    await this.persist()
    for (const [id, runtime] of [...this.#runtimes]) { this.#runtimes.delete(id); runtime.epoch += 1; try { runtime.view.webContents.close() } catch { /* already gone */ } }
  }

  // ---- Captures and one-shot queries (phases 3 and 4)

  async viewportOf(id: string): Promise<{ width: number; height: number; scroll: { x: number; y: number }; deviceScale: number }> {
    const contents = this.#contents(id)
    return await contents.executeJavaScript('({ width: window.innerWidth, height: window.innerHeight, scroll: { x: Math.round(window.scrollX), y: Math.round(window.scrollY) }, deviceScale: window.devicePixelRatio || 1 })', true) as { width: number; height: number; scroll: { x: number; y: number }; deviceScale: number }
  }

  /** A frame from a shown or hidden tab: a hidden one is captured without being brought forward, and shown briefly only if that gives nothing. */
  async #captureImage(id: string, rect?: Rectangle): Promise<Electron.NativeImage> {
    const contents = this.#contents(id)
    return rect ? contents.capturePage(rect) : contents.capturePage()
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

  /** The whole page through the debugger; the visible frame when the page refuses or the budget says no. */
  async captureFullPage(id: string): Promise<{ bytes: Uint8Array; width: number; height: number; complete: boolean }> {
    const contents = this.#contents(id)
    const attachedHere = !contents.debugger.isAttached()
    try {
      if (attachedHere) contents.debugger.attach('1.3')
      const metrics = await contents.debugger.sendCommand('Page.getLayoutMetrics') as { cssContentSize?: { width: number; height: number } }
      const size = metrics.cssContentSize ?? { width: 0, height: 0 }
      const viewport = await this.viewportOf(id)
      const plan = screenshotPlan(size.width, size.height, viewport.deviceScale)
      if (!plan.complete) throw new RangeError('Full page exceeds the screenshot budget')
      const result = await contents.debugger.sendCommand('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: size.width, height: size.height, scale: 1 } }) as { data: string }
      const bytes = Uint8Array.from(Buffer.from(result.data, 'base64'))
      return { bytes, width: plan.pixelSize.width, height: plan.pixelSize.height, complete: true }
    } catch {
      const frame = await this.capture(id)
      return { bytes: frame.bytes, width: frame.width, height: frame.height, complete: false }
    } finally {
      if (attachedHere && contents.debugger.isAttached()) { try { contents.debugger.detach() } catch { /* already detached */ } }
    }
  }

  /** A one-shot page query: runs once, returns bounded data, leaves nothing behind. */
  async query<T>(id: string, script: string): Promise<T> {
    return await this.#contents(id).executeJavaScript(script, true) as T
  }

  tab(id: string): PreviewTabRecord | null {
    return this.#model.get(id)
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
        case 'snapshot': {
          const page = await contents.executeJavaScript(snapshotScript(SNAPSHOT_LIMITS), true) as Record<string, unknown>
          const image = await this.#captureImage(tab.id)
          const size = image.getSize()
          return {
            ...page,
            consoleEntries: runtime.console.slice(-50),
            networkEntries: [],
            actionTimeline: runtime.actions.slice(-50),
            screenshot: { mimeType: 'image/png', data: image.toPNG().toString('base64'), width: size.width, height: size.height },
          }
        }
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
          if (serialized && serialized.length > MAX_RESULT_BYTES) throw new PreviewFailure('PreviewAutomationResultTooLargeError', 'The result is too large to return', { maximumBytes: MAX_RESULT_BYTES })
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
    let tab = request.tabId !== undefined ? this.#model.resolve(request.threadId, request.tabId) : input.reuseExistingTab === false ? null : this.#model.currentFor(request.threadId)
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
    const plain = target.replace(/^role=[a-z]+\[name=["']?([^"'\]]*)["']?\]$/i, '$1').replace(/^text=/, '')
    switch (action) {
      case 'open': case 'navigate': return 'opening a page'
      case 'snapshot': return 'reading the page'
      case 'click': return plain ? `clicking ${plain}` : 'clicking'
      case 'type': return plain ? `typing into ${plain}` : 'typing'
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
