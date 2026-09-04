import { expect, test, type Page, type TestInfo } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { Scenario, selectTextInVisualEditor } from './harness'

async function scenario(testInfo: TestInfo, content: string): Promise<Scenario> {
  const value = await Scenario.create(testInfo, content, 'cockpit-drafts.md')
  await value.launch()
  return value
}

async function openComment(page: Page, quote: string) {
  // Closing the composer restores the old editor selection on the next frame.
  // Clear it first so the next programmatic selection always emits a change.
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

test('5 and 6. quick send carries one comment while held drafts stay private and return checked', async ({}, testInfo) => {
  const original = '# Draft review\n\nFirst sentence. Second sentence. Third sentence.\n'
  const value = await scenario(testInfo, original)
  try {
    const page = value.page!
    expect((await value.attach('agent-a', 'Agent A')).event).toBe('initial')
    expect((await value.attach('agent-b', 'Agent B')).event).toBe('initial')

    let comment = await openComment(page, 'First sentence')
    await expect(comment.getByRole('checkbox', { name: 'Agent A' })).toBeChecked()
    await expect(comment.getByRole('checkbox', { name: 'Agent B' })).not.toBeChecked()
    await comment.getByRole('textbox', { name: /Annotation text/i }).fill('Held first.')
    await comment.getByRole('button', { name: 'Hold' }).click()

    comment = await openComment(page, 'Second sentence')
    await comment.getByRole('textbox', { name: /Annotation text/i }).fill('Held second.')
    await comment.getByRole('button', { name: 'Hold' }).click()

    const editor = page.getByRole('textbox', { name: /document editor/i })
    await editor.click()
    await page.keyboard.press('Control+End')
    await page.keyboard.type(' Batched edit.')

    comment = await openComment(page, 'Third sentence')
    await comment.getByRole('textbox', { name: /Annotation text/i }).fill('Send only this.')
    await comment.getByRole('textbox', { name: /Annotation text/i }).press('Enter')
    await expect(comment).toBeHidden()

    const delivered = await value.attach('agent-a', 'Agent A')
    expect(delivered.event).toBe('send')
    expect(delivered.annotations).toEqual([expect.objectContaining({ text: 'Send only this.', quote: 'Third sentence' })])
    expect(JSON.stringify(delivered)).not.toContain('Held first.')
    expect(JSON.stringify(delivered)).not.toContain('Held second.')
    expect((await value.attach('agent-b', 'Agent B')).event).toBe('timeout')

    await expect(page.locator('.strata-draft')).toHaveCount(2)
    await expect(page.locator('.strata-draft-chip')).toHaveText(['draft', 'draft'])
    const state = await value.state()
    expect(JSON.stringify(state)).not.toContain('Held first.')
    expect(await readFile(state.buffer!, 'utf8')).toBe(`${original.trimEnd()} Batched edit.\n`)

    const navigation = page.getByRole('tablist', { name: 'Document navigation' })
    await navigation.getByRole('tab', { name: 'Contents' }).click()
    await expect(page.locator('.outline-drafts')).toHaveText('2')

    await page.getByRole('button', { name: /^Send/i }).first().click()
    let send = page.getByRole('dialog', { name: /Send changes/i })
    await expect(send.getByText(/^Your changes/)).toBeVisible()
    await expect(send.locator('.send-item[data-author="user"]')).not.toHaveCount(0)
    await expect(send.getByText(/^Items/)).toHaveCount(0)
    await expect(send.getByText(/^Your comments · 2$/)).toBeVisible()
    await expect(send.locator('.send-item-draft')).toHaveCount(2)
    const rows = send.locator('.send-item-draft')
    await rows.nth(1).getByRole('checkbox').uncheck()
    await send.getByRole('button', { name: /^Send$/i }).click()
    await expect(send).toBeHidden()

    const oneDraft = await value.attach('agent-a', 'Agent A')
    expect(oneDraft.annotations?.map((item) => item.text)).toContain('Held first.')
    expect(JSON.stringify(oneDraft)).not.toContain('Held second.')
    await expect(page.locator('.strata-draft')).toHaveCount(1)

    await page.getByRole('button', { name: /^Send/i }).first().click()
    send = page.getByRole('dialog', { name: /Send changes/i })
    await expect(send.locator('.send-item-draft')).toHaveCount(1)
    await expect(send.locator('.send-item-draft').getByRole('checkbox')).toBeChecked()
    await send.getByRole('button', { name: /^Cancel$/i }).click()
  } finally {
    await value.dispose()
  }
})

test('7. the active conversation is the sole default until the Lead changes it', async ({}, testInfo) => {
  const value = await scenario(testInfo, '# Recipients\n\nChoose this passage. Choose the other passage.\n')
  try {
    const page = value.page!
    expect((await value.attach('agent-a', 'Agent A')).event).toBe('initial')
    expect((await value.attach('agent-b', 'Agent B')).event).toBe('initial')

    let comment = await openComment(page, 'Choose this passage')
    await expect(comment.getByRole('checkbox', { name: 'Agent A' })).toBeChecked()
    await expect(comment.getByRole('checkbox', { name: 'Agent B' })).not.toBeChecked()
    await comment.getByRole('textbox', { name: /Annotation text/i }).fill('Keep the recipient stable.')
    await expect(comment.getByRole('checkbox', { name: 'Agent A' })).toBeChecked()
    await expect(comment.getByRole('checkbox', { name: 'Agent B' })).not.toBeChecked()
    await page.keyboard.press('Escape')
    await expect(comment).toBeHidden()

    expect((await value.cli(['lead', value.file, '--as', 'agent-b'])).code).toBe(0)
    comment = await openComment(page, 'Choose the other passage')
    await expect(comment.getByRole('checkbox', { name: 'Agent A' })).not.toBeChecked()
    await expect(comment.getByRole('checkbox', { name: 'Agent B' })).toBeChecked()
    await comment.getByRole('textbox', { name: /Annotation text/i }).fill('Send this to both.')
    await comment.getByRole('button', { name: 'Hold' }).click()

    await page.getByRole('button', { name: /^Send/i }).first().click()
    const send = page.getByRole('dialog', { name: /Send changes/i })
    await expect(send.getByRole('checkbox', { name: 'Agent A' })).not.toBeChecked()
    await expect(send.getByRole('checkbox', { name: 'Agent B' })).toBeChecked()
    await send.getByRole('checkbox', { name: 'Agent A' }).check()
    await expect(send.getByRole('checkbox', { name: 'Agent A' })).toBeChecked()
    await expect(send.getByRole('checkbox', { name: 'Agent B' })).toBeChecked()
    await send.getByRole('button', { name: /^Send$/i }).click()
    await expect(send).toBeHidden()

    for (const [id, name] of [['agent-a', 'Agent A'], ['agent-b', 'Agent B']] as const) {
      const delivery = await value.attach(id, name)
      expect(delivery.event).toBe('send')
      expect(delivery.annotations?.map((item) => item.text)).toContain('Send this to both.')
    }
  } finally {
    await value.dispose()
  }
})

test('a held comment waits for an agent without enabling Send', async ({}, testInfo) => {
  const value = await scenario(testInfo, '# Draft review\n\nHold this passage.\n')
  try {
    const page = value.page!
    const comment = await openComment(page, 'Hold this passage')
    await comment.getByRole('textbox', { name: /Annotation text/i }).fill('Send this after an agent attaches.')
    await expect(comment.getByRole('button', { name: 'Hold' })).toBeEnabled()
    await expect(comment.getByRole('button', { name: 'Send' })).toBeDisabled()
    await expect(comment).toContainText('A held comment is sent once an agent is attached.')
    await comment.getByRole('button', { name: 'Hold' }).click()

    const navigation = page.getByRole('tablist', { name: 'Document navigation' })
    await navigation.getByRole('tab', { name: 'Contents' }).click()
    await expect(page.locator('.outline-drafts')).toHaveText('1')
    expect((await value.state()).event).toBe('state')
    expect(await page.evaluate(async () => (await window.strata.getState()).activeDocument?.canSend)).toBe(false)
  } finally {
    await value.dispose()
  }
})

test('an orphaned held draft stays out of preview and can be discarded', async ({}, testInfo) => {
  const quote = 'Orphan this passage.'
  const value = await scenario(testInfo, `# Draft review\n\n${quote}\n`)
  try {
    const page = value.page!
    expect((await value.attach('agent-a', 'Agent A')).event).toBe('initial')

    const comment = await openComment(page, quote)
    await comment.getByRole('textbox', { name: /Annotation text/i }).fill('This quote will disappear.')
    await comment.getByRole('button', { name: 'Hold' }).click()
    await expect(page.locator('.strata-draft')).toHaveCount(1)

    await selectTextInVisualEditor(page, quote)
    await page.keyboard.press('Backspace')
    await expect(page.getByRole('textbox', { name: /document editor/i })).not.toContainText(quote)

    await page.getByRole('button', { name: /^Send/i }).first().click()
    const send = page.getByRole('dialog', { name: /Send changes/i })
    const row = send.locator('.send-item-draft')
    await expect(send.locator('.send-tab-body')).toHaveAttribute('aria-busy', 'false')
    await expect(row).toHaveCount(1)
    await expect(row).toHaveAttribute('data-status', 'orphaned')
    await expect(row).toContainText('orphaned draft')
    await expect(row.getByRole('checkbox')).not.toBeChecked()

    await row.getByRole('button', { name: 'Discard' }).click()

    await expect(row).toHaveCount(0)
    await expect.poll(() => page.evaluate(async () => (await window.strata.getState()).activeDocument?.drafts.length)).toBe(0)
  } finally {
    await value.dispose()
  }
})
