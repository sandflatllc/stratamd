import { expect, test } from '@playwright/test'
import { readFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { openAppMenu, projectRoot, Scenario, setSource } from './harness'
import { seededScenario, startEngine } from './cockpit-engine-harness'

let value: Scenario
test.afterEach(async () => { await value?.dispose() })

test('the logo retains account attention and exposes all moved actions', async ({}, testInfo) => {
  const engine = await startEngine({ providers: [{ instanceId: 'codex', driver: 'codex', displayName: 'Codex', enabled: true, installed: true, status: 'ready', version: '1.0.0', checkedAt: '2026-09-04T12:00:00.000Z', auth: { status: 'unauthenticated', type: 'chatgpt', label: 'Pro' }, models: [] }] })
  try {
    value = await seededScenario(testInfo, engine.origin, '# Window design\n\nThe logo menu keeps secondary actions together.\n', 'window-design.md')
    await value.writeSettings({ animatedBackground: false, theme: 'strata-vivid', zoom: { explorer: 1, editor: 1.1, rightRail: 1, composer: 1 } })
    const page = await value.launch()
    await expect(page.getByRole('button', { name: 'StrataMD menu' })).toHaveAttribute('title', /Accounts needs attention/)
    await expect(page.locator('.app-menu-trigger .attention-dot')).toBeVisible()
    await openAppMenu(page)
    const menu = page.getByRole('menu', { name: 'StrataMD', exact: true })
    await expect(menu.getByRole('menuitem')).toHaveText([/Open file/, /Accounts.*Needs attention/, 'Theme', 'Reset zoom'])
    const capture = process.env.STRATAMD_FRAMELESS_CAPTURES
    if (capture) {
      const directory = join(projectRoot, capture)
      await mkdir(directory, { recursive: true })
      await page.setViewportSize({ width: 1440, height: 900 })
      await page.screenshot({ path: join(directory, 'menu-all-actions.png'), animations: 'disabled' })
    }
    await menu.getByRole('menuitem', { name: 'Reset zoom' }).click()
    await openAppMenu(page)
    await expect(menu.getByRole('menuitem', { name: 'Reset zoom' })).toHaveCount(0)
    await menu.getByRole('menuitem', { name: 'Accounts', exact: true }).click()
    await expect(page.getByRole('dialog', { name: 'Accounts', exact: true })).toBeVisible()
  } finally {
    await value?.dispose()
    await engine.close()
  }
})

test('the integrated bar keeps navigation, a drag area, and keyboard-accessible app actions at narrow widths', async ({}, testInfo) => {
  value = await Scenario.create(testInfo, '# Frameless window\n\nA compact bar leaves more room for the document.\n', 'frameless-window-plan.md')
  await value.writeSettings({ animatedBackground: false, theme: 'strata-vivid' })
  const page = await value.launch()
  const controls = page.getByRole('group', { name: 'Window controls' })
  if (process.platform === 'linux') await expect(controls).toBeVisible()
  else await expect(controls).toHaveCount(0)
  for (const width of [1440, 1200, 1000, 960]) {
    await page.setViewportSize({ width, height: 900 })
    const metrics = await page.locator('.topbar').evaluate(bar => ({
      height: bar.getBoundingClientRect().height,
      overflow: bar.scrollWidth > bar.clientWidth,
      dragWidth: bar.querySelector('.window-drag-space')!.getBoundingClientRect().width,
      drag: getComputedStyle(bar).getPropertyValue('-webkit-app-region'),
      navigation: getComputedStyle(bar.querySelector('.tab-navigation')!).getPropertyValue('-webkit-app-region')
    }))
    expect(metrics.height).toBe(52)
    expect(metrics.overflow).toBe(false)
    expect(metrics.dragWidth).toBeGreaterThanOrEqual(64)
    expect(metrics.drag).toBe('drag')
    expect(metrics.navigation).toBe('no-drag')
    await expect(page.getByRole('button', { name: 'Docs menu' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Conversations menu' })).toBeVisible()
  }
  await openAppMenu(page)
  await expect(page.getByRole('menuitem', { name: /^Open file/ })).toBeFocused()
  await page.keyboard.press('End')
  await expect(page.getByRole('menuitem', { name: 'Theme', exact: true })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: 'StrataMD menu' })).toBeFocused()
  await expect(page.getByRole('menu', { name: 'StrataMD', exact: true })).toHaveCount(0)
  // The moved action still reaches the native file picker.
  await value.app!.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
  }, value.file)
  await openAppMenu(page)
  await page.getByRole('menuitem', { name: /^Open file/ }).click()
  await expect(page.getByRole('textbox', { name: 'Document editor' })).toBeVisible()

  const capture = process.env.STRATAMD_FRAMELESS_CAPTURES
  if (capture) {
    const directory = join(projectRoot, capture)
    await mkdir(directory, { recursive: true })
    for (const theme of ['strata-vivid', 'paper', 'strata']) {
      await page.evaluate(theme => window.strata.selectTheme(theme), theme)
      for (const width of [1440, 960]) {
        await page.setViewportSize({ width, height: 900 })
        await page.getByRole('textbox', { name: 'Document editor' }).click()
        await page.screenshot({ path: join(directory, `${theme}-${width}.png`), animations: 'disabled' })
      }
    }
    await page.evaluate(() => window.strata.selectTheme('strata-vivid'))
    await page.setViewportSize({ width: 1440, height: 900 })
    await openAppMenu(page)
    await page.screenshot({ path: join(directory, 'menu-open.png'), animations: 'disabled' })
  }
})

