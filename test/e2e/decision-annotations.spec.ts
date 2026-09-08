import { expect, test } from './test'
import { Scenario, lineEndKey, selectTextInVisualEditor } from './harness'
import { seededScenario, startEngine } from './cockpit-engine-harness'
import { agentActs, annotationByText, attachThread, openThread, uploadsFor } from './cockpit-agent'

const original = '# Review\n\n## Delivery\n\nChoose the release gate.\n'

test('owner decisions keep choice, discussion, delivery, and edits separate', async ({}, testInfo) => {
  const engine = await startEngine({ titles: { t1: 'Agent A' } })
  const scenario = await seededScenario(testInfo, engine.origin, original, 'decisions.md')
  try {
    const page = await scenario.launch()
    await openThread(page, 'Agent A')
    await attachThread(page, engine, 't1', 'Agent A')
    await page.getByRole('tablist', { name: 'Document navigation' }).getByRole('tab', { name: 'Contents' }).click()

    await page.getByRole('tablist', { name: 'Document review' }).getByRole('tab', { name: /^Items/ }).click()
    const annotations = page.locator('.annotations-panel')
    await annotations.getByRole('button', { name: 'New decision' }).click()
    await annotations.getByRole('combobox', { name: 'Decision anchor' }).selectOption({ label: '## Delivery' })
    await annotations.getByRole('textbox', { name: 'Decision prompt' }).fill('Which release gate should we use?')
    await annotations.getByRole('textbox', { name: 'Decision choice 1' }).fill('Use CI')
    await annotations.getByRole('textbox', { name: 'Decision choice 2' }).fill('Manual review')
    await annotations.getByRole('button', { name: 'Add decision' }).click()

    await expect.poll(async () => (await scenario.inspectDocument()).annotations?.find((item) => item.kind === 'decision')).toMatchObject({
      status: 'open',
      anchor: 'heading',
      quote: '## Delivery',
      text: 'Which release gate should we use?',
      decision: { options: ['Use CI', 'Manual review'], answers: [] },
    })
    const created = (await scenario.inspectDocument()).annotations?.find((item) => item.kind === 'decision')
    expect(created).toBeTruthy()

    // The agent takes the Lead and discusses; it cannot answer or resolve an owner decision (§5.6).
    agentActs(engine, 't1', [
      { verb: 'lead', document: scenario.file, action: 'claim' },
      { verb: 'reply', anchor: { item: created!.id }, text: 'CI gives us the clearest audit trail.' },
      { verb: 'resolve', anchor: { item: created!.id } },
    ])
    await expect.poll(async () => (await scenario.inspectDocument()).attachments?.find((item) => item.agent === 't1')?.lead).toBe(true)

    const decisionRow = annotations.getByRole('button').filter({ hasText: 'Which release gate should we use?' })
    await decisionRow.click()
    const thread = page.getByRole('region', { name: /decision thread/i })
    await expect(thread).toContainText('CI gives us the clearest audit trail.')
    await thread.getByRole('radio', { name: 'Use CI' }).check()
    await thread.getByRole('button', { name: 'Answer decision' }).click()
    await expect(thread).toContainText('chose “Use CI”')
    await expect(thread.getByRole('button', { name: /Reopen decision/i })).toBeVisible()

    const answered = (await scenario.inspectDocument()).annotations?.find((item) => item.id === created!.id)
    expect(answered).toMatchObject({
      status: 'resolved',
      decision: { answers: [{ option: 'Use CI', author: 'user' }] },
    })
    expect((await scenario.inspectDocument()).document).toBe(original)
    expect((await scenario.inspectDocument()).segments ?? []).toEqual([])

    await thread.getByRole('button', { name: 'Close thread' }).click()
    await page.getByRole('button', { name: /^Send(?:\b|$)/i }).first().click()
    const send = page.getByRole('dialog', { name: /Send changes/i })
    const answerItem = send.locator('.send-item-event').filter({ hasText: 'answered decision' })
    await expect(answerItem).toContainText('Use CI')
    await expect(answerItem.getByRole('checkbox')).toBeChecked()
    await expect(send.getByText(/^Your changes/)).toHaveCount(0)
    await send.getByRole('button', { name: /^Send$/ }).click()
    await expect(send).toBeHidden()

    // The delivery carries the answer, and the refused resolve is reported by its code.
    await expect.poll(() => uploadsFor(engine, 't1').length).toBe(2)
    const delivery = uploadsFor(engine, 't1')[1]!
    expect(delivery).toContain('Which release gate should we use?')
    expect(delivery).toContain('chose "Use CI"')
    expect(delivery).toContain('1. applied')
    expect(delivery).toContain('2. applied as')
    expect(delivery).toContain('3. failed: DECISION_OWNER_REQUIRED')

    await annotations.getByRole('button', { name: 'Resolved', exact: true }).click()
    await annotations.getByRole('button').filter({ hasText: 'Which release gate should we use?' }).click()
    const resolvedThread = page.getByRole('region', { name: /decision thread/i })
    await resolvedThread.getByRole('button', { name: /Reopen decision/i }).click()
    // Reopen schedules IPC work; the click itself does not acknowledge its completion.
    await expect.poll(async () => (await scenario.inspectDocument()).annotations?.find((item) => item.id === created!.id)).toMatchObject({
      status: 'open',
      decision: { answers: [{ option: 'Use CI', author: 'user' }] },
    })
  } finally {
    await scenario.dispose()
    await engine.close()
  }
})

