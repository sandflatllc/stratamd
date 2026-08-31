import { join, dirname } from 'node:path'
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu } from 'electron'
import type { AppView, StrataApi } from '../shared/contracts'
import { createStrataApplication } from './application'
import { buildApplicationMenu } from './application-menu'
import { logError, logWarn } from './log'
import { isAllowedExternalUrl, openExternalUrl, registerStrataIpc, spellingContext, type RegisteredIpc } from './ipc'
import { IPC } from '../preload/channels'
import { documentPathsFromArgv } from './session'
import { APP_HOST, installAppProtocol, installLocalImageProtocol, registerPrivilegedSchemes } from './protocols'
import { createCommandSocketServer, type CommandSocketServer } from './socket'
import type { SocketCommandHandler } from '../cli/protocol'

export interface MainApplication extends StrataApi {
  commandHandler?(): SocketCommandHandler
  recheckFocused?(): Promise<void>
  shutdown?(): Promise<void>
}

export interface StartMainOptions {
  api: MainApplication
  argv?: readonly string[]
  rendererRoot?: string
  preloadPath?: string
  devServerUrl?: string
}

registerPrivilegedSchemes()

/**
 * Finder opens arrive as `open-file` events, possibly before initialization
 * finishes (docs/plans/open/mac-plan.md §4.5). The listener must exist before
 * anything awaits, so bootstrap installs it synchronously; paths queue until
 * startStrataMain adopts them into the same path command opens use.
 */
const pendingOpenFiles: string[] = []
let openFileHandler: ((path: string) => void) | null = null

export function installOpenFileQueue(): void {
  app.on('open-file', (event, path) => {
    event.preventDefault()
    if (openFileHandler) openFileHandler(path)
    else pendingOpenFiles.push(path)
  })
}

function adoptOpenFileHandler(handler: (path: string) => void): void {
  openFileHandler = handler
  for (const path of pendingOpenFiles.splice(0)) handler(path)
}

/**
 * Failure recording and bounded recovery (docs/plans/completed/crash-hardening-plan.md §6).
 * Installed once at bootstrap, never under vitest.
 */
export function installFailureLogging(): void {
  process.on('uncaughtException', (error) => {
    // Main owns the socket, watchers, and save path; it must not limp on
    // unknown state. The write is synchronous, so the record lands first.
    logError('main', 'Uncaught exception', error)
    process.exit(1)
  })
  process.on('unhandledRejection', (reason) => {
    // Post-startup rejections come from operation handlers whose failures are
    // surfaced per call; record without killing a process that owns buffers.
    logError('main', 'Unhandled rejection', reason)
  })
  let lastRendererGone = 0
  app.on('render-process-gone', (_event, webContents, details) => {
    if (details.reason === 'clean-exit') return
    logError('renderer-process', `Renderer gone: ${details.reason} (exit ${details.exitCode})`)
    const window = BrowserWindow.fromWebContents(webContents)
    if (!window || window.isDestroyed()) return
    const now = Date.now()
    if (now - lastRendererGone > 60_000) {
      lastRendererGone = now
      webContents.reload()
      return
    }
    // A second loss inside a minute: stop retrying. The window object would
    // otherwise survive its dead renderer and ensureWindow would keep
    // returning it; destroyed, the next open or activate builds a fresh one.
    window.destroy()
  })
  app.on('child-process-gone', (_event, details) => {
    if (details.reason === 'clean-exit') return
    logWarn('child-process', `${details.type} gone: ${details.reason} (exit ${details.exitCode ?? 'unknown'})`)
  })
}