for (const choice of ['Save', 'Discard'] as const) {
  test(`Close flushes a rapid edit, Cancel keeps the window, then ${choice} uses the native close path`, async ({}, testInfo) => {
    test.skip(process.platform !== 'linux', 'Linux has custom close controls; macOS uses native traffic lights.')
    const original = '# Original\n\nSaved text.\n'
    const edited = '# Original\n\nA change immediately before Close.\n'
    value = await Scenario.create(testInfo, original)
    const page = await value.launch()
    await setSource(page, original)
    // Keep the first prompt pending so a second Close can be checked for reentrancy.
    await value.app!.evaluate(({ dialog }) => {
      const state = globalThis as typeof globalThis & { closeDialogs: number; answerClose: () => void }
      state.closeDialogs = 0
      dialog.showMessageBox = () => {
        state.closeDialogs += 1
        return new Promise(resolve => { state.answerClose = () => resolve({ response: 2, checkboxChecked: false }) })
      }
    })
    await page.getByRole('textbox', { name: 'Source editor' }).fill(edited)
    await page.getByRole('button', { name: 'Close window', exact: true }).click()
    await expect.poll(() => value.app!.evaluate(() => (globalThis as typeof globalThis & { closeDialogs: number }).closeDialogs)).toBe(1)
    await page.getByRole('button', { name: 'Close window', exact: true }).click()
    expect(await value.app!.evaluate(() => (globalThis as typeof globalThis & { closeDialogs: number }).closeDialogs)).toBe(1)
    await value.app!.evaluate(() => (globalThis as typeof globalThis & { answerClose: () => void }).answerClose())
    await expect(page.getByRole('textbox', { name: 'Source editor' })).toHaveValue(edited)
    expect(await readFile(value.file, 'utf8')).toBe(original)
    const inspection = await value.inspectDocument()
    await expect.poll(() => readFile(inspection.buffer!, 'utf8')).toBe(edited)
    await value.app!.evaluate(({ dialog }, choice) => {
      dialog.showMessageBox = async () => ({ response: choice === 'Save' ? 0 : 1, checkboxChecked: false })
    }, choice)
    const closed = page.waitForEvent('close')
    await page.getByRole('button', { name: 'Close window', exact: true }).click()
    await closed
    expect(await readFile(value.file, 'utf8')).toBe(choice === 'Save' ? edited : original)
  })
}
