import { expect, test } from './test'
import { seededScenario, startEngine } from './cockpit-engine-harness'

for (const placement of ['side', 'center'] as const) test(`sent comments show exact pairs and reopen their passage in ${placement}`, async ({}, testInfo) => {
  const engine = await startEngine()
  const scenario = await seededScenario(testInfo, engine.origin)
  const source = 'Keep remote access off while using a private model.\n\nChoose the key storage story that fits this computer.'
  const messageId = engine.postAssistant('t1', source)
  try {
    const page = await scenario.launch()
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.getByRole('tablist', { name: 'Document navigation' }).getByRole('tab', { name: 'Projects' }).click()
    await page.getByRole('button', { name: /^Open Live engine thread$/ }).click()
    if (placement === 'center') await page.getByRole('button', { name: 'Open in center' }).click()
    const panel = page.locator(`.conversation-panel[data-placement="${placement}"]`)
    await expect(panel.locator(`[data-message-id="${messageId}"]`)).toContainText('remote access off')
    const replies = ['thats fine but add a toggle\nso its easy to turn on and off', 'whatever works the best honestly']
    await page.evaluate(async ({ messageId, source, replies }) => {
      for (const [index, selection] of ['remote access off', 'the key storage story'].entries()) {
        const from = source.indexOf(selection)
        await window.strata.holdMessageComment('t1', { messageId, from, to: from + selection.length, kind: 'comment', text: replies[index]! })
      }
    }, { messageId, source, replies })
    const note = placement === 'center' ? 'Please use these decisions.' : ''
    if (note) await panel.getByRole('textbox', { name: 'Message conversation' }).fill(note)
    await panel.getByRole('button', { name: 'Send', exact: true }).click()
    const sent = panel.locator('.conversation-message.user[data-sent-comments]')
    await expect(sent).toHaveCount(1)
    await expect(sent.locator('.conversation-chip')).toHaveText('2 comments')
    await expect(sent.locator('.conversation-sent-comment')).toHaveCount(2)
    await expect(sent).not.toContainText('Comments on 2 passages.')
    if (note) await expect(sent).toContainText(note)
    for (const [index, quote] of ['remote access off', 'the key storage story'].entries()) {
      const pair = sent.locator('.conversation-sent-comment').nth(index)
      await expect(pair.locator('blockquote')).toHaveText(quote)
      expect(await pair.locator('.conversation-sent-response').textContent()).toBe(replies[index])
      expect(await pair.locator('.conversation-sent-response').evaluate(element => getComputedStyle(element).fontSize)).toBe(placement === 'center' ? '17px' : '15px')
    }
    await sent.scrollIntoViewIfNeeded()
    await page.screenshot({ animations: 'disabled', path: testInfo.outputPath(`${placement}-sent-comments.png`) })
    const passage = sent.getByRole('button', { name: 'View passage' }).first()
    await passage.click()
    const dialog = page.getByRole('dialog', { name: 'Original passage' })
    await expect(dialog).toContainText('Keep remote access off while using a private model.')
    await expect.poll(() => page.evaluate(() => CSS.highlights.get('sent-passage')?.size)).toBeGreaterThan(0)
    await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toBeFocused()
    await page.screenshot({ animations: 'disabled', path: testInfo.outputPath(`${placement}-sent-passage.png`) })
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(passage).toBeFocused()
    await sent.getByRole('button', { name: 'View passage' }).nth(1).click()
    await expect(dialog).toContainText('Choose the key storage story that fits this computer.')
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    await page.reload()
    await expect(page.locator('.conversation-message.user[data-sent-comments] .conversation-sent-comment')).toHaveCount(2)
  } finally { await scenario.dispose(); await engine.close() }
})
