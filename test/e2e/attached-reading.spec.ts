import { expect, test } from '@playwright/test'
import { seededScenario, startEngine } from './cockpit-engine-harness'
import { attachThread, openThread } from './cockpit-agent'

test('populated Attached rows keep actions visible in a narrow window and at increased zoom', async ({}, testInfo) => {
  const engine = await startEngine({ titles: { t1: 'Review the bundled engine and preview recovery', t2: 'Check visual comments and their evidence' } })
  const scenario = await seededScenario(testInfo, engine.origin, '# Reading review\n\nTwo agents are attached to this document.\n')
  try {
    const page = await scenario.launch()
    await openThread(page, 'Review the bundled engine and preview recovery')
    await attachThread(page, 't1')
    await openThread(page, 'Check visual comments and their evidence')
    await attachThread(page, 't2')
    await page.getByRole('tablist', { name: 'Document navigation' }).getByRole('tab', { name: 'Contents' }).click()
    for (const zoom of [1, 1.3]) {
      await scenario.app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1024, 700))
      await page.evaluate(async zoom => { const state = await window.strata.getState(); await window.strata.updateSettings({ zoom: { ...state.settings.zoom, rightRail: zoom } }) }, zoom)
      await expect.poll(() => page.locator('[data-pane="rightRail"]').evaluate(element => getComputedStyle(element).getPropertyValue('--zoom').trim())).toBe(String(zoom))
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
      await page.screenshot({ path: testInfo.outputPath(`attached-1024-zoom-${zoom}.png`), animations: 'disabled' })
      const rows = page.locator('.agent-row')
      await expect(rows).toHaveCount(2)
      for (const row of await rows.all()) {
        await row.scrollIntoViewIfNeeded()
        await expect(row).toBeInViewport()
        expect(await row.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
        for (const button of await row.getByRole('button').all()) { await button.scrollIntoViewIfNeeded(); await expect(button).toBeInViewport() }
      }
    }
  } finally { await scenario.dispose(); await engine.close() }
})
