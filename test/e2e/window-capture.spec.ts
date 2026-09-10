import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { expect, test } from './test'
import { seededScenario, startEngine } from './cockpit-engine-harness'
import { openAppMenu } from './harness'
import { openThread } from './cockpit-agent'

async function isolatedBus(env: Record<string, string>): Promise<ChildProcess> {
  const registryPath = ['/usr/libexec/at-spi2-registryd', '/usr/lib/at-spi2-registryd'].find(path => existsSync(path))
  if (!registryPath) throw new Error('Window capture tests require the at-spi2-core accessibility registry')
  const bus = spawn('dbus-daemon', ['--session', '--nofork', '--print-address=1'], { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const address = await new Promise<string>((resolve, reject) => { bus.once('error', reject); bus.stdout!.once('data', data => resolve(String(data).trim())) })
  env.DBUS_SESSION_BUS_ADDRESS = address
  const result = execFileSync('gdbus', ['call', '--session', '--dest', 'org.a11y.Bus', '--object-path', '/org/a11y/bus', '--method', 'org.a11y.Bus.GetAddress'], { env, encoding: 'utf8' })
  const accessibilityAddress = /'([^']+)'/.exec(result)![1]!
  const registry = spawn(registryPath, [], { env, stdio: 'ignore' })
  bus.once('exit', () => registry.kill())
  await expect.poll(() => { try { return execFileSync('gdbus', ['call', '--address', accessibilityAddress, '--dest', 'org.freedesktop.DBus', '--object-path', '/org/freedesktop/DBus', '--method', 'org.freedesktop.DBus.NameHasOwner', 'org.a11y.atspi.Registry'], { env, encoding: 'utf8' }).includes('true') } catch { return false } }).toBe(true)
  return bus
}
function stopBus(bus: ChildProcess) { if (bus.pid) { try { process.kill(-bus.pid, 'SIGTERM') } catch { /* already exited */ } } }

