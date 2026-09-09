import { expect, test } from './test'
import { selectNavigationTab } from './harness'
import { seededScenario, startEngine } from './cockpit-engine-harness'

for (const placement of ['side', 'center'] as const) test(`holds and sends a comment ending at a paragraph boundary in ${placement}`, async ({}, testInfo) => {
  const engine = await startEngine()
  const scenario = await seededScenario(testInfo, engine.origin)
  const passage = 'Keep the hub loaded when opening related tasks.'
  const source = `${placement === 'center' ? '> ' : ''}${passage}\n\nThe following paragraph is not selected.`
  const messageId = engine.postAssistant('t1', source)
  try {
    const page = await scenario.launch()
    await selectNavigationTab(page, 'Projects')
    await page.getByRole('button', { name: /^Open Live engine thread$/ }).click()
    if (placement === 'center') await page.getByRole('button', { name: 'Open in center' }).click()
    const panel = page.locator(`.conversation-panel[data-placement="${placement}"]`)
    const editor = panel.locator(`[data-message-id="${messageId}"] .strata-prosemirror`)
    await expect(editor).toBeVisible()
    await editor.evaluate(element => {
      const paragraphs = element.querySelectorAll('p')
      const range = document.createRange()
      range.setStart(paragraphs[0]!.firstChild!, 0)
      range.setEnd(paragraphs[1]!.firstChild!, 0)
      const selection = window.getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)
      element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    })
    await page.getByRole('menuitem', { name: /^Comment C$/ }).click()
    const composer = page.locator('.annotation-composer')
    await composer.locator('textarea').fill('Preserve the scroll position too.')
    await composer.getByRole('button', { name: 'Hold', exact: true }).click()
    await expect(panel.locator('.conversation-context-tray')).toContainText('Preserve the scroll position too.')
    await expect.poll(() => page.evaluate(async () => (await window.strata.getState()).engine.projects.flatMap(project => project.threads).find(thread => thread.id === 't1')?.comments?.[0]?.selection)).toBe(passage)
    await expect(panel.getByRole('alert')).toHaveCount(0)
    await panel.getByRole('button', { name: 'Send', exact: true }).click()
    await expect.poll(() => engine.commands.some(command => command.type === 'thread.turn.start')).toBe(true)
    const annotations = JSON.parse(engine.uploads.at(-1)!.match(/```json\n([\s\S]*?)\n```/)![1]!)
    expect(annotations).toMatchObject([{ selection: passage, text: 'Preserve the scroll position too.' }])
    const sent = panel.locator('.conversation-message.user[data-sent-comments]')
    await expect(sent.locator('.conversation-sent-comment blockquote')).toHaveText(passage)
    await sent.getByRole('button', { name: 'View passage' }).click()
    await expect(page.getByRole('dialog', { name: 'Original passage' })).toContainText(passage)
    await expect.poll(() => page.evaluate(() => CSS.highlights.get('sent-passage')?.size)).toBeGreaterThan(0)
  } finally { await scenario.dispose(); await engine.close() }
})
