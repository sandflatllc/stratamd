import { windowCapturePlatform } from '../../platform/window-capture'
import { globalShortcut, desktopCapturer, nativeImage, systemPreferences, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { execFile, fork } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CaptureSource, CaptureStatus, WindowCaptureContext } from '../../shared/window-capture'
const exec = promisify(execFile)
const capturePlatform = windowCapturePlatform()
const pending = new Map<string, { id: string; name: string; png: Buffer; expires: number }>()
let shortcutStatus: CaptureStatus['shortcut'] = 'disabled'
const accelerator = 'CommandOrControl+Shift+5'
export function configureCaptureShortcut(enabled: boolean, callback: () => void): void {
  if (enabled && shortcutStatus !== 'disabled') return
  if (!enabled) { if (shortcutStatus === 'registered') globalShortcut.unregister(accelerator); shortcutStatus = 'disabled'; return }
  shortcutStatus = globalShortcut.register(accelerator, callback) ? 'registered' : 'conflict'
}
export function captureStatus(): CaptureStatus {
  return {
    shortcut: shortcutStatus,
    platform: capturePlatform.platform,
    picker: capturePlatform.picker,
    screenPermission: capturePlatform.macPermissions ? systemPreferences.getMediaAccessStatus('screen') : 'system-picker',
    accessibilityPermission: !capturePlatform.macPermissions || systemPreferences.isTrustedAccessibilityClient(false),
  }
}
export async function openCaptureSettings(kind: 'screen-settings' | 'accessibility-settings'): Promise<void> {
  if (!capturePlatform.macPermissions) throw new Error('Screen permissions are managed by your system picker.')
  await shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${kind === 'screen-settings' ? 'Privacy_ScreenCapture' : 'Privacy_Accessibility'}`)
}
let expiry: ReturnType<typeof setTimeout> | undefined
export async function chooseWindows(): Promise<CaptureSource[]> {
  pending.clear()
  if (expiry) clearTimeout(expiry)
  expiry = setTimeout(() => pending.clear(), 120_000)
  expiry.unref()
  const status = captureStatus()
  if (status.platform === 'unsupported') throw new Error('Window capture is available on Linux and macOS.')
  if (['denied', 'restricted'].includes(status.screenPermission)) throw new Error('Allow Strata in Screen Recording, then restart Strata.')
  // PipeWire opens the native picker and returns its selected source. On X11 and
  // macOS Electron enumerates window thumbnails for Strata's explicit chooser.
  const sources = await desktopCapturer.getSources({ types: status.picker === 'system' ? ['window', 'screen'] : ['window'], thumbnailSize: { width: 2560, height: 1600 }, fetchWindowIcons: false })
  let retainedBytes = 0
  return sources.filter(source => !source.thumbnail.isEmpty()).slice(0, 100).map(source => {
    const token = randomUUID()
    const png = source.thumbnail.toPNG()
    retainedBytes += png.byteLength
    if (retainedBytes > 64 * 1024 * 1024) return null
    pending.set(token, { id: source.id, name: source.name.slice(0, 1024), png, expires: Date.now() + 120_000 })
    return { token, name: source.name || 'Selected window', thumbnail: source.thumbnail.resize({ width: 320 }).toDataURL() }
  }).filter(source => source !== null)
}
async function accessibility(pid: number, title: string, bounds: { x: number; y: number; width: number; height: number }): Promise<{ text: string; app: string | null }> {
  return new Promise(resolve => {
    const worker = fork(join(__dirname, 'accessibility-worker.js'), [], { execPath: process.execPath, execArgv: [], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
    let done = false
    const finish = (result = { text: '', app: null as string | null }) => { if (done) return; done = true; clearTimeout(timer); worker.kill(); resolve(result) }
    const timer = setTimeout(() => finish(), 4_000)
    worker.once('error', () => finish()); worker.once('exit', () => finish())
    worker.once('message', (value: unknown) => {
      const result = value as { text?: unknown; app?: unknown }
      finish({ text: typeof result.text === 'string' ? result.text.slice(0, 16_000) : '', app: typeof result.app === 'string' ? result.app.slice(0, 512) : null })
    })
    worker.send({ pid, title, bounds }, error => { if (error) finish() })
  })
}
export async function captureWindow(token: string): Promise<{ bytes: Uint8Array; width: number; height: number; context: WindowCaptureContext }> {
  const source = pending.get(token)
  pending.clear()
  if (expiry) clearTimeout(expiry)
  if (!source || source.expires < Date.now()) throw new Error('This window selection expired. Choose a window again.')
  const numericId = /^window:(\d+):/.exec(source.id)?.[1]
  let bounds: { x: number; y: number; width: number; height: number } | null = null
  let bytes = source.png, pid: number | null = null, appName: string | null = null
  if (capturePlatform.windowIdentity === 'core-graphics' && numericId) {
    // Selected CGWindowNumber, not whichever app acquired focus after the picker.
    // Adapted from T3 Code ActiveWindow.ts and MacSnapShot.ts (MIT; see LICENSE).
    const script = `ObjC.import('CoreGraphics'); ObjC.import('AppKit'); var ws=ObjC.deepUnwrap($.CGWindowListCopyWindowInfo(17,0)); var w=ws.find(w=>w.kCGWindowNumber===${Number(numericId)}); JSON.stringify(w ? {pid:w.kCGWindowOwnerPID,name:w.kCGWindowOwnerName,bounds:w.kCGWindowBounds} : null)`
    const lookup = await exec('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script], { timeout: 5_000, maxBuffer: 64 * 1024 })
    const identity = JSON.parse(lookup.stdout) as { pid: number; name: string; bounds: { X: number; Y: number; Width: number; Height: number } } | null
    if (!identity) throw new Error('The selected window closed. Choose a window again.')
    pid = identity.pid; appName = identity.name
    bounds = { x: identity.bounds.X, y: identity.bounds.Y, width: identity.bounds.Width, height: identity.bounds.Height }
    const dir = await mkdtemp(join(tmpdir(), 'strata-window-'))
    try {
      const path = join(dir, 'capture.png')
      await exec('/usr/sbin/screencapture', ['-l', numericId, '-o', '-x', '-t', 'png', path], { timeout: 15_000 })
      bytes = await readFile(path)
    } finally { await rm(dir, { recursive: true, force: true }) }
  } else if (capturePlatform.windowIdentity === 'x11' && numericId) {
    try {
      const result = await exec(join(__dirname, 'capture-x11'), [numericId], { timeout: 2_000, maxBuffer: 64 * 1024 })
      const identity = JSON.parse(result.stdout) as { pid: number; app: string; bounds: { x: number; y: number; width: number; height: number } }
      pid = identity.pid > 0 ? identity.pid : null
      appName = identity.app || null
      if (Object.values(identity.bounds).every(Number.isFinite) && identity.bounds.width > 0 && identity.bounds.height > 0) bounds = identity.bounds
    } catch { /* Missing X11 identity support must not lose the selected image. */ }
  }
  if (bytes.byteLength > 32 * 1024 * 1024 || !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error('The selected window did not produce a valid PNG.')
  let image = nativeImage.createFromBuffer(bytes)
  if (image.isEmpty()) throw new Error('The selected window did not produce an image.')
  const size = image.getSize(), scale = Math.min(1, 2560 / size.width, 1600 / size.height, ...(capturePlatform.constrainToWindowBounds && bounds ? [bounds.width / size.width, bounds.height / size.height] : []))
  if (scale < 1) image = image.resize({ width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)) })
  const allowed = captureStatus().accessibilityPermission
  const text = allowed && pid && bounds ? await accessibility(pid, source.name, bounds) : { text: '', app: null }
  return { bytes: image.toPNG(), ...image.getSize(), context: { selection: captureStatus().picker === 'system' ? 'system-source' : 'window', title: source.name || 'Selected window', app: appName ?? text.app, windowId: captureStatus().picker === 'system' ? null : numericId ?? null, processId: pid, accessibilityText: text.text || null, textStatus: text.text ? 'available' : allowed ? 'unavailable' : 'permission-required' } }
}
