import { execFileSync } from 'node:child_process'
import { expect, test } from '@playwright/test'
import { seededScenario, startEngine } from './cockpit-engine-harness'

for (const placement of ['center', 'side'] as const) test(`conversation markers revisit five comments without a discussion workflow in ${placement}`, async ({}, testInfo) => {
  const engine = await startEngine({ conversationParity: true })
  const scenario = await seededScenario(testInfo, engine.origin)
  const answer = '# Navigation proposal\n\nKeep projects visible while reading the conversation.\n\nUse a compact strip to revisit your messages.\n\nShow each passage comment in the strip.\n\nHover a marker to preview the original feedback.\n\nClick a marker to return to its passage.\n'
  const messageId = engine.postAssistant('t1', answer)
  try {
    const launch = () => scenario.launch(scenario.file, process.env.STRATAMD_NAV_BROWSER && placement === 'center' ? ['--remote-debugging-port=9337'] : [])
    let page = await launch()
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.getByRole('tablist', { name: 'Document navigation' }).getByRole('tab', { name: 'Projects' }).click()
    await page.getByRole('button', { name: /^Open Live engine thread$/ }).click()
    if (placement === 'center') await page.getByRole('button', { name: 'Open in center' }).click()
    let panel = page.locator(`.conversation-panel[data-placement="${placement}"]`)
    await expect(panel.locator(`[data-message-id="${messageId}"]`)).toBeAttached()
    const notes = ['Keep the project list available.', 'Can I jump to my earlier messages?', 'Keep all five comments separately reachable.', 'Include the quoted passage in the preview.', 'Do not turn feedback into another thread.']
    const ids = await page.evaluate(async ({ messageId, notes }) => {
      const thread = (await window.strata.getState()).engine.projects.flatMap(p => p.threads).find(t => t.id === 't1')!
      const message = thread.messages.find(m => m.id === messageId)!
      const source = message.prose ?? message.text
      const paragraphs = source.trim().split('\n\n').slice(1)
      const ids = []
      for (const [index, text] of notes.entries()) {
        const from = source.indexOf(paragraphs[index]!)
        ids.push(await window.strata.holdMessageComment('t1', { messageId, from, to: from + paragraphs[index]!.length, kind: 'comment', text }))
      }
      return ids
    }, { messageId, notes })
    let navigator = panel.getByRole('navigation', { name: 'Conversation history' })
    await expect(navigator.locator('[data-kind="comment"]')).toHaveCount(5)
    await panel.getByRole('button', { name: 'Send', exact: true }).click()
    await expect.poll(async () => page.evaluate(async () => (await window.strata.getState()).engine.projects.flatMap(p => p.threads).find(t => t.id === 't1')?.comments?.every(c => c.state === 'open'))).toBe(true)
    await expect(navigator.locator('[data-held]')).toHaveCount(0)
    await expect(panel.locator('.turn-checklist').getByText(notes[0]!)).toHaveCount(0)
    if (placement === 'center') await expect(page.getByRole('tablist', { name: 'Document navigation' }).getByRole('tab', { name: 'Contents', exact: true })).toHaveCount(0)
    await expect(panel.getByRole('button', { name: 'Contents', exact: true })).toHaveCount(0)
    await page.mouse.move(1300, 90)
    await page.screenshot({ animations: 'disabled', path: testInfo.outputPath(`${placement}-strip.png`) })
    const third = navigator.locator(`[data-marker-id="${ids[2]}"]`)
    await third.hover()
    await expect(page.getByRole('tooltip')).toContainText(notes[2]!)
    await expect(page.getByRole('tooltip')).toContainText('Show each passage comment in the strip.')
    await page.screenshot({ animations: 'disabled', path: testInfo.outputPath(`${placement}-preview.png`) })
    await third.click()
    await expect(panel.locator(`[data-annotation-id="${ids[2]}"]`).first()).toBeInViewport()
    const saved = page.getByRole('dialog', { name: 'Saved comment' })
    await expect(saved).toContainText(notes[2]!)
    await expect(saved.getByRole('button', { name: /^(Reply|Resolve|Reopen|Accept|Reject)$/ })).toHaveCount(0)
    await page.mouse.move(1300, 90)
    await page.screenshot({ animations: 'disabled', path: testInfo.outputPath(`${placement}-saved-comment.png`) })
    await saved.getByRole('button', { name: 'Close comment', exact: true }).click()
    await expect(saved).toBeHidden()
    await third.click()
    await expect(saved).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(saved).toBeHidden()
    await third.click()
    await expect(saved).toBeVisible()
    await panel.getByRole('searchbox', { name: 'Find in conversation' }).click()
    await expect(saved).toBeHidden()
    await third.click()
    await saved.getByRole('button', { name: 'Back to reading' }).click()
    await navigator.getByRole('button').first().focus()
    await page.keyboard.press('End')
    await expect(navigator.getByRole('button').last()).toBeFocused()
    await page.keyboard.press('Home')
    await expect(navigator.getByRole('button').first()).toBeFocused()
    await page.keyboard.press('Enter')
    await expect.poll(() => panel.locator('[data-message-id="old-user-1"]').evaluate(row => {
      const viewport = row.closest('.conversation-messages')!
      return Math.abs(row.getBoundingClientRect().top - viewport.getBoundingClientRect().top - Number.parseFloat(getComputedStyle(viewport).paddingTop))
    })).toBeLessThan(2)
    await page.screenshot({ animations: 'disabled', path: testInfo.outputPath(`${placement}-keyboard-jump.png`) })
    await page.keyboard.press('Escape')
    await expect(page.getByRole('tooltip')).toHaveCount(0)
    // History survives a real app restart and is still independently navigable.
    await scenario.stop()
    page = await launch()
    await page.getByRole('tablist', { name: 'Document navigation' }).getByRole('tab', { name: 'Projects' }).click()
    await page.getByRole('button', { name: /^Open Live engine thread$/ }).click()
    if (placement === 'center') await page.getByRole('button', { name: 'Open in center' }).click()
    panel = page.locator(`.conversation-panel[data-placement="${placement}"]`)
    navigator = panel.getByRole('navigation', { name: 'Conversation history' })
    await expect(navigator.locator('[data-kind="comment"]')).toHaveCount(5)
    await navigator.locator(`[data-marker-id="${ids[4]}"]`).click()
    await expect(page.getByRole('dialog', { name: 'Saved comment' })).toContainText(notes[4]!)
    if (placement === 'side') {
      await page.getByRole('tablist', { name: 'Document navigation' }).getByRole('tab', { name: 'Projects' }).click()
      await expect(page.getByRole('dialog', { name: 'Saved comment' })).toHaveCount(0)
    }
    if (process.env.STRATAMD_NAV_BROWSER && placement === 'center') {
      const session = 'strata-conversation-navigation'
      execFileSync('agent-browser', ['--session', session, 'connect', '9337'])
      execFileSync('agent-browser', ['--session', session, 'snapshot', '-i'])
      execFileSync('agent-browser', ['--session', session, 'screenshot', testInfo.outputPath('center-browser-review.png')])
    }
  } finally { await scenario.dispose(); await engine.close() }
})