test('native selected window is reviewed, privately held, and only delivered on Send', async ({}, testInfo) => {
  test.skip(process.platform !== 'linux', 'X11/AT-SPI native proof runs on Linux')
  const engine = await startEngine({ pendingRequests: false })
  engine.complete()
  const scenario = await seededScenario(testInfo, engine.origin)
  const bus = await isolatedBus(scenario.env)
  try {
    await scenario.writeSettings({ theme: 'strata-night' })
    const page = await scenario.launchEmpty()
    await page.setViewportSize({ width: 1440, height: 1000 })
    await openThread(page, 'Live engine thread')
    const fixtureId = await scenario.app!.evaluate(async ({ BrowserWindow }) => {
      const fixture = new BrowserWindow({ width: 838, height: 815, title: 'Inspection page', webPreferences: { contextIsolation: true, sandbox: true } })
      await fixture.loadURL('data:text/html,' + encodeURIComponent('<title>Inspection page</title><body style="margin:0;background:#f4f5f8;color:#243047;font:20px sans-serif;padding:48px"><h1>Inspection page</h1><p>A synthetic window for native capture verification.</p><button>Review the current change</button><div style="margin-top:40px;background:#758eb3;height:320px;border-radius:16px"></div></body>'))
      fixture.show()
      return fixture.getNativeWindowHandle().readUInt32LE(0)
    })
    // Xvfb has no WM to set ICCCM NormalState. Mark only our synthetic window;
    // Chromium otherwise correctly treats it as withdrawn and excludes it.
    if (process.platform === 'linux') execFileSync('xprop', ['-id', String(fixtureId), '-f', 'WM_STATE', '32c', '-set', 'WM_STATE', '1, 0'], { env: scenario.env })
    await page.bringToFront()
    await openAppMenu(page); await page.getByRole('menuitem', { name: 'Settings', exact: true }).click()
    await page.getByRole('button', { name: 'Capture a window', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Window capture', exact: true })
    await dialog.getByRole('checkbox', { name: 'Enable window capture', exact: true }).check()
    await expect(dialog.getByRole('button', { name: 'Capture a window', exact: true })).toBeEnabled()
    await page.screenshot({ path: testInfo.outputPath('capture-setup.png'), animations: 'disabled' })
    await dialog.getByRole('button', { name: 'Capture a window', exact: true }).click()
    const source = dialog.getByRole('button', { name: /Inspection page/ })
    await expect(source).toBeVisible(); await source.click()
    await page.screenshot({ path: testInfo.outputPath('capture-choose.png'), animations: 'disabled' })
    await dialog.getByRole('button', { name: 'Review capture', exact: true }).click()
    const review = page.getByRole('dialog', { name: 'Mark up the image' })
    await expect(review).toBeVisible()
    await expect(review).toContainText('Inspection page')
    const surface = review.locator('.visual-surface')
    await surface.hover()
    const box = (await surface.boundingBox())!
    await page.mouse.move(box.x + 40, box.y + 100); await page.mouse.down(); await page.mouse.move(box.x + 220, box.y + 180); await page.mouse.up()
    await expect(review.getByRole('button', { name: 'Select Region 1', exact: true })).toBeVisible()
    await review.getByRole('textbox', { name: 'Visual comment' }).fill('Move this action beside the heading.')
    await review.getByRole('button', { name: 'Hold', exact: true }).hover()
    await page.screenshot({ path: testInfo.outputPath('capture-review.png'), animations: 'disabled' })
    if (await review.getByText('Screenshot only. This app did not provide readable text.').isVisible()) await page.screenshot({ path: testInfo.outputPath('capture-screenshot-only.png'), animations: 'disabled' })
    expect(engine.commands.filter(command => command.type === 'thread.turn.start')).toHaveLength(0)
    await review.getByRole('button', { name: 'Hold', exact: true }).click()
    await expect(review).toBeHidden()
    const held = await page.evaluate(async () => (await window.strata.getState()).engine.projects.flatMap(project => project.visualComments ?? []))
    expect(held[0]?.place).toBe('Window capture · 838 × 815')
    expect(held[0]?.draft?.marks).toHaveLength(1)
    const bytes = await readFile(join(scenario.env.XDG_DATA_HOME!, 'stratamd', 'visual-evidence', `${held[0]!.captures[0]!.id}.bin`))
    await writeFile(testInfo.outputPath('native-window.png'), bytes)
    expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137,80,78,71,13,10,26,10]))
    expect(held[0]?.anchor).toMatchObject({ kind: 'image', windowCapture: { title: 'Inspection page' } })
    expect(engine.commands.filter(command => command.type === 'thread.turn.start')).toHaveLength(0)
    await expect(page.getByRole('button', { name: 'Review', exact: true })).toBeVisible()
    await page.getByRole('textbox', { name: 'Message conversation' }).filter({ visible: true }).fill('Please review this window.')
    await page.screenshot({ path: testInfo.outputPath('capture-held.png'), animations: 'disabled' })
    const composer = page.getByRole('textbox', { name: 'Message conversation' }).filter({ visible: true })
    await composer.fill('Please review this window.'); await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect.poll(() => engine.commands.filter(command => command.type === 'thread.turn.start').length).toBe(1)
    const message = engine.commands.find(command => command.type === 'thread.turn.start')!.message as { text: string; attachments: unknown[] }
    expect(message.text).toContain('"windowCapture"'); expect(message.text).toContain('Inspection page'); expect(message.attachments).toHaveLength(1)

  } finally { await scenario.stop(); await engine.close(); stopBus(bus) }
})

