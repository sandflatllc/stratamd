import { expect, test } from './test'
import { Scenario, primaryKey, save, setSource } from './harness'

test.describe('view sync', () => {
  test('a busy session merges every update without divergence', async ({ }, testInfo) => {
    const scenario = await Scenario.create(testInfo, '# Sync\n\nFirst paragraph.\n\nSecond paragraph.\n')
    try {
      const page = await scenario.launch()
      const waitForMode = async (source: boolean) => {
        await expect.poll(() => page.evaluate(async expected => {
          const state = await window.strata.getState()
          await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
          const editor = document.querySelector(expected ? '[aria-label="Source editor"]' : '[aria-label="Document editor"]')
          return state.activeDocument?.sourceMode === expected && editor instanceof HTMLElement && editor.getBoundingClientRect().height > 0 && getComputedStyle(editor).visibility !== 'hidden'
        }, source)).toBe(true)
      }

      await setSource(page, '# Sync\n\nFirst paragraph edited.\n\nSecond paragraph.\n')
      await save(page)

      // External disk change reaches the window as a review state.
      await scenario.atomicWrite(scenario.file, '# Sync\n\nFirst paragraph edited.\n\nSecond paragraph reworked.\n')
      await expect(page.getByText('Second paragraph reworked.').first()).toBeVisible()

      // setSource leaves the source view open. Establish the visual starting
      // mode before testing a round trip; observing the old source DOM is not
      // acknowledgement of an asynchronous first toggle.
      await waitForMode(true)
      await expect(page.getByRole('textbox', { name: /source editor/i })).toBeVisible()
      await page.getByRole('button', { name: /source$/i }).click()
      await waitForMode(false)
      await expect(page.getByRole('textbox', { name: /document editor/i })).toBeVisible()

      // Toggle source and back, waiting for each mode, then edit again to
      // force further full-document publishes.
      await page.keyboard.press(primaryKey('/'))
      await waitForMode(true)
      await expect(page.getByRole('textbox', { name: /source editor/i })).toBeVisible()
      await page.keyboard.press(primaryKey('/'))
      await waitForMode(false)
      await expect(page.getByRole('textbox', { name: /document editor/i })).toBeVisible()
      await setSource(page, '# Sync\n\nFirst paragraph edited twice.\n\nSecond paragraph reworked.\n')
      await save(page)

      const diagnostics = await page.evaluate(() =>
        (window.strata as unknown as { viewSyncDiagnostics(): { seq: number; resyncs: number; verifyMismatches: number } }).viewSyncDiagnostics(),
      )
      expect(diagnostics.seq).toBeGreaterThan(5)
      expect(diagnostics.verifyMismatches).toBe(0)
    } finally {
      await scenario.dispose()
    }
  })
})
