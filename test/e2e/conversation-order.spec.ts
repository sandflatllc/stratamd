import { expect, test, type Locator } from '@playwright/test'
import { seededScenario, startEngine } from './cockpit-engine-harness'

test('conversation messages and history markers run oldest to newest in both placements', async ({}, testInfo) => {
  const engine = await startEngine({ conversationParity: true })
  const scenario = await seededScenario(testInfo, engine.origin)
  try {
    const page = await scenario.launch()
    await page.getByRole('tablist', { name: 'Document navigation' }).getByRole('tab', { name: 'Projects' }).click()
    await page.getByRole('button', { name: /^Open Live engine thread$/ }).click()
    const expected = ['old-user-1', 'old-agent-1', 'old-user-2', 'old-agent-2', 'live-user', 'm1']
    for (const placement of ['side', 'center']) {
      const panel = page.locator(`.conversation-panel[data-placement="${placement}"]`)
      await expect.poll(() => panel.locator('[data-message-id]').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-message-id')))).toEqual(expected)
      await expect(panel.getByRole('textbox', { name: 'Message conversation' })).toBeInViewport()
      await expect(panel.locator('.conversation-marker')).toHaveCount(3)
      await expect.poll(() => panel.locator('.conversation-marker').evaluateAll(rows => rows.map(row => row.getAttribute('data-marker-id')))).toEqual(['old-user-1', 'old-user-2', 'live-user'])
      if (placement === 'side') await panel.getByRole('button', { name: 'Open in center' }).click()
    }
  } finally { await scenario.dispose(); await engine.close() }
})

async function expectBottom(history: Locator) {
  await expect.poll(() => history.evaluate(el => Math.abs(el.scrollHeight - el.clientHeight - el.scrollTop))).toBeLessThan(2)
}

async function expectStart(message: Locator) {
  await expect.poll(() => message.evaluate(el => {
    const viewport = el.closest('.conversation-messages')!
    return Math.abs(el.getBoundingClientRect().top - viewport.getBoundingClientRect().top - Number.parseFloat(getComputedStyle(viewport).paddingTop))
  })).toBeLessThan(2)
  await expect(message.locator('small').first()).toBeInViewport()
}

for (const placement of ['side', 'center']) test(`latest response aligns long and short answers at the top in ${placement}`, async ({}, testInfo) => {
  const engine = await startEngine()
  const scenario = await seededScenario(testInfo, engine.origin)
  const longAnswer = '# Latest answer\n\n' + Array.from({ length: 35 }, (_, i) => `Paragraph ${i + 1}. Read this answer from its beginning, with older messages above it.`).join('\n\n')
  const latest = engine.postAssistant('t1', longAnswer)
  try {
    const page = await scenario.launch()
    await page.setViewportSize({ width: 1440, height: 900 })
    const navigation = page.getByRole('tablist', { name: 'Document navigation' })
    await navigation.getByRole('tab', { name: 'Projects' }).click()
    await page.getByRole('button', { name: /^Open Live engine thread$/ }).click()
    if (placement === 'center') await page.getByRole('button', { name: 'Open in center' }).click()
    const panel = page.locator(`.conversation-panel[data-placement="${placement}"]`)
    const history = panel.locator('.conversation-messages')
    const anchor = panel.locator(`[data-message-id="${latest}"]`)
    await expectBottom(history)
    await panel.getByRole('button', { name: 'Latest response', exact: true }).click()
    await expectStart(anchor)
    await expect(anchor.locator('.strata-prosemirror')).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath(`latest-response-${placement}.png`) })
    const top = await anchor.evaluate(el => el.getBoundingClientRect().top)
    const next = engine.postAssistant('t1', 'A short new answer.')
    const short = panel.locator(`[data-message-id="${next}"]`)
    await expect(short).toBeAttached()
    await expect.poll(async () => Math.abs(await anchor.evaluate(el => el.getBoundingClientRect().top) - top)).toBeLessThan(2)
    await panel.getByRole('button', { name: 'Latest response', exact: true }).click()
    await expectStart(short)
    await panel.getByRole('button', { name: 'Newest', exact: true }).click()
    await expectBottom(history)
    await panel.getByRole('button', { name: 'Latest response', exact: true }).click()
    await expectStart(short)
    if (placement === 'side') {
      await navigation.getByRole('tab', { name: 'Contents' }).click()
      await navigation.getByRole('tab', { name: 'Conversation', exact: true }).click()
      await expectBottom(history)
    }
  } finally { await scenario.dispose(); await engine.close() }
})

