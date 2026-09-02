import { expect, test, type TestInfo } from '@playwright/test'
import { Scenario, setSource } from './harness'

// Review actions (PRD §6.5, §6.9): suggestions in the thread panel, the
// resolve confirmation, per-author Revert all, F7 stepping, non-inline
// suggestion rows, thread replies, and plain control names.

async function scenario(testInfo: TestInfo, content: string, name: string): Promise<Scenario> {
  const value = await Scenario.create(testInfo, content, name)
  await value.launch()
  expect((await value.attach('agent-a', 'Agent A')).event).toBe('initial')
  return value
}

async function suggest(value: Scenario, quote: string, text: string): Promise<string> {
  const result = await value.cli(['annotate', value.file, '--kind', 'suggestion', '--quote', quote, '--text', text, '--as', 'agent-a'])
  expect(result.code, result.stderr).toBe(0)
  const state = await value.state()
  const created = state.annotations?.find((item) => item.kind === 'suggestion' && item.quote === quote)
  expect(created, JSON.stringify(state.annotations)).toBeTruthy()
  return created!.id
}

async function writeTaggedBuffer(value: Scenario, content: string): Promise<void> {
  const state = await value.state()
  expect(state.buffer).toBeTruthy()
  await value.tag('agent-a', 'Agent A')
  await value.atomicWrite(state.buffer!, content)
}

test('the thread panel accepts, rejects, and confirms before resolving an open suggestion', async ({}, testInfo) => {
  const original = '# Thread\n\nFirst wording here.\n\nSecond wording here.\n\nThird wording here.\n'
  const value = await scenario(testInfo, original, 'thread.md')
  try {
    const page = value.page!
    const first = await suggest(value, 'First wording', 'first replacement')
    const second = await suggest(value, 'Second wording', 'second replacement')
    const third = await suggest(value, 'Third wording', 'third replacement')
    const rows = page.locator('.changes-panel .change-row')
    await expect(rows).toHaveCount(3)

    // Resolve asks first; Cancel changes nothing.
    await rows.filter({ hasText: 'first replacement' }).click()
    const thread = page.getByRole('dialog', { name: /suggestion thread/i })
    await expect(thread).toBeVisible()
    await thread.getByRole('button', { name: /Resolve thread/i }).click()
    const confirm = page.getByRole('dialog', { name: /Resolve this suggestion\?/i })
    await expect(confirm).toContainText("This suggestion hasn't been accepted or rejected. Resolving hides it without changing the text.")
    await confirm.getByRole('button', { name: 'Cancel' }).click()
    await expect(confirm).toBeHidden()
    await expect(thread).toBeVisible()

    await thread.getByRole('button', { name: 'Accept' }).click()
    await expect.poll(async () => (await value.state()).document).toContain('first replacement')
    await expect.poll(async () => (await value.state()).annotations?.find((item) => item.id === first)?.status).toBe('resolved')

    await rows.filter({ hasText: 'second replacement' }).click()
    await thread.getByRole('button', { name: 'Reject' }).click()
    await expect.poll(async () => (await value.state()).annotations?.find((item) => item.id === second)?.status).toBe('resolved')
    expect((await value.state()).document).not.toContain('second replacement')
    expect((await value.state()).document).toContain('Second wording here.')

    // Resolving anyway hides the suggestion and leaves the text alone.
    await rows.filter({ hasText: 'third replacement' }).click()
    await thread.getByRole('button', { name: /Resolve thread/i }).click()
    await page.getByRole('dialog', { name: /Resolve this suggestion\?/i }).getByRole('button', { name: 'Resolve anyway' }).click()
    await expect(thread).toBeHidden()
    await expect.poll(async () => (await value.state()).annotations?.find((item) => item.id === third)?.status).toBe('resolved')
    expect((await value.state()).document).toContain('Third wording here.')
    expect((await value.state()).document).not.toContain('third replacement')
  } finally {
    await value.dispose()
  }
})

