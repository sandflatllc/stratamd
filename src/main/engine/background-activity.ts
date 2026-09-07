import { COMMENT_COMPOSER_TITLE } from '../visual-comment-image'
import { subscribePreviewOwnerInput } from '../preview/owner-input'
import { isDarwin } from '../../platform/runtime'
import { app, BrowserWindow, powerMonitor } from 'electron'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import type { EngineSettings } from '../../shared/contracts'
import { isSettingsRecord, type EngineActivity } from '../../shared/engine-settings'

const execute = promisify(execFile)
/** Official t3 0.0.38 host-poll defaults. Explicit overrides apply only to its custom profile. */
export function hostPollInterval(settings: EngineSettings, active: boolean): number {
  const value = isSettingsRecord(settings.backgroundActivity) ? settings.backgroundActivity : {}
  const profile = value.profile === 'custom' ? value.baseProfile : value.profile
  const fallback = active ? profile === 'battery-saver' ? 60000 : 30000 : profile === 'performance' ? 120000 : profile === 'battery-saver' ? 600000 : 300000
  const overrides = value.profile === 'custom' && isSettingsRecord(value.overrides) ? value.overrides : {}
  const custom = overrides[active ? 'hostPowerMonitorActiveInterval' : 'hostPowerMonitorIdleInterval']
  return typeof custom === 'number' && custom >= 0 ? custom === 0 ? Infinity : custom : fallback
}
async function lowPowerState(): Promise<'true' | 'false' | 'unknown'> {
  try {
    if (isDarwin()) {
      const { stdout } = await execute('/usr/bin/pmset', ['-g'], { timeout: 2000, maxBuffer: 32000 })
      const value = stdout.match(/\blowpowermode\s+([01])\b/)
      return value ? value[1] === '1' ? 'true' : 'false' : 'unknown'
    }
    const { stdout } = await execute('powerprofilesctl', ['get'], { timeout: 2000, maxBuffer: 32000 })
    return stdout.trim() === 'power-saver' ? 'true' : ['balanced', 'performance'].includes(stdout.trim()) ? 'false' : 'unknown'
  } catch { return 'unknown' }
}
export function installEngineActivity(api: { readEngineSettings(): Promise<EngineSettings>; reportEngineActivity?(activity: EngineActivity): Promise<void>; subscribe(listener: (view: import('../../shared/contracts').AppView) => void): () => void }): () => void {
  if (!api.reportEngineActivity) return () => undefined
  const clientId = `strata-${randomUUID()}`
  let disposed = false, running = false, requested = true, lastInput = Date.now(), suspended = false
  let locked: EngineActivity['hostPower']['locked'] = 'unknown'
  let nextSample = 0, previousInterval = 0
  let host: EngineActivity['hostPower'] = { source: 'electron-main', idle: 'unknown', idleSeconds: null, locked, suspended, onBattery: 'unknown', lowPowerMode: 'unknown', thermalState: 'unknown', stale: true, updatedAt: new Date().toISOString() }
  const listeners: Array<() => void> = [subscribePreviewOwnerInput(() => { lastInput = Date.now() })]
  const timer = setInterval(() => void report(), 30000)
  timer.unref()
  async function report(force = false): Promise<void> {
    if (disposed) return
    requested ||= force
    if (running) return
    running = true
    try {
      const windows = BrowserWindow.getAllWindows().filter(window => !window.isDestroyed())
      const visible = windows.some(window => window.isVisible() && !window.isMinimized())
      const focused = windows.some(window => window.isFocused())
      const settings = await api.readEngineSettings().catch(() => ({ providerInstances: {} }))
      const interval = hostPollInterval(settings, focused)
      if (interval !== previousInterval) { nextSample = 0; previousInterval = interval }
      if (requested || Date.now() >= nextSample) {
        requested = false
        const idle = powerMonitor.getSystemIdleState(60)
        host = { source: 'electron-main', idle: idle === 'unknown' ? 'unknown' : idle === 'active' ? 'false' : 'true', idleSeconds: powerMonitor.getSystemIdleTime(), locked: locked === 'unknown' ? idle === 'locked' ? 'true' : 'unknown' : locked, suspended, onBattery: powerMonitor.isOnBatteryPower() ? 'true' : 'false', lowPowerMode: await lowPowerState(), thermalState: isDarwin() ? powerMonitor.getCurrentThermalState() : 'unknown', stale: false, updatedAt: new Date().toISOString() }
        nextSample = Date.now() + interval
      }
      if (!disposed) await api.reportEngineActivity!({ clientId, visible, focused, recentlyInteracted: Date.now() - lastInput < 60000, hostPower: { ...host, suspended, locked: locked === 'unknown' ? host.locked : locked } })
    } catch { /* Power reporting is optional; it cannot block the editor or engine. */ } finally { running = false; if (requested && !disposed) void report() }
  }
  const bindWindow = (window: BrowserWindow) => {
    // The hidden comment-sheet composer is not the owner's window; its close is not their input.
    if (window.getTitle() === COMMENT_COMPOSER_TITLE) return
    const changed = () => { lastInput = Date.now(); void report(true) }
    const input = () => { lastInput = Date.now() }
    const emitter: NodeJS.EventEmitter = window
    for (const event of ['focus', 'blur', 'show', 'hide', 'minimize', 'restore', 'closed'] as const) { emitter.on(event, changed); listeners.push(() => { if (!window.isDestroyed()) emitter.removeListener(event, changed) }) }
    const contents = window.webContents
    contents.on('before-input-event', input)
    contents.on('before-mouse-event', input)
    listeners.push(() => { if (!contents.isDestroyed()) { contents.removeListener('before-input-event', input); contents.removeListener('before-mouse-event', input) } })
  }
  for (const window of BrowserWindow.getAllWindows()) bindWindow(window)
  const created = (_event: Electron.Event, window: BrowserWindow) => bindWindow(window)
  app.on('browser-window-created', created)
  listeners.push(() => app.removeListener('browser-window-created', created))
  const powerEvents: NodeJS.EventEmitter = powerMonitor
  for (const event of ['on-ac', 'on-battery', 'suspend', 'resume', 'lock-screen', 'unlock-screen', 'thermal-state-change'] as const) {
    const changed = () => { if (event === 'suspend') suspended = true; if (event === 'resume') suspended = false; if (event === 'lock-screen') locked = 'true'; if (event === 'unlock-screen') locked = 'false'; void report(true) }
    powerEvents.on(event, changed)
    listeners.push(() => powerEvents.removeListener(event, changed))
  }
  let connection = ''
  listeners.push(api.subscribe(view => { const next = `${view.engine.identity}:${view.engine.state}`; if (next !== connection) { connection = next; void report(true) } }))
  void report(true)
  return () => { disposed = true; clearInterval(timer); for (const remove of listeners) remove() }
}
