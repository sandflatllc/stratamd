import { expect, test as base } from './test'
import { withManagedScenario } from './managed-test'
import { IPC } from '../../src/preload/channels'
import type { ComputerRequest } from '../../src/shared/computer'

const test = withManagedScenario(base)

test('Settings guides account authorization, download consent and device handoff while cloud readiness arrives later @managed', async ({ runningScenario: scenario }, testInfo) => {
  test.skip(!process.env.STRATAMD_ENGINE_BUNDLE, 'Requires the stock runtime')
  const page = scenario.page!
  const initial = await page.evaluate(() => window.strata.computer!({ action: 'status' }))
  // Only this disposable app's IPC is substituted. Backend command/installer behavior has separate coverage.
  await scenario.app!.evaluate(({ ipcMain }, { initial, channels }) => {
    let view = { ...initial, environmentName: 'Test workstation' }, polls = 0
    let wanted = { remote: true, publish: false }
    ipcMain.removeHandler(channels.openExternal)
    ipcMain.handle(channels.openExternal, () => undefined)
    ipcMain.removeHandler(channels.computer)
    ipcMain.handle(channels.computer, (_event, request: ComputerRequest) => {
      if (request.action === 'login') view = { ...view, job: { state: 'running', phase: 'browser', message: 'Finish signing in in your browser.', url: 'https://app.t3.codes/connect?test=ui' } }
      if (request.action === 'use-code') view = { ...view, job: { state: 'running', phase: 'code', message: 'Paste the authorization code from your browser.', url: 'https://app.t3.codes/connect?test=code' } }
      if (request.action === 'input') {
        if (request.text !== 'test-code') throw new Error('Wrong test authorization code')
        view = { ...view, account: 'test@example.com', connect: { ...view.connect!, authenticated: true }, job: { state: 'done', message: 'Signed in to T3.' }, connectionState: 'off', connectionMessage: 'Signed in to T3. Remote access is off.' }
      }
      if (request.action === 'configure') { wanted = request; view = { ...view, job: { state: 'running', phase: 'download', message: 'T3 needs connection support.' } } }
      if (request.action === 'download') {
        view = { ...view, connect: { ...view.connect!, desired: true, publishAgentActivity: wanted.publish }, job: { state: 'done', message: 'Your connection choices are saved.' }, connectionState: 'starting', connectionMessage: 'Starting the T3 connection.' }
      }
      if (request.action === 'progress' && view.connectionState === 'starting' && ++polls >= 2) view = { ...view, remoteEnabled: wanted.remote, connect: { ...view.connect!, linked: true }, connectionState: 'configured', connectionMessage: 'Remote access is configured. Connect your phone to check that it works.' }
      return view
    })
  }, { initial, channels: { computer: IPC.computer, openExternal: IPC.openExternal } })
  await page.getByRole('button', { name: 'StrataMD menu' }).click()
  await page.getByRole('menuitem', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'Connections', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Connections', exact: true })
  await expect(dialog.getByRole('button', { name: 'Sign in to T3', exact: true })).toBeInViewport()
  await expect(dialog.getByTestId('engine-server')).toBeHidden()
  await dialog.getByRole('button', { name: 'Sign in to T3', exact: true }).click()
  await expect(dialog.getByRole('button', { name: 'Open browser again', exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: 'Use an authorization code instead' }).click()
  await dialog.getByRole('textbox', { name: 'Authorization code', exact: true }).fill('test-code')
  await dialog.getByRole('button', { name: 'Continue', exact: true }).click()
  await expect(dialog.getByText('T3 account: test@example.com', { exact: true })).toBeVisible()
  await dialog.getByRole('switch', { name: 'Mobile notifications', exact: true }).check()
  await dialog.getByRole('button', { name: 'Enable access and continue', exact: true }).click()
  await dialog.getByRole('button', { name: 'Download and continue', exact: true }).click()
  await expect(dialog.getByTestId('remote-connection-status')).toContainText('Remote access is configured', { timeout: 8000 })
  await expect(dialog.getByRole('switch', { name: 'Mobile notifications', exact: true })).toBeChecked()
  await expect(dialog.getByRole('region', { name: 'Connect your device', exact: true })).toContainText('Test workstation')
  await expect(dialog.getByRole('region', { name: 'Connect your device', exact: true })).toContainText('same T3 account')
  await expect(dialog.locator('pre')).toHaveCount(0)
  for (const [width, height] of [[1440, 1000], [1024, 700]]) {
    await scenario.app!.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]!.setSize(size.width, size.height), { width: width!, height: height! })
    await dialog.getByTestId('remote-connection-status').scrollIntoViewIfNeeded()
    expect(await dialog.locator('.setup-dialog-body').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath(`connected-${width}.png`), animations: 'disabled' })
  }
})
