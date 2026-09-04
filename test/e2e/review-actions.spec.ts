import { expect, test, type TestInfo } from '@playwright/test'
import { setSource, type Scenario } from './harness'
import { seededScenario, startEngine, type FakeEngine } from './cockpit-engine-harness'
import { agentActs, annotationByText, attachThread, openThread } from './cockpit-agent'

// Review actions (PRD §6.5, §6.9): suggestions in the item panel, the
// resolve confirmation, per-author Revert all, F7 stepping, non-inline
// suggestion rows, thread replies, and plain control names. The agent's
// suggestions and edits arrive as strata blocks from its thread (§5.9).

interface Fixture { value: Scenario; engine: FakeEngine }

async function scenario(testInfo: TestInfo, content: string, name: string): Promise<Fixture> {
  const engine = await startEngine({ titles: { t1: 'Agent A', t2: 'Agent B' } })
  const value = await seededScenario(testInfo, engine.origin, content, name)
  const page = await value.launch()
  await openThread(page, 'Agent A')
  await attachThread(page, 't1', 'Agent A')
  await page.getByRole('tablist', { name: 'Document navigation' }).getByRole('tab', { name: 'Contents' }).click()
  return { value, engine }
}

async function dispose(fixture: Fixture): Promise<void> {
  await fixture.value.dispose()
  await fixture.engine.close()
}

async function suggest({ value, engine }: Fixture, quote: string, text: string): Promise<string> {
  agentActs(engine, 't1', [{ verb: 'suggest', anchor: { document: value.file, quote }, replacement: text }])
  return (await annotationByText(value, text)).id
}

/** Agent A edits every listed passage in one message. */
async function agentEditsAll({ value, engine }: Fixture, edits: Array<[quote: string, replace: string]>): Promise<void> {
  agentActs(engine, 't1', edits.map(([quote, replace]) => ({ verb: 'edit', anchor: { document: value.file, quote }, match: quote, replace })))
  await expect(value.page!.getByRole('button', { name: /^Keep change by Agent A: / })).toHaveCount(edits.length)
}

test('the item panel accepts, rejects, and confirms before resolving an open suggestion', async ({}, testInfo) => {
  const original = '# Thread\n\nFirst wording here.\n\nSecond wording here.\n\nThird wording here.\n'
  const fixture = await scenario(testInfo, original, 'thread.md')
  const { value } = fixture
  try {
    const page = value.page!
    const first = await suggest(fixture, 'First wording', 'first replacement')
    const second = await suggest(fixture, 'Second wording', 'second replacement')
    const third = await suggest(fixture, 'Third wording', 'third replacement')
    const rows = page.locator('.changes-panel .change-row')
    await expect(rows).toHaveCount(3)

    // Resolve asks first; Cancel changes nothing.
    await rows.filter({ hasText: 'first replacement' }).click()
    const thread = page.getByRole('region', { name: /suggestion thread/i })
    await expect(thread).toBeVisible()
    await thread.getByRole('button', { name: /Resolve thread/i }).click()
    const confirm = page.getByRole('dialog', { name: /Resolve this suggestion\?/i })
    await expect(confirm).toContainText("This suggestion hasn't been accepted or rejected. Resolving hides it without changing the text.")
    await confirm.getByRole('button', { name: 'Cancel' }).click()
    await expect(confirm).toBeHidden()
    await expect(thread).toBeVisible()

    await thread.getByRole('button', { name: 'Accept' }).click()
    await expect.poll(async () => (await value.inspectDocument()).document).toContain('first replacement')
    await expect.poll(async () => (await value.inspectDocument()).annotations?.find((item) => item.id === first)?.status).toBe('resolved')

    await rows.filter({ hasText: 'second replacement' }).click()
    await thread.getByRole('button', { name: 'Reject' }).click()
    await expect.poll(async () => (await value.inspectDocument()).annotations?.find((item) => item.id === second)?.status).toBe('resolved')
    expect((await value.inspectDocument()).document).not.toContain('second replacement')
    expect((await value.inspectDocument()).document).toContain('Second wording here.')

    // Resolving anyway hides the suggestion and leaves the text alone.
    await rows.filter({ hasText: 'third replacement' }).click()
    await thread.getByRole('button', { name: /Resolve thread/i }).click()
    await page.getByRole('dialog', { name: /Resolve this suggestion\?/i }).getByRole('button', { name: 'Resolve anyway' }).click()
    await expect(thread).toBeHidden()
    await expect.poll(async () => (await value.inspectDocument()).annotations?.find((item) => item.id === third)?.status).toBe('resolved')
    expect((await value.inspectDocument()).document).toContain('Third wording here.')
    expect((await value.inspectDocument()).document).not.toContain('third replacement')
  } finally {
    await dispose(fixture)
  }
})

test('a thread reply is a text box where Enter sends and Shift+Enter breaks the line', async ({}, testInfo) => {
  const fixture = await scenario(testInfo, '# Reply\n\nQuote this sentence.\n', 'reply.md')
  const { value, engine } = fixture
  try {
    const page = value.page!
    agentActs(engine, 't1', [{ verb: 'question', anchor: { document: value.file, quote: 'Quote this sentence.' }, text: 'Which way?' }])
    await annotationByText(value, 'Which way?')
    await page.getByRole('tablist', { name: 'Document review' }).getByRole('tab', { name: /^Items/ }).click()
    await page.locator('.annotations-panel').getByRole('button').filter({ hasText: 'Quote this sentence.' }).click()
    const thread = page.getByRole('region', { name: /question thread/i })
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
      const payload = await value.inspectDocument() as unknown as { annotations?: Array<{ replies?: Array<{ text: string }> }> }
      return payload.annotations?.flatMap((item) => item.replies ?? []).map((item) => item.text) ?? []
    }).toContain('Line one\nLine two')
  } finally {
    await dispose(fixture)
  }
})