test('a thread reply is a text box where Enter sends and Shift+Enter breaks the line', async ({}, testInfo) => {
  const value = await scenario(testInfo, '# Reply\n\nQuote this sentence.\n', 'reply.md')
  try {
    const page = value.page!
    const created = await value.cli(['annotate', value.file, '--kind', 'question', '--quote', 'Quote this sentence.', '--text', 'Which way?', '--as', 'agent-a'])
    expect(created.code, created.stderr).toBe(0)
    await page.locator('.annotations-panel').getByRole('button').filter({ hasText: 'Quote this sentence.' }).click()
    const thread = page.getByRole('dialog', { name: /question thread/i })
    const reply = thread.getByRole('textbox', { name: 'Reply' })
    expect(await reply.evaluate((element) => element.tagName.toLowerCase())).toBe('textarea')
    await reply.click()
    await page.keyboard.type('Line one')
    await page.keyboard.press('Shift+Enter')
    await page.keyboard.type('Line two')
    await expect(reply).toHaveValue('Line one\nLine two')
    await page.keyboard.press('Enter')
    await expect(reply).toHaveValue('')
    await expect.poll(async () => {
      const payload = await value.state() as unknown as { annotations?: Array<{ replies?: Array<{ text: string }> }> }
      return payload.annotations?.flatMap((item) => item.replies ?? []).map((item) => item.text) ?? []
    }).toContain('Line one\nLine two')
  } finally {
    await value.dispose()
  }
})

test('Revert all confirms with the count and author, then reverts every change by that author', async ({}, testInfo) => {
  const paragraphs = Array.from({ length: 30 }, (_, index) => `Paragraph ${index + 1} keeps the document long enough to scroll.`)
  const original = `# Bulk\n\nTop sentence.\n\n${paragraphs.join('\n\n')}\n\nBottom sentence.\n`
  const value = await scenario(testInfo, original, 'bulk.md')
  try {
    const page = value.page!
    await writeTaggedBuffer(value, original.replace('Top sentence.', 'Top sentence, rewritten.').replace('Bottom sentence.', 'Bottom sentence, rewritten.'))
    await expect(page.getByRole('button', { name: /^Keep change by Agent A: / })).toHaveCount(2)
    const bulk = page.locator('.suggestion-bulk-row').filter({ hasText: 'Agent A · 2 changes' })
    await expect(bulk).toBeVisible()
    await bulk.getByRole('button', { name: 'Revert all' }).click()
    const dialog = page.getByRole('dialog', { name: /Revert 2 changes by Agent A\?/i })
    await expect(dialog).toBeVisible()
    await expect(dialog).not.toContainText(/hunk|buffer|shadow|external/i)
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toBeHidden()
    expect((await value.state()).document).toContain('Top sentence, rewritten.')

    await bulk.getByRole('button', { name: 'Revert all' }).click()
    await dialog.getByRole('button', { name: 'Revert all' }).click()
    await expect.poll(async () => (await value.state()).document).toBe(original)
    await expect(page.getByRole('status')).toContainText('2 changes by Agent A reverted.')
    await expect(page.locator('.changes-panel .empty-state')).toContainText('All caught up.')
  } finally {
    await value.dispose()
  }
})