test('native accessibility belongs to the selected GTK window and survives a held revision', async ({}, testInfo) => {
  test.skip(process.platform !== 'linux', 'GTK/AT-SPI native proof runs on Linux')
  const engine = await startEngine({ pendingRequests: false })
  engine.complete()
  const scenario = await seededScenario(testInfo, engine.origin)
  const bus = await isolatedBus(scenario.env)
  let fixture: ChildProcess | undefined
  try {
    await scenario.writeSettings({ theme: 'strata-night', windowCapture: { enabled: true, shortcut: false } })
    const page = await scenario.launchEmpty()
    await openThread(page, 'Live engine thread')
    fixture = spawn('/usr/bin/python3', ['-c', `import gi\ngi.require_version('Gtk','3.0')\ngi.require_version('GdkX11','3.0')\nfrom gi.repository import Gtk,GdkX11,GLib\nGLib.set_prgname('Inspection app')\nGLib.set_application_name('Inspection app')\nw=Gtk.Window(title='Accessible inspection')\nw.set_default_size(838,815)\nb=Gtk.Box(orientation=Gtk.Orientation.VERTICAL)\nb.pack_start(Gtk.Label(label='Selected-window accessibility proof'),False,False,20)\nb.pack_start(Gtk.Button(label='Review this selected window'),False,False,20)\nw.add(b)\nw.show_all()\nprint(w.get_window().get_xid(),flush=True)\nGtk.main()`], { env: { ...scenario.env, NO_AT_BRIDGE: '0' }, stdio: ['ignore', 'pipe', 'pipe'] })
    const id = await new Promise<string>((resolve, reject) => { fixture!.once('error', reject); fixture!.stdout!.once('data', data => resolve(String(data).trim())) })
    execFileSync('xprop', ['-id', id, '-f', 'WM_STATE', '32c', '-set', 'WM_STATE', '1, 0'], { env: scenario.env })
    await page.setViewportSize({ width: 1440, height: 1000 })
    await openAppMenu(page); await page.getByRole('menuitem', { name: 'Settings', exact: true }).click()
    await page.getByRole('button', { name: 'Capture a window', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Window capture', exact: true })
    await dialog.getByRole('button', { name: 'Capture a window', exact: true }).click()
    await dialog.getByRole('button', { name: /Accessible inspection/ }).click()
    await dialog.getByRole('button', { name: 'Review capture', exact: true }).click()
    const review = page.getByRole('dialog', { name: 'Mark up the image' })
    await expect(review).toBeVisible()
    const surface = review.locator('.visual-surface')
    await surface.hover()
    const box = (await surface.boundingBox())!
    await page.mouse.move(box.x + 40, box.y + 100); await page.mouse.down(); await page.mouse.move(box.x + 220, box.y + 180); await page.mouse.up()
    await expect(review.getByRole('button', { name: 'Select Region 1', exact: true })).toBeVisible()
    await expect(review.getByText(/Screenshot only/)).toHaveCount(0)
    await review.getByRole('textbox', { name: 'Visual comment' }).fill('Move this action beside the heading.')
    await review.getByRole('button', { name: 'Hold', exact: true }).hover()
    await page.screenshot({ path: testInfo.outputPath('capture-review.png'), animations: 'disabled' })
    await review.getByRole('button', { name: 'Hold', exact: true }).click()
    await expect(review).toBeHidden()
    const held = await page.evaluate(async () => (await window.strata.getState()).engine.projects.flatMap(project => project.visualComments ?? []))
    const context = held[0]?.anchor.kind === 'image' ? held[0].anchor.windowCapture : null
    await writeFile(testInfo.outputPath('native-accessibility.json'), JSON.stringify(context, null, 2))
    expect(context?.processId).toBe(fixture.pid)
    expect(context?.accessibilityText).toContain('Selected-window accessibility proof')
    expect(context?.textStatus).toBe('available')
    expect(engine.commands.filter(command => command.type === 'thread.turn.start')).toHaveLength(0)
  } finally { fixture?.kill(); await scenario.stop(); await engine.close(); stopBus(bus) }
})

test('Mac permission state uses the real capture dialog and names the separate optional accessibility grant', async ({}, testInfo) => {
  const engine = await startEngine({ pendingRequests: false })
  engine.complete()
  const scenario = await seededScenario(testInfo, engine.origin)
  try {
    await scenario.writeSettings({ theme: 'strata-night' })
    const page = await scenario.launchEmpty()
    await page.setViewportSize({ width: 1440, height: 1000 })
    // Visual contract only. macOS native permission requests remain unrun on Linux.
    await scenario.app!.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('strata:window-capture')
      ipcMain.handle('strata:window-capture', () => ({ status: { platform: 'darwin', picker: 'windows', screenPermission: 'denied', accessibilityPermission: false, shortcut: 'disabled' } }))
    })
    await openAppMenu(page); await page.getByRole('menuitem', { name: 'Settings', exact: true }).click()
    await page.getByRole('button', { name: 'Capture a window', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Window capture', exact: true })
    await expect(dialog.getByRole('heading', { name: 'Allow screen recording on your Mac' })).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Open System Settings', exact: true })).toBeVisible()
    await expect(dialog).toContainText('Accessibility is optional')
    await page.screenshot({ path: testInfo.outputPath('capture-mac-permission.png'), animations: 'disabled' })
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    expect(engine.commands.filter(command => command.type === 'thread.turn.start')).toHaveLength(0)
  } finally { await scenario.stop(); await engine.close() }
})
