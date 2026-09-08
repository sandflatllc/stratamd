import { expect, test } from './test'
import { Scenario, primaryKey } from './harness'
import { selectTextInVisualEditor } from './harness'

// Source view (usability round 2 §5.8): the selection follows the view change
// in both directions, and typing in source view no longer reparses per key.

test('the selection carries into source view and back, and source typing lands in the visual view', async ({}, testInfo) => {
  const scenario = await Scenario.create(testInfo, '# Map\n\nFirst sentence here.\n\nSecond **bold** sentence.\n', 'map.md')
  try {
    const page = await scenario.launch()
    const editor = page.getByRole('textbox', { name: /document editor/i })
    const source = page.getByRole('textbox', { name: /source editor/i })

    await selectTextInVisualEditor(page, 'bold')
    await page.keyboard.press(primaryKey('/'))
    await expect(source).toBeVisible()
    await expect(source).toBeFocused()
    expect(await source.evaluate((node: HTMLTextAreaElement) => node.value.slice(node.selectionStart, node.selectionEnd))).toBe('bold')

    // Select in source, switch back: the visual selection is the same words.
    await source.evaluate((node: HTMLTextAreaElement) => {
      const start = node.value.indexOf('First sentence')
      node.setSelectionRange(start, start + 'First sentence'.length)
    })
    await page.keyboard.press(primaryKey('/'))
    await expect(editor).toBeVisible()
    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? '')).toBe('First sentence')

    // Typing in source view: the visual view catches up once typing pauses.
    await page.keyboard.press(primaryKey('/'))
    await expect(source).toBeVisible()
    await expect(source).toBeFocused()
    await source.evaluate((node: HTMLTextAreaElement) => { const end = node.value.indexOf('here.') + 'here.'.length; node.setSelectionRange(end, end) })
    await page.keyboard.type(' Added in source.', { delay: 15 })
    await page.keyboard.press(primaryKey('/'))
    await expect(editor.locator('p').first()).toHaveText('First sentence here. Added in source.')
    await scenario.waitForBuffer('# Map\n\nFirst sentence here. Added in source.\n\nSecond **bold** sentence.\n')
  } finally {
    await scenario.dispose()
  }
})

for (const firstEcho of ['settled', 'pending'] as const) {
  test(`source view keeps the latest keyboard intent across delayed echoes with the first echo ${firstEcho}`, async ({}, testInfo) => {
    const scenario = await Scenario.create(testInfo, '# Delayed source mode\n\nPreserve this paragraph.\n', 'source-echo.md')
    try {
      const page = await scenario.launch()
      const editor = page.getByRole('textbox', { name: /document editor/i })
      const source = page.getByRole('textbox', { name: /source editor/i })
      const toggle = page.locator('.source-toggle')
      await scenario.app!.evaluate(({ ipcMain }) => {
        const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => Promise<unknown>> })._invokeHandlers
        const original = handlers.get('strata:set-source-mode')!
        const gate = { releases: [] as (() => void)[], completed: [] as number[], restore: () => handlers.set('strata:set-source-mode', original) }
        Object.assign(globalThis, { __sourceEchoGate: gate })
        handlers.set('strata:set-source-mode', async (...args) => {
          const index = gate.releases.length
          await new Promise<void>(resolve => { gate.releases.push(resolve) })
          const result = await original(...args)
          gate.completed.push(index)
          return result
        })
      })
      const waitForRequest = (count: number) => expect.poll(() => scenario.app!.evaluate(() => (globalThis as unknown as { __sourceEchoGate: { releases: unknown[] } }).__sourceEchoGate.releases.length)).toBe(count)
      const release = async (index: number) => {
        await scenario.app!.evaluate((_electron, value) => (globalThis as unknown as { __sourceEchoGate: { releases: (() => void)[] } }).__sourceEchoGate.releases[value]!(), index)
        await expect.poll(() => scenario.app!.evaluate((_electron, value) => (globalThis as unknown as { __sourceEchoGate: { completed: number[] } }).__sourceEchoGate.completed.includes(value), index)).toBe(true)
      }

      await editor.click()
      await page.keyboard.press(primaryKey('/'))
      await expect(source).toBeVisible()
      await expect(source).toBeFocused()
      await waitForRequest(1)
      if (firstEcho === 'settled') {
        await release(0)
        await expect(toggle).toHaveClass(/active/)
      }
      await page.keyboard.press(primaryKey('/'))
      await expect(editor).toBeVisible()
      await expect(editor).toBeFocused()
      await waitForRequest(2)
      await page.keyboard.press(primaryKey('/'))
      await expect(source).toBeVisible()
      await expect(source).toBeFocused()
      await waitForRequest(3)

      if (firstEcho === 'pending') {
        // The oldest echo happens to equal the newest intent. It cannot acknowledge the newest request.
        await release(0)
        await expect(toggle).toHaveClass(/active/)
      }
      await release(1)
      await expect(toggle).not.toHaveClass(/active/)
      await expect(source).toBeVisible()
      await expect(source).toBeFocused()
      await release(2)
      await expect(toggle).toHaveClass(/active/)
      await expect(source).toBeVisible()
      await expect(source).toBeFocused()
      expect(await page.evaluate(async () => (await window.strata.getState()).activeDocument?.sourceMode)).toBe(true)
      await source.press(primaryKey('/'))
      await waitForRequest(4)
      await release(3)
      await expect(editor).toBeVisible()
    } finally {
      await scenario.app?.evaluate(() => {
        const gate = (globalThis as unknown as { __sourceEchoGate?: { releases: (() => void)[]; restore(): void } }).__sourceEchoGate
        gate?.releases.forEach(release => release())
        gate?.restore()
      }).catch(() => undefined)
      await scenario.dispose()
    }
  })
}
