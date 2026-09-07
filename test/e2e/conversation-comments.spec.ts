import { writeFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import { seededScenario, startEngine } from './cockpit-engine-harness'

const answer = '# Reading the answer\n\n<Callout kind="context">\n\nA useful **formatted passage** for a comment.\n\n</Callout>\n\n<Verdict outcome="recommended">\n\nKeep the source immutable.\n\n</Verdict>\n\n| Choice | Value |\n| --- | --- |\n| First | 12 |\n| Second | 24 |\n\n```mermaid\ngraph LR\nA --> B\n```\n\nRepeated passage.\n\nRepeated passage.\n'
for (const placement of ['side', 'center'] as const) test(`owner holds and sends a rich message passage in ${placement}`, async ({}, testInfo) => {
  const engine = await startEngine()
  const scenario = await seededScenario(testInfo, engine.origin)
  const messageId = engine.postAssistant('t1', answer)
  try {
    const page = await scenario.launch()
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.getByRole('tablist', { name: 'Document navigation' }).getByRole('tab', { name: 'Projects' }).click()
    await page.getByRole('button', { name: /^Open Live engine thread$/ }).click()
    if (placement === 'center') {
      await page.getByRole('button', { name: 'Open in center' }).click()
      await page.evaluate(async () => { const active = (await window.strata.getState()).activeDocument; if (active) await window.strata.closeDocument(active.path) })
    }
    const panel = page.locator(`.conversation-panel[data-placement="${placement}"]`)
    const message = panel.locator(`[data-message-id="${messageId}"]`)
    await expect(message.locator('.strata-prosemirror')).toBeVisible()
    await expect(message.locator('.strata-prosemirror')).toContainText('A useful')
    await expect(message.locator('.strata-mermaid-canvas svg')).toBeAttached()
    await message.locator('.strata-mermaid-canvas').scrollIntoViewIfNeeded()
    await page.screenshot({ animations: 'disabled', path: testInfo.outputPath(`${placement}-diagram.png`) })
    await message.locator('.strata-table-block').scrollIntoViewIfNeeded()
    await page.screenshot({ animations: 'disabled', path: testInfo.outputPath(`${placement}-table-diagram.png`) })
    await message.locator('.strata-prosemirror p').filter({ hasText: 'A useful' }).scrollIntoViewIfNeeded()
    await message.locator('.strata-prosemirror').evaluate(element => {
      const text = Array.from(element.querySelectorAll('p')).find(p => p.textContent?.includes('A useful'))!
      const range = document.createRange(); range.selectNodeContents(text)
      const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range)
      element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    })
    await page.getByRole('menuitem', { name: /^Comment C$/ }).click()
    const composer = page.locator('.annotation-composer')
    await expect(composer).toBeVisible()
    await composer.locator('textarea').fill('Please explain this.\nKeep both lines.')
    await page.screenshot({ animations: 'disabled', path: testInfo.outputPath(`${placement}-passage-composer.png`) })
    await composer.getByRole('button', { name: 'Hold', exact: true }).click()
    await expect(panel.locator('.conversation-context-tray')).toContainText('Please explain this.')
    await panel.getByText('Delivery preview', { exact: true }).click()
    const preview = await panel.locator('.conversation-context-tray pre').innerText()
    expect(preview).toContain('formatted passage')
    await panel.getByRole('button', { name: 'Send', exact: true }).click()
    await expect.poll(() => engine.uploads.length).toBeGreaterThan(0)
    expect(engine.uploads.at(-1)).toBe(preview)
    const annotations = JSON.parse(preview.match(/```json\n([\s\S]*?)\n```/)![1]!)
    const id = annotations[0].id
    // Upload precedes dispatch. Finish the fake turn only after it has started,
    // or a late dispatch changes the already-finished session back to running.
    await expect.poll(() => engine.commands.some(command => command.type === 'thread.turn.start')).toBe(true)
    engine.postAssistant('t1', 'Here is the explanation.\n\n```strata\n' + JSON.stringify([{ verb: 'reply', anchor: { item: id }, text: 'A precise reply to your passage.' }]) + '\n```')
    await expect.poll(async () => page.evaluate(async id => (await window.strata.getState()).engine.projects.flatMap(p => p.threads).find(t => t.id === 't1')?.comments?.find(c => c.id === id)?.replies.length, id)).toBe(1)
    // The reply ended the live turn; its Worked for row lands before the reading position is measured.
    await expect(panel.locator('.conversation-turn-toggle')).toHaveCount(1)
    // Reading position is the anchored answer's place in the viewport. Rows
    // above it may still mount their editors and grow, and the history then
    // compensates from a ResizeObserver a frame later, so the baseline is read
    // only once it holds across two frames; a read in between was 34 px off.
    const readingPosition = () => message.evaluate(element => element.getBoundingClientRect().top - element.closest('.conversation-messages')!.getBoundingClientRect().top)
    const settledReadingPosition = async () => {
      const first = await readingPosition()
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
      const second = await readingPosition()
      return Math.abs(first - second) < 1 ? second : null
    }
    let beforeDiscussion = 0
    await expect.poll(async () => { const settled = await settledReadingPosition(); if (settled !== null) beforeDiscussion = settled; return settled }).not.toBeNull()
    await panel.getByRole('navigation', { name: 'Conversation history' }).getByRole('button', { name: /^Comment: Please explain this/ }).click()
    await expect(page.getByRole('dialog', { name: 'Saved comment' })).toContainText('Please explain this.')
    await expect(page.getByRole('dialog', { name: 'Saved comment' }).getByRole('button', { name: /^(Reply|Resolve|Reopen)$/ })).toHaveCount(0)
    await page.getByText('Earlier replies', { exact: true }).click()
    await expect(page.getByRole('dialog', { name: 'Saved comment' })).toContainText('A precise reply to your passage.')
    await page.getByRole('button', { name: 'Back to reading', exact: true }).click()
    await expect.poll(async () => Math.abs(await readingPosition() - beforeDiscussion)).toBeLessThan(3)
    await panel.getByRole('navigation', { name: 'Conversation history' }).getByRole('button', { name: /^Comment: Please explain this/ }).click()
    await page.getByRole('dialog', { name: 'Saved comment' }).scrollIntoViewIfNeeded()
    await page.screenshot({ animations: 'disabled', path: testInfo.outputPath(`${placement}-discussion.png`) })
    await page.getByRole('button', { name: 'Jump to passage' }).click()
    await page.screenshot({ animations: 'disabled', path: testInfo.outputPath(`${placement}-anchored-discussion.png`) })
    const themes = await page.evaluate(async () => (await window.strata.getState()).settings.theme.available)
    for (const theme of themes) {
      await page.evaluate(async id => window.strata.selectTheme(id), theme.id)
      await page.evaluate(async () => { const state = await window.strata.getState(); await window.strata.updateSettings({ zoom: { ...state.settings.zoom, explorer: 1.2, editor: 1.2 } }) })
      await page.screenshot({ animations: 'disabled', path: testInfo.outputPath(`${placement}-${theme.name.replace(/[^a-z0-9]+/gi, '-')}-zoom.png`) })
    }

  } finally { await scenario.dispose(); await engine.close() }
})