test('streaming and incoming messages follow the bottom while scrolling up preserves reading position', async ({}, testInfo) => {
  const engine = await startEngine()
  const scenario = await seededScenario(testInfo, engine.origin)
  const longAnswer = '# Streaming answer\n\n' + 'A paragraph in the growing answer.\n\n'.repeat(50)
  engine.setMessage(longAnswer)
  try {
    const page = await scenario.launch()
    await page.getByRole('tablist', { name: 'Document navigation' }).getByRole('tab', { name: 'Projects' }).click()
    await page.getByRole('button', { name: /^Open Live engine thread$/ }).click()
    const panel = page.locator('.conversation-panel[data-placement="side"]')
    const history = panel.locator('.conversation-messages')
    await expectBottom(history)
    engine.setMessage(longAnswer + 'More streaming text.\n\n'.repeat(15))
    await expect(panel.locator('[data-message-id="m1"]')).toContainText('More streaming text.')
    await expectBottom(history)
    await panel.getByRole('button', { name: 'Latest response', exact: true }).click()
    await expectStart(panel.locator('[data-message-id="m1"]'))
    await history.evaluate(el => { el.scrollTop += 300 })
    const position = await history.evaluate(el => el.scrollTop)
    engine.setMessage(longAnswer + 'Further streaming text.\n\n'.repeat(30))
    await expect(panel.locator('[data-message-id="m1"]')).toContainText('Further streaming text.')
    await expect.poll(async () => Math.abs(await history.evaluate(el => el.scrollTop) - position)).toBeLessThan(2)
    await panel.getByRole('button', { name: 'Newest', exact: true }).click()
    const next = engine.postAssistant('t1', 'A completed response.\n\n'.repeat(20))
    await expect(panel.locator(`[data-message-id="${next}"]`)).toBeAttached()
    await expectBottom(history)
  } finally { await scenario.dispose(); await engine.close() }
})

test('Comment discussion opens oldest first and preserves position when a reply arrives', async ({}, testInfo) => {
  const engine = await startEngine()
  const scenario = await seededScenario(testInfo, engine.origin)
  try {
    const page = await scenario.launch()
    await page.setViewportSize({ width: 1440, height: 900 })
    const id = await page.evaluate(async (path) => {
      const id = await window.strata.addAnnotation(path, { kind: 'decision', anchor: 'document', quote: '', from: 0, to: 0, text: 'Original question', options: ['Yes', 'No'] })
      await window.strata.reply(path, id, 'Older reply')
      await window.strata.answerDecision(path, id, { option: 'Yes' })
      await window.strata.reopenDecision(path, id)
      await window.strata.reply(path, id, 'Newest reply. ' + 'A long passage response to read from the start. '.repeat(100))
      return id
    }, scenario.file)
    await page.getByRole('tablist', { name: 'Document review' }).getByRole('tab', { name: /^Items/ }).click()
    await page.locator('.annotations-panel .annotation-row').filter({ hasText: 'Original question' }).click()
    const panel = page.getByRole('region', { name: 'decision thread' })
    const history = panel.locator('.thread-panel-scroll')
    const rows = history.locator('[data-history-row]')
    await expect(rows.first()).toContainText('Original question')
    await expect(rows.nth(1)).toContainText('Older reply')
    await expect(rows.nth(2)).toContainText('chose “Yes”')
    await expect(rows.last()).toContainText('Newest reply.')
    await page.evaluate(() => document.fonts.ready)
    await panel.evaluate(async (el) => { await Promise.all(el.getAnimations({ subtree: true }).map((animation) => animation.finished)) })
    await expectBottom(history)
    await page.evaluate(async ({ path, id }) => { await window.strata.reply(path, id, 'Arrived at the bottom') }, { path: scenario.file, id })
    await expect(rows.last()).toContainText('Arrived at the bottom')
    await expectBottom(history)
    await panel.evaluate(async (el) => { await Promise.all(el.getAnimations({ subtree: true }).map((animation) => animation.finished)) })
    await history.evaluate((el) => { el.scrollTop = 350 })
    await expect.poll(() => history.evaluate((el) => el.scrollTop)).toBe(350)
    const reading = history.locator('.reply').filter({ hasText: 'Newest reply.' })
    const top = await reading.evaluate((el) => el.getBoundingClientRect().top)
    await page.evaluate(async ({ path, id }) => { await window.strata.reply(path, id, 'Just arrived') }, { path: scenario.file, id })
    await expect(rows.last()).toContainText('Just arrived')
    await expect.poll(async () => Math.abs(await reading.evaluate((el) => el.getBoundingClientRect().top) - top)).toBeLessThan(2)
    await panel.getByRole('button', { name: 'Close thread' }).click()
    await page.locator('.annotations-panel .annotation-row').filter({ hasText: 'Original question' }).click()
    await expectBottom(history)
    await expect(rows.last()).toBeInViewport()
    await expect(panel.getByRole('textbox', { name: 'Reply', exact: true })).toBeInViewport()
    await page.screenshot({ path: testInfo.outputPath('chronological-passage.png') })
  } finally { await scenario.dispose(); await engine.close() }
})