test('keyboard passage and rail document decisions expose explicit anchors', async ({}, testInfo) => {
  const scenario = await Scenario.create(testInfo, original, 'decision-anchors.md')
  try {
    const page = await scenario.launch()
    await selectTextInVisualEditor(page, 'Choose the release gate.')
    await expect(page.getByRole('menu', { name: /annotate selection/i })).toBeVisible()
    await page.keyboard.press('d')
    const composer = page.locator('.annotation-composer')
    await expect(composer.getByRole('radio', { name: 'Decision' })).toHaveAttribute('aria-checked', 'true')
    await composer.getByRole('textbox', { name: 'Decision prompt' }).fill('How should this passage change?')
    await composer.getByRole('textbox', { name: 'Choice 1' }).fill('Keep it')
    await composer.getByRole('textbox', { name: 'Choice 2' }).fill('Rewrite it')
    await composer.getByRole('button', { name: 'Add', exact: true }).click()
    await expect(composer).toHaveCount(0)

    await page.getByRole('tablist', { name: 'Document review' }).getByRole('tab', { name: /^Items/ }).click()
    const annotations = page.locator('.annotations-panel')
    await annotations.getByRole('button', { name: 'New decision' }).click()
    await expect(annotations.getByRole('combobox', { name: 'Decision anchor' })).toHaveValue('document')
    await annotations.getByRole('textbox', { name: 'Decision prompt' }).fill('Is the document ready?')
    await annotations.getByRole('textbox', { name: 'Decision choice 1' }).fill('Ready')
    await annotations.getByRole('textbox', { name: 'Decision choice 2' }).fill('Needs work')
    await annotations.getByRole('button', { name: 'Add decision' }).click()

    const title = page.getByRole('heading', { name: 'Review', exact: true })
    await title.click({ position: { x: 8, y: 8 } })
    await page.keyboard.press(lineEndKey)
    await page.keyboard.press('Enter')
    await page.keyboard.insertText('Inserted above the decision heading.')
    await annotations.getByRole('button', { name: 'New decision' }).click()
    await annotations.getByRole('combobox', { name: 'Decision anchor' }).selectOption({ label: '## Delivery' })
    await annotations.getByRole('textbox', { name: 'Decision prompt' }).fill('Does the shifted heading still anchor?')
    await annotations.getByRole('textbox', { name: 'Decision choice 1' }).fill('Yes')
    await annotations.getByRole('textbox', { name: 'Decision choice 2' }).fill('No')
    await annotations.getByRole('button', { name: 'Add decision' }).click()

    const decisions = (await scenario.inspectDocument()).annotations?.filter((item) => item.kind === 'decision') ?? []
    expect(decisions).toEqual(expect.arrayContaining([
      expect.objectContaining({ anchor: 'quote', quote: 'Choose the release gate.' }),
      expect.objectContaining({ anchor: 'document', quote: '' }),
      expect.objectContaining({ anchor: 'heading', quote: '## Delivery', text: 'Does the shifted heading still anchor?' }),
    ]))
  } finally {
    await scenario.dispose()
  }
})