test('F7 and Shift+F7 step through pending changes and open suggestions in document order', async ({}, testInfo) => {
  const paragraphs = Array.from({ length: 30 }, (_, index) => `Paragraph ${index + 1} keeps the document long enough to scroll.`)
  const original = `# Step\n\nTop sentence.\n\n${paragraphs.join('\n\n')}\n\nBottom sentence.\n`
  const value = await scenario(testInfo, original, 'step.md')
  try {
    const page = value.page!
    await writeTaggedBuffer(value, original.replace('Top sentence.', 'Top sentence, rewritten.').replace('Bottom sentence.', 'Bottom sentence, rewritten.'))
    await expect(page.getByRole('button', { name: /^Keep change by Agent A: / })).toHaveCount(2)
    await suggest(value, 'Paragraph 15', 'Paragraph fifteen')
    const editor = page.getByRole('textbox', { name: /Document editor/i })

    await page.keyboard.press('F7')
    const first = editor.locator('.strata-review-change.is-flashing')
    await expect(first).toHaveCount(1)
    await expect(first).toContainText('rewritten')
    await expect(first).toBeInViewport()
    const topId = await first.getAttribute('data-review-id')

    await page.keyboard.press('F7')
    const suggestion = editor.locator('.strata-annotation.is-flashing')
    await expect(suggestion).toHaveCount(1)
    await expect(suggestion).toBeInViewport()

    await page.keyboard.press('F7')
    const last = editor.locator('.strata-review-change.is-flashing')
    await expect(last).toHaveCount(1)
    await expect(last).not.toHaveAttribute('data-review-id', topId!)
    await expect(last).toBeInViewport()
    const bottomId = await last.getAttribute('data-review-id')

    // Wraps around, and Shift+F7 goes back.
    await page.keyboard.press('F7')
    await expect(editor.locator('.strata-review-change.is-flashing')).toHaveAttribute('data-review-id', topId!)
    await page.keyboard.press('Shift+F7')
    await expect(editor.locator('.strata-review-change.is-flashing')).toHaveAttribute('data-review-id', bottomId!)
  } finally {
    await value.dispose()
  }
})

test('a suggestion that cannot render inline keeps Accept and Reject on its rail row', async ({}, testInfo) => {
  const value = await scenario(testInfo, '# Rail\n\nOne paragraph to split.\n', 'rail.md')
  try {
    const page = value.page!
    await suggest(value, 'One paragraph to split.', 'First half.\n\nSecond half.')
    const row = page.locator('.changes-panel .change-row-actions')
    await expect(row).toBeVisible()
    await expect(row).toContainText('Agent A')
    await row.getByRole('button', { name: 'Reject' }).click()
    await expect.poll(async () => (await value.state()).annotations?.find((item) => item.kind === 'suggestion')?.status).toBe('resolved')
    expect((await value.state()).document).toContain('One paragraph to split.')
    await expect(row).toHaveCount(0)
  } finally {
    await value.dispose()
  }
})

test('control names and headings use plain words: author and excerpt, not ids or internal vocabulary', async ({}, testInfo) => {
  const original = '# Copy\n\nThe original sentence stays here.\n'
  const value = await scenario(testInfo, original, 'copy.md')
  try {
    const page = value.page!
    // Attached before Agent A writes, so Agent A's change is news to it later.
    expect((await value.attach('agent-b', 'Agent B')).event).toBe('initial')
    await writeTaggedBuffer(value, '# Copy\n\nThe rewritten sentence stays here.\n')
    const keep = page.getByRole('button', { name: /^Keep change by Agent A: / }).first()
    await expect(keep).toBeVisible()
    await expect(keep).toHaveAttribute('aria-label', /^Keep change by Agent A: .*rewritten/)
    await expect(page.getByRole('button', { name: /^Revert change by Agent A: / }).first()).toBeVisible()

    await suggest(value, 'stays here', 'remains here')
    await expect(page.getByRole('button', { name: /^Accept suggestion by Agent A: remains here/ }).first()).toBeVisible()
    await expect(page.getByRole('button', { name: /^Reject suggestion by Agent A: remains here/ }).first()).toBeVisible()

    // The composer's headings speak to "you" throughout. Agent A's own change
    // is never echoed to it; Agent B sees it as not made by you.
    const edited = '# Copy\n\nThe rewritten sentence stays here.\n\nOwner line.\n'
    await setSource(page, edited)
    await value.waitForBuffer(edited)
    await page.getByRole('button', { name: /^Send/i }).first().click()
    const composer = page.getByRole('dialog', { name: /Send changes/i })
    await composer.getByRole('tab', { name: 'Agent B' }).click()
    await expect(composer.locator('.send-group-heading').filter({ hasText: 'Changes not made by you' })).toBeVisible()
    await expect(composer).not.toContainText('not made by me')
  } finally {
    await value.dispose()
  }
})