for (const placement of ['side', 'center'] as const) test(`100 exchanges mount only nearby editors and navigate old content in ${placement}`, async ({}, testInfo) => {
  const engine = await startEngine({ longHistory: true })
  const scenario = await seededScenario(testInfo, engine.origin)
  try {
    const page = await scenario.launch()
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.getByRole('tablist', { name: 'Document navigation' }).getByRole('tab', { name: 'Projects' }).click()
    await page.getByRole('button', { name: /^Open Live engine thread$/ }).click()
    if (placement === 'center') {
      await page.getByRole('button', { name: 'Open in center' }).click()
      await page.evaluate(async () => { const active = (await window.strata.getState()).activeDocument; if (active) await window.strata.closeDocument(active.path) })
    }
    const panel = page.locator(`.conversation-panel[data-placement="${placement}"]`)
    await expect(panel.locator('[data-message-id]')).toHaveCount(201)
    await expect.poll(() => panel.locator('[data-rich-mounted]').count()).toBeLessThan(12)
    const navigationStarted = performance.now()
    await panel.getByRole('searchbox', { name: 'Find in conversation' }).fill('History passage 1.')
    await panel.getByRole('button', { name: 'Next', exact: true }).click()
    const old = panel.locator('[data-message-id="history-agent-0"]')
    await expect(old.locator('.strata-prosemirror')).toBeVisible()
    expect(await old.locator('.strata-prosemirror').evaluate(element => Number.parseFloat(getComputedStyle(element).fontSize))).toBe(placement === 'center' ? 17 : 15)
    await expect.poll(() => panel.locator('[data-rich-mounted]').count()).toBeLessThan(12)
    await panel.getByRole('searchbox', { name: 'Find in conversation' }).fill('')
    await writeFile(testInfo.outputPath(`${placement}-history-measurement.json`), JSON.stringify({ exchanges: 100, mountedEditors: await panel.locator('[data-rich-mounted]').count(), findAndMountMs: Math.round(performance.now() - navigationStarted) }, null, 2))
    const top = await old.evaluate(element => element.getBoundingClientRect().top)
    engine.setMessage('Streaming update while the owner reads an old answer.')
    await expect(panel.locator('[data-message-id="m1"]')).toContainText('Streaming update')
    await expect.poll(async () => Math.abs(await old.evaluate(element => element.getBoundingClientRect().top) - top)).toBeLessThan(3)
    await old.locator('.strata-prosemirror').evaluate(element => {
      const text = Array.from(element.querySelectorAll('p')).find(p => p.textContent?.includes('History passage 1.'))!
      const range = document.createRange(); range.selectNodeContents(text)
      const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range)
      element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    })
    await page.getByRole('menuitem', { name: /^Comment C$/ }).click()
    await page.locator('.annotation-composer textarea').fill('Comment on the oldest answer.')
    await page.locator('.annotation-composer').getByRole('button', { name: 'Hold', exact: true }).click()
    await expect(panel.locator('.conversation-context-tray')).toContainText('Comment on the oldest answer.')
    await expect(panel.getByRole('button', { name: 'Contents', exact: true })).toHaveCount(0)
    const navigator = panel.getByRole('navigation', { name: 'Conversation history' })
    await expect(navigator.getByRole('button', { name: /^Message: Request / })).toHaveCount(100)
    await navigator.getByRole('button', { name: 'Message: Request 1', exact: true }).click()
    await expect(panel.locator('[data-message-id="history-user-0"]')).toBeInViewport()
    await expect(navigator.locator('[aria-current="location"]')).toHaveCount(1)
    await page.screenshot({ animations: 'disabled', path: testInfo.outputPath(`${placement}-long-history.png`) })
  } finally { await scenario.dispose(); await engine.close() }
})
