import { expect, test } from '@playwright/test'
import { Scenario, selectTextInVisualEditor } from './harness'

const original = '# Review\n\n## Delivery\n\nChoose the release gate.\n'

test('owner decisions keep choice, discussion, delivery, and edits separate', async ({}, testInfo) => {
  const scenario = await Scenario.create(testInfo, original, 'decisions.md')
  try {
    const page = await scenario.launch()
    expect((await scenario.attach('agent-a', 'Agent A')).event).toBe('initial')

    await page.getByRole('tablist', { name: 'Document review' }).getByRole('tab', { name: /^Annotations/ }).click()
    const annotations = page.locator('.annotations-panel')
    await annotations.getByRole('button', { name: 'New decision' }).click()
    await annotations.getByRole('combobox', { name: 'Decision anchor' }).selectOption({ label: '## Delivery' })
    await annotations.getByRole('textbox', { name: 'Decision prompt' }).fill('Which release gate should we use?')
    await annotations.getByRole('textbox', { name: 'Decision choice 1' }).fill('Use CI')
    await annotations.getByRole('textbox', { name: 'Decision choice 2' }).fill('Manual review')
    await annotations.getByRole('button', { name: 'Add decision' }).click()

    const created = (await scenario.state()).annotations?.find((item) => item.kind === 'decision')
    expect(created).toMatchObject({
      status: 'open',
      anchor: 'heading',
      quote: '## Delivery',
      text: 'Which release gate should we use?',
      decision: { options: ['Use CI', 'Manual review'], answers: [] },
    })
    expect(created).toBeTruthy()

    expect((await scenario.cli(['lead', scenario.file, '--as', 'agent-a'])).code).toBe(0)
    const replied = await scenario.cli([
      'reply', scenario.file,
      '--to', created!.id,
      '--text', 'CI gives us the clearest audit trail.',
      '--as', 'agent-a',
    ])
    expect(replied.code, replied.stderr).toBe(0)

    for (const args of [
      ['answer', scenario.file, '--decision', created!.id, '--choice', 'Use CI', '--as', 'agent-a'],
      ['resolve', scenario.file, '--annotation', created!.id, '--as', 'agent-a'],
    ]) {
      const refused = await scenario.cli(args)
      expect(refused.code).toBe(3)
      expect(JSON.parse(refused.stderr)).toMatchObject({ code: 'DECISION_OWNER_REQUIRED' })
    }

    const decisionRow = annotations.getByRole('button').filter({ hasText: 'Which release gate should we use?' })
    await decisionRow.click()
    const thread = page.getByRole('dialog', { name: /decision thread/i })
    await expect(thread).toContainText('CI gives us the clearest audit trail.')
    await thread.getByRole('radio', { name: 'Use CI' }).check()
    await thread.getByRole('button', { name: 'Answer decision' }).click()
    await expect(thread).toContainText('chose “Use CI”')
    await expect(thread.getByRole('button', { name: /Reopen decision/i })).toBeVisible()

    const answered = (await scenario.state()).annotations?.find((item) => item.id === created!.id)
    expect(answered).toMatchObject({
      status: 'resolved',
      decision: { answers: [{ option: 'Use CI', author: 'user' }] },
    })
    expect((await scenario.state()).document).toBe(original)
    expect((await scenario.changes()).segments ?? []).toEqual([])

    await thread.getByRole('button', { name: 'Close thread' }).click()
    await page.getByRole('button', { name: /^Send(?:\b|$)/i }).first().click()
    const send = page.getByRole('dialog', { name: /Send changes/i })
    const answerItem = send.locator('.send-item-event').filter({ hasText: 'answered decision' })
    await expect(answerItem).toContainText('Use CI')
    await expect(answerItem.getByRole('checkbox')).toBeChecked()
    await expect(send.getByText(/^Your changes/)).toHaveCount(0)
    await send.getByRole('button', { name: /^Send$/ }).click()
    await expect(send).toBeHidden()

    const delivery = await scenario.attach('agent-a', 'Agent A')
    expect(delivery.event).toBe('send')
    expect(delivery.annotations?.find((item) => item.id === created!.id)).toMatchObject({
      kind: 'decision',
      anchor: 'heading',
      decision: { options: ['Use CI', 'Manual review'], answers: [{ option: 'Use CI' }] },
    })
    expect(delivery.text).toContain('Which release gate should we use?')
    expect(delivery.text).toContain('chose "Use CI"')

    await annotations.getByRole('button', { name: 'Resolved', exact: true }).click()
    await annotations.getByRole('button').filter({ hasText: 'Which release gate should we use?' }).click()
    const resolvedThread = page.getByRole('dialog', { name: /decision thread/i })
    await resolvedThread.getByRole('button', { name: /Reopen decision/i }).click()
    const reopened = (await scenario.state()).annotations?.find((item) => item.id === created!.id)
    expect(reopened).toMatchObject({
      status: 'open',
      decision: { answers: [{ option: 'Use CI', author: 'user' }] },
    })
  } finally {
    await scenario.dispose()
  }
})