export async function startStrataMain(options: StartMainOptions): Promise<BrowserWindow | null> {
  const ownsInstance = app.requestSingleInstanceLock()
  if (!ownsInstance) {
    app.quit()
    return null
  }

  let mainWindow: BrowserWindow | null = null
  let registeredIpc: RegisteredIpc | null = null
  let unsubscribeState: (() => void) | null = null
  let commandServer: CommandSocketServer | null = null
  let windowCreation: Promise<BrowserWindow> | null = null
  const rendererRoot = options.rendererRoot ?? join(__dirname, '../renderer')
  const preloadPath = options.preloadPath ?? join(__dirname, '../preload/index.js')

  const openLaunchDocuments = async (argv: readonly string[], cwd?: string): Promise<void> => {
    for (const path of documentPathsFromArgv(argv, cwd)) await options.api.openDocument(path)
  }

  await app.whenReady()
  // Zoom is per pane in the renderer (PRD §6.9); the default menu's window
  // zoom roles must not exist. Linux keeps no menu; macOS gets the minimal one.
  Menu.setApplicationMenu(buildApplicationMenu())
  installAppProtocol({ rendererRoot, ...(options.devServerUrl ? { devServerUrl: options.devServerUrl } : {}) })
  installLocalImageProtocol({
    allowedRoots: async () => {
      const view = await options.api.getState()
      return imageRoots(view)
    }
  })

  const createWindow = async (): Promise<BrowserWindow> => {
    const initialState = await options.api.getState()
    const window = new BrowserWindow({
      width: 1440,
      height: 940,
      minWidth: 960,
      minHeight: 640,
      show: false,
      frame: true,
      backgroundColor: String(initialState.settings.theme.active.values['surfaces.window'] ?? '#0a0810'),
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        nodeIntegrationInSubFrames: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        webviewTag: false,
        // Electron's default, made explicit: the annotate menu's spelling
        // column depends on it (docs/plans/completed/spellcheck-plan.md).
        spellcheck: true
      }
    })

    hardenWindow(window)
    window.webContents.on('console-message', (message) => {
      // Renderer console errors finally land somewhere (plan §6). Report
      // producers never console.error, so this cannot duplicate §7 reports.
      if (message.level === 'error') logError('renderer-console', `${message.message} (${message.sourceId}:${message.lineNumber})`)
      else if (message.level === 'warning') logWarn('renderer-console', `${message.message} (${message.sourceId}:${message.lineNumber})`)
    })
    window.webContents.setVisualZoomLevelLimits(1, 1).catch(() => undefined)
    // Suggestions exist only in this event; the renderer shows them in the
    // annotate menu (docs/plans/completed/spellcheck-plan.md). No native menu opens.
    window.webContents.on('context-menu', (_event, params) => {
      const spelling = spellingContext(params)
      if (spelling) window.webContents.send(IPC.spelling, spelling)
    })
    registeredIpc?.dispose()
    unsubscribeState?.()
    registeredIpc = registerStrataIpc({
      ipcMain,
      api: options.api,
      renderer: window.webContents,
      allowedRendererUrls: [`app://${APP_HOST}/`]
    })
    let pageBackground = String(initialState.settings.theme.active.values['surfaces.window'] ?? '')
    unsubscribeState = options.api.subscribe((state) => {
      registeredIpc?.publish(state)
      const next = String(state.settings.theme.active.values['surfaces.window'] ?? '')
      if (next && next !== pageBackground) {
        pageBackground = next
        window.setBackgroundColor(next)
      }
    })
    window.once('ready-to-show', () => window.show())
    window.on('focus', () => {
      if ('recheckFocused' in options.api && typeof options.api.recheckFocused === 'function') {
        void options.api.recheckFocused()
      }
      void options.api.getState().then((state) => registeredIpc?.publish(state))
    })
    window.on('closed', () => {
      if (mainWindow === window) mainWindow = null
      registeredIpc?.dispose()
      registeredIpc = null
      unsubscribeState?.()
      unsubscribeState = null
    })
    await window.loadURL(`app://${APP_HOST}/`)
    return window
  }

  const ensureWindow = async (): Promise<BrowserWindow> => {
    if (mainWindow && !mainWindow.isDestroyed()) return mainWindow
    if (!windowCreation) {
      windowCreation = createWindow()
        .then((window) => {
          mainWindow = window
          return window
        })
        .finally(() => {
          windowCreation = null
        })
    }
    return windowCreation
  }

  const showAndFocus = async (): Promise<void> => {
    const window = await ensureWindow()
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  }

  app.on('window-all-closed', () => {
    // The socket and durable attachments remain active without a visible window.
  })
  app.on('second-instance', (_event, argv, workingDirectory) => {
    void openLaunchDocuments(argv, workingDirectory).then(showAndFocus)
  })

  if (options.api.commandHandler) {
    const handleCommand = options.api.commandHandler()
    commandServer = await createCommandSocketServer({
      handler: async (request, context) => {
        const response = await handleCommand(request, context)
        // The CLI returns once the session exists; painting the replacement
        // window continues independently as required by the agent contract.
        if (request.command === 'open') void showAndFocus()
        return response
      }
    })
  }

  mainWindow = await ensureWindow()
  await openLaunchDocuments(options.argv ?? process.argv.slice(1))
  adoptOpenFileHandler((path) => {
    void options.api.openDocument(path).then(showAndFocus)
  })

  app.on('activate', () => {
    void showAndFocus()
  })
  app.on('before-quit', () => {
    registeredIpc?.dispose()
    unsubscribeState?.()
    if (commandServer) void commandServer.close()
    if (options.api.shutdown) void options.api.shutdown()
  })
  return mainWindow
}

export function hardenWindow(window: BrowserWindow, openExternal = openExternalUrl): void {
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) void openExternal(url).catch(() => undefined)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    // The crash card recovers with location.reload(); navigation within the
    // app's own origin stays allowed, everything else is denied as before.
    if (url.startsWith(`app://${APP_HOST}/`)) return
    event.preventDefault()
    if (isAllowedExternalUrl(url)) void openExternal(url).catch(() => undefined)
  })
  window.webContents.on('will-attach-webview', (event) => event.preventDefault())
  window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  window.webContents.session.setPermissionCheckHandler(() => false)
}

function imageRoots(view: AppView): string[] {
  const roots = view.explorer.map((folder) => folder.path)
  if (view.activeDocument) roots.push(dirname(view.activeDocument.path))
  return [...new Set(roots)]
}

if (!process.env.VITEST) {
  installFailureLogging()
  installOpenFileQueue()
  void createStrataApplication({
    clipboardWrite: async (text) => clipboard.writeText(text),
    selectFolder: async () => {
      const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
      return result.canceled ? null : (result.filePaths[0] ?? null)
    }
  }).then((api) => startStrataMain({
      api,
      ...(process.env.ELECTRON_RENDERER_URL ? { devServerUrl: process.env.ELECTRON_RENDERER_URL } : {})
    }))
    .catch((error: unknown) => {
      // Without this terminal catch an initialization failure leaves a
      // headless, unusable process alive (plan §6). The log write is
      // synchronous, so the record is durable before exit.
      logError('main', 'Startup failed', error)
      app.exit(1)
    })
}
