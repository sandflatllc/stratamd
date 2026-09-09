import { expect, test } from './test'
import { seededScenario, startEngine } from './cockpit-engine-harness'
import { setSource } from './harness'
import { attachThread, openThread } from './cockpit-agent'

test('unrelated live thread updates cannot starve the document Send preview', async ({}, testInfo) => {
  const engine = await startEngine()
  const scenario = await seededScenario(testInfo, engine.origin, '# Preview\n\nKeep this document.\n')
  let updates: ReturnType<typeof setInterval> | undefined
  try {
    const page = await scenario.launch()
    await openThread(page, 'Live engine thread')
    await attachThread(page, engine, 't1', 'Live engine thread')
    await page.getByRole('tablist', { name: 'Document navigation' }).getByRole('tab', { name: 'Contents' }).click()
    await setSource(page, '# Preview\n\nChanged document.\n')
    await scenario.waitForBuffer('# Preview\n\nChanged document.\n')
    let count = 0
    // Continuous independent broadcasts reproduce the debounce cancellation from the offline trace.
    updates = setInterval(() => engine.setMessage(`Unrelated live status ${++count}`), 40)
    await page.getByRole('button', { name: /^Send/i }).first().click()
    const dialog = page.getByRole('dialog', { name: /Send changes/i })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('tabpanel')).toHaveAttribute('aria-busy', 'false')
    expect(count).toBeGreaterThan(3)
    await page.evaluate(path => window.strata.updateBuffer(path, '# Preview\n\nChanged again while reviewing.\n', 'edit'), scenario.file)
    await dialog.getByRole('button', { name: 'Exact text', exact: true }).click()
    await expect(dialog.locator('.delivery-preview')).toContainText('Changed again while reviewing.')
  } finally { clearInterval(updates); await scenario.dispose(); await engine.close() }
})