test('keyboard passage and rail document decisions expose explicit anchors', async ({}, testInfo) => {
  const scenario = await Scenario.create(testInfo, original, 'decision-anchors.md')
  try {
    const page = await scenario.launch()
    await selectTextInVisualEditor(page, 'Choose the release gate.')
    await page.keyboard.press('d')
    const composer = page.locator('.annotation-composer')
    await expect(composer.locator('.annotation-kind')).toHaveText('decision')
    await composer.getByRole('textbox', { name: 'Decision prompt' }).fill('How should this passage change?')
    await composer.getByRole('textbox', { name: 'Choice 1' }).fill('Keep it')
    await composer.getByRole('textbox', { name: 'Choice 2' }).fill('Rewrite it')
    await composer.getByRole('button', { name: 'Add', exact: true }).click()
    await expect(composer).toHaveCount(0)

    await page.getByRole('tablist', { name: 'Document review' }).getByRole('tab', { name: /^Annotations/ }).click()
    const annotations = page.locator('.annotations-panel')
    await annotations.getByRole('button', { name: 'New decision' }).click()
    await expect(annotations.getByRole('combobox', { name: 'Decision anchor' })).toHaveValue('document')
    await annotations.getByRole('textbox', { name: 'Decision prompt' }).fill('Is the document ready?')
    await annotations.getByRole('textbox', { name: 'Decision choice 1' }).fill('Ready')
    await annotations.getByRole('textbox', { name: 'Decision choice 2' }).fill('Needs work')
    await annotations.getByRole('button', { name: 'Add decision' }).click()

    const title = page.getByRole('heading', { name: 'Review', exact: true })
    await title.click({ position: { x: 8, y: 8 } })
    await page.keyboard.press('End')
    await page.keyboard.press('Enter')
    await page.keyboard.insertText('Inserted above the decision heading.')
    await annotations.getByRole('button', { name: 'New decision' }).click()
    await annotations.getByRole('combobox', { name: 'Decision anchor' }).selectOption({ label: '## Delivery' })
    await annotations.getByRole('textbox', { name: 'Decision prompt' }).fill('Does the shifted heading still anchor?')
    await annotations.getByRole('textbox', { name: 'Decision choice 1' }).fill('Yes')
    await annotations.getByRole('textbox', { name: 'Decision choice 2' }).fill('No')
    await annotations.getByRole('button', { name: 'Add decision' }).click()

    const decisions = (await scenario.state()).annotations?.filter((item) => item.kind === 'decision') ?? []
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
  const scenario = await Scenario.create(testInfo, '# Review\n\nChoose the release gate.\n', 'orphaned-decision.md')
  try {
    const page = await scenario.launch()
    expect((await scenario.attach('agent-a', 'Agent A')).event).toBe('initial')
    const created = await scenario.cli([
      'annotate', scenario.file, '--kind', 'decision', '--quote', 'Choose the release gate.',
      '--text', 'Which gate?', '--option', 'CI', '--option', 'Manual', '--as', 'agent-a',
    ])
    expect(created.code, created.stderr).toBe(0)
    const id = JSON.parse(created.stdout).created[0].id as string
    await selectTextInVisualEditor(page, 'Choose the release gate.')
    await page.keyboard.press('Backspace')
    await expect.poll(async () => (await scenario.state()).annotations?.find((item) => item.id === id)?.status).toBe('orphaned')
    await page.getByRole('tablist', { name: 'Document review' }).getByRole('tab', { name: /^Annotations/ }).click()
    await page.locator('.annotation-row').filter({ hasText: 'Which gate?' }).click()
    const thread = page.getByRole('dialog', { name: /decision thread/i })
    await expect(thread.getByRole('button', { name: 'Answer decision' })).toBeVisible()
    await thread.getByRole('radio', { name: 'CI' }).check()
    await thread.getByRole('button', { name: 'Answer decision' }).click()
    await expect.poll(async () => (await scenario.state()).annotations?.find((item) => item.id === id)?.status).toBe('resolved')
  } finally {
    await scenario.dispose()
  }
})

test('a requoted annotation produces one send item', async ({}, testInfo) => {
  const source = '# Review\n\nFirst target.\n\nSecond target.\n'
  const scenario = await Scenario.create(testInfo, source, 'requote-send.md')
  try {
    const page = await scenario.launch()
    expect((await scenario.attach('agent-a', 'Agent A')).event).toBe('initial')
    const created = await scenario.cli([
      'annotate', scenario.file, '--kind', 'comment', '--quote', 'First target.', '--text', 'Move this.', '--as', 'agent-a',
    ])
    const id = JSON.parse(created.stdout).created[0].id as string
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
  }
})