test('Revert all confirms with the count and author, then reverts every change by that author', async ({}, testInfo) => {
  const paragraphs = Array.from({ length: 30 }, (_, index) => `Paragraph ${index + 1} keeps the document long enough to scroll.`)
  const original = `# Bulk\n\nTop sentence.\n\n${paragraphs.join('\n\n')}\n\nBottom sentence.\n`
  const fixture = await scenario(testInfo, original, 'bulk.md')
  const { value } = fixture
  try {
    const page = value.page!
    await agentEditsAll(fixture, [['Top sentence.', 'Top sentence, rewritten.'], ['Bottom sentence.', 'Bottom sentence, rewritten.']])
    const bulk = page.locator('.suggestion-bulk-row').filter({ hasText: 'Agent A · 2 changes' })
    await expect(bulk).toBeVisible()
    await bulk.getByRole('button', { name: 'Revert all' }).click()
    const dialog = page.getByRole('dialog', { name: /Revert 2 changes by Agent A\?/i })
    await expect(dialog).toBeVisible()
    await expect(dialog).not.toContainText(/hunk|buffer|shadow|external/i)
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toBeHidden()
    expect((await value.inspectDocument()).document).toContain('Top sentence, rewritten.')

    await bulk.getByRole('button', { name: 'Revert all' }).click()
    await dialog.getByRole('button', { name: 'Revert all' }).click()
    await expect.poll(async () => (await value.inspectDocument()).document).toBe(original)
    await expect(page.getByRole('status')).toContainText('2 changes by Agent A reverted.')
    await expect(page.locator('.changes-panel .empty-state')).toContainText('All caught up.')
  } finally {
    await dispose(fixture)
  }
})

test('F7 and Shift+F7 step through pending changes and open suggestions in document order', async ({}, testInfo) => {
  const paragraphs = Array.from({ length: 30 }, (_, index) => `Paragraph ${index + 1} keeps the document long enough to scroll.`)
  const original = `# Step\n\nTop sentence.\n\n${paragraphs.join('\n\n')}\n\nBottom sentence.\n`
  const fixture = await scenario(testInfo, original, 'step.md')
  const { value } = fixture
  try {
    const page = value.page!
    await agentEditsAll(fixture, [['Top sentence.', 'Top sentence, rewritten.'], ['Bottom sentence.', 'Bottom sentence, rewritten.']])
    await suggest(fixture, 'Paragraph 15', 'Paragraph fifteen')
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
    await dispose(fixture)
  }
})

test('a suggestion that cannot render inline keeps Accept and Reject on its rail row', async ({}, testInfo) => {
  const fixture = await scenario(testInfo, '# Rail\n\nOne paragraph to split.\n', 'rail.md')
  const { value } = fixture
  try {
    const page = value.page!
    await suggest(fixture, 'One paragraph to split.', 'First half.\n\nSecond half.')
    const row = page.locator('.changes-panel .change-row-actions')
    await expect(row).toBeVisible()
    await expect(row).toContainText('Agent A')
    await row.getByRole('button', { name: 'Reject' }).click()
    await expect.poll(async () => (await value.inspectDocument()).annotations?.find((item) => item.kind === 'suggestion')?.status).toBe('resolved')
    expect((await value.inspectDocument()).document).toContain('One paragraph to split.')
    await expect(row).toHaveCount(0)
  } finally {
    await dispose(fixture)
  }
})

test('control names and headings use plain words: author and excerpt, not ids or internal vocabulary', async ({}, testInfo) => {
  const original = '# Copy\n\nThe original sentence stays here.\n'
  const fixture = await scenario(testInfo, original, 'copy.md')
  const { value } = fixture
  try {
    const page = value.page!
    // Attached before Agent A writes, so Agent A's change is news to it later.
    await openThread(page, 'Agent B')
    await attachThread(page, 't2', 'Agent B')
    await openThread(page, 'Agent A')
    await page.getByRole('tablist', { name: 'Document navigation' }).getByRole('tab', { name: 'Contents' }).click()
    await agentEditsAll(fixture, [['The original sentence stays here.', 'The rewritten sentence stays here.']])
    const keep = page.getByRole('button', { name: /^Keep change by Agent A: / }).first()
    await expect(keep).toBeVisible()
    await expect(keep).toHaveAttribute('aria-label', /^Keep change by Agent A: .*rewritten/)
    await expect(page.getByRole('button', { name: /^Revert change by Agent A: / }).first()).toBeVisible()

    await suggest(fixture, 'stays here', 'remains here')
    await expect(page.getByRole('button', { name: /^Accept suggestion by Agent A: remains here/ }).first()).toBeVisible()
    await expect(page.getByRole('button', { name: /^Reject suggestion by Agent A: remains here/ }).first()).toBeVisible()

    // The composer's headings speak to "you" throughout. Agent A's own change
    // is never echoed to it; Agent B sees it as not made by you.
    const edited = '# Copy\n\nThe rewritten sentence stays here.\n\nOwner line.\n'
    await setSource(page, edited)
    await value.waitForBuffer(edited)
    await page.getByRole('button', { name: /^Send/i }).first().click()
    const composer = page.getByRole('dialog', { name: /Send changes/i })
    await composer.getByRole('checkbox', { name: 'Agent B' }).check()
    await composer.getByRole('tab', { name: 'Agent B' }).click()
    await expect(composer.locator('.send-group-heading').filter({ hasText: 'Changes not made by you' })).toBeVisible()
    await expect(composer).not.toContainText('not made by me')
  } finally {
    await dispose(fixture)
  }
})