test('an orphaned decision remains answerable', async ({}, testInfo) => {
  const engine = await startEngine({ titles: { t1: 'Agent A' } })
  const scenario = await seededScenario(testInfo, engine.origin, '# Review\n\nChoose the release gate.\n', 'orphaned-decision.md')
  try {
    const page = await scenario.launch()
    await openThread(page, 'Agent A')
    await attachThread(page, engine, 't1', 'Agent A')
    await page.getByRole('tablist', { name: 'Document navigation' }).getByRole('tab', { name: 'Contents' }).click()
    agentActs(engine, 't1', [{ verb: 'decision', anchor: { document: scenario.file, quote: 'Choose the release gate.' }, text: 'Which gate?', options: ['CI', 'Manual'] }])
    const id = (await annotationByText(scenario, 'Which gate?')).id
    await selectTextInVisualEditor(page, 'Choose the release gate.')
    await page.keyboard.press('Backspace')
    await expect.poll(async () => (await scenario.inspectDocument()).annotations?.find((item) => item.id === id)?.status).toBe('orphaned')
    await page.getByRole('tablist', { name: 'Document review' }).getByRole('tab', { name: /^Items/ }).click()
    await page.locator('.annotation-row').filter({ hasText: 'Which gate?' }).click()
    const thread = page.getByRole('region', { name: /decision thread/i })
    await expect(thread.getByRole('button', { name: 'Answer decision' })).toBeVisible()
    await thread.getByRole('radio', { name: 'CI' }).check()
    await thread.getByRole('button', { name: 'Answer decision' }).click()
    await expect.poll(async () => (await scenario.inspectDocument()).annotations?.find((item) => item.id === id)?.status).toBe('resolved')
  } finally {
    await scenario.dispose()
    await engine.close()
  }
})

test('a requoted annotation produces one send item', async ({}, testInfo) => {
  const source = '# Review\n\nFirst target.\n\nSecond target.\n'
  const engine = await startEngine({ titles: { t1: 'Agent A' } })
  const scenario = await seededScenario(testInfo, engine.origin, source, 'requote-send.md')
  try {
    const page = await scenario.launch()
    await openThread(page, 'Agent A')
    await attachThread(page, engine, 't1', 'Agent A')
    await page.getByRole('tablist', { name: 'Document navigation' }).getByRole('tab', { name: 'Contents' }).click()
    agentActs(engine, 't1', [{ verb: 'comment', anchor: { document: scenario.file, quote: 'First target.' }, text: 'Move this.' }])
    const id = (await annotationByText(scenario, 'Move this.')).id
    const from = source.indexOf('Second target.')
    await page.evaluate(async ({ path, id, from }) => {
      await window.strata.requoteAnnotation(path, id, { quote: 'Second target.', from, to: from + 'Second target.'.length })
    }, { path: scenario.file, id, from })
    await page.getByRole('button', { name: /^Send(?:\b|$)/i }).first().click()
    const composer = page.getByRole('dialog', { name: /Send changes/i })
    await expect(composer.locator('.send-item-event')).toHaveCount(1)
    await expect(composer.locator('.send-item-event')).toContainText('moved')
    await expect(composer.locator('.send-item-event')).toContainText('Second target.')
  } finally {
    await scenario.dispose()
    await engine.close()
  }
})
