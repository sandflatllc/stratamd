import { expect, test, type Page, type TestInfo } from '@playwright/test'
import { selectTextInVisualEditor } from './harness'
import { seededScenario, startEngine } from './cockpit-engine-harness'

async function openComment(page: Page, quote: string) {
  await page.waitForTimeout(100)
  await page.evaluate(() => window.getSelection()?.removeAllRanges())
  await selectTextInVisualEditor(page, quote)
  const menu = page.getByRole('menu', { name: /Annotate selection/i })
  await expect(menu).toBeVisible()
  await menu.getByRole('menuitem', { name: /Comment/i }).click()
  const composer = page.locator('.annotation-composer')
  await expect(composer).toBeVisible()
  return composer
}

async function openThread(page: Page, name: string): Promise<void> {
  const navigation = page.getByRole('tablist', { name: 'Document navigation' })
  await navigation.getByRole('tab', { name: 'Projects' }).click()
  await page.getByRole('button', { name: `Open ${name}`, exact: true }).click()
}

async function attachThread(page: Page, threadId: string): Promise<void> {
  await page.evaluate(async (id) => {
    const document = (await window.strata.getState()).activeDocument!
    const request = { recipients: [id], note: '', includeExternal: false }
    const [preview] = await window.strata.previewSend(document.path, request)
    await window.strata.send(document.path, { ...request, token: preview!.token })
  }, threadId)
}

async function closeEngine(engine: Awaited<ReturnType<typeof startEngine>>): Promise<void> {
  await engine.close()
}

test('5 and 6: quick send carries one comment while held drafts stay private and return checked', async ({}, testInfo: TestInfo) => {
  const engine = await startEngine()
  const original = '# Draft review\n\nFirst sentence. Second sentence. Third sentence.\n'
  const scenario = await seededScenario(testInfo, engine.origin, original, 'cockpit-drafts.md')
  try {
    const page = await scenario.launch()
    await openThread(page, 'Live engine thread')
    await attachThread(page, 't1')
    await expect.poll(() => engine.uploads.length).toBe(1)

    for (const [quote, text] of [['First sentence', 'Held first.'], ['Second sentence', 'Held second.']] as const) {
      const comment = await openComment(page, quote)
      await comment.getByRole('textbox', { name: /Annotation text/i }).fill(text)
      await comment.getByRole('button', { name: 'Hold' }).click()
    }

    const quick = await openComment(page, 'Third sentence')
    await expect(quick.getByRole('checkbox', { name: 'Live engine thread' })).toBeChecked()
    await quick.getByRole('textbox', { name: /Annotation text/i }).fill('Send only this.')
    await quick.getByRole('textbox', { name: /Annotation text/i }).press('Enter')
    await expect.poll(() => engine.uploads.length).toBe(2)
    expect(engine.uploads[1]).toContain('Send only this.')
    expect(engine.uploads[1]).not.toContain('Held first.')
    expect(engine.uploads[1]).not.toContain('Held second.')
    await expect(page.locator('.strata-draft')).toHaveCount(2)

    await page.getByRole('button', { name: /^Send/i }).first().click()
    let send = page.getByRole('dialog', { name: /Send changes/i })
    await expect(send.getByText(/^Your comments · 2$/)).toBeVisible()
    const rows = send.locator('.send-item-draft')
    await rows.nth(1).getByRole('checkbox').uncheck()
    await send.getByRole('button', { name: /^Send$/i }).click()
    await expect.poll(() => engine.uploads.length).toBe(3)
    expect(engine.uploads[2]).toContain('Held first.')
    expect(engine.uploads[2]).not.toContain('Held second.')
    await expect(page.locator('.strata-draft')).toHaveCount(1)

    await page.getByRole('button', { name: /^Send/i }).first().click()
    send = page.getByRole('dialog', { name: /Send changes/i })
    await expect(send.locator('.send-item-draft')).toHaveCount(1)
    await expect(send.locator('.send-item-draft').getByRole('checkbox')).toBeChecked()
  } finally {
    await scenario.dispose()
    await closeEngine(engine)
  }
})

test('7: active conversation is the sole default until Lead changes it', async ({}, testInfo: TestInfo) => {
  const engine = await startEngine()
  const scenario = await seededScenario(testInfo, engine.origin, '# Recipients\n\nChoose this passage. Choose the other passage.\n', 'cockpit-recipients.md')
  try {
    const page = await scenario.launch()
    await openThread(page, 'Live engine thread')
    await attachThread(page, 't1')
    await openThread(page, 'Second engine thread')
    await attachThread(page, 't2')
    await openThread(page, 'Live engine thread')

    let comment = await openComment(page, 'Choose this passage')
    await expect(comment.getByRole('checkbox', { name: 'Live engine thread' })).toBeChecked()
    await expect(comment.getByRole('checkbox', { name: 'Second engine thread' })).not.toBeChecked()
    await page.keyboard.press('Escape')

    const path = await page.evaluate(async () => (await window.strata.getState()).activeDocument!.path)
    await page.evaluate(({ path }) => window.strata.setLead(path, 't2'), { path })
    comment = await openComment(page, 'Choose the other passage')
    await expect(comment.getByRole('checkbox', { name: 'Live engine thread' })).not.toBeChecked()
    await expect(comment.getByRole('checkbox', { name: 'Second engine thread' })).toBeChecked()
    await comment.getByRole('checkbox', { name: 'Live engine thread' }).dispatchEvent('click')
    await expect(comment.getByRole('checkbox', { name: 'Live engine thread' })).toBeChecked()
    await expect(comment.getByRole('checkbox', { name: 'Second engine thread' })).toBeChecked()
  } finally {
    await scenario.dispose()
    await closeEngine(engine)
  }
})
