import { expect, test, type Page, type TestInfo } from '@playwright/test'
import { dirname } from 'node:path'
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

test('8: Start thread from a document preselects its project and sends the pending comment, held draft, and document as the first turn', async ({}, testInfo: TestInfo) => {
  const engine = await startEngine()
  const scenario = await seededScenario(testInfo, engine.origin, '# Draft review\n\nFirst sentence. Second sentence.\n', 'cockpit-start.md')
  engine.setWorkspaceRoot(dirname(scenario.file))
  try {
    const page = await scenario.launch()
    await expect(page.locator('.send-button')).toHaveText('Start thread')

    const held = await openComment(page, 'First sentence')
    await held.getByRole('textbox', { name: /Annotation text/i }).fill('Held first.')
    await held.getByRole('button', { name: 'Hold' }).click()
    await expect(page.locator('.strata-draft')).toHaveCount(1)

    const pending = await openComment(page, 'Second sentence')
    await expect(pending.getByRole('checkbox')).toHaveCount(0)
    await pending.getByRole('textbox', { name: /Annotation text/i }).fill('Pending comment.')
    await pending.locator('.composer-actions').getByRole('button', { name: 'Start thread' }).click()

    const picker = page.getByRole('form', { name: 'Start thread' })
    await expect(picker.getByLabel('Project')).toHaveValue('p1')
    await expect(picker).toContainText('The first turn carries your comment, 1 held draft, the document.')
    await picker.getByRole('button', { name: 'Start thread' }).click()

    await expect.poll(() => engine.commands.filter((command) => command.type === 'thread.create' || command.type === 'thread.turn.start').map((command) => command.type)).toEqual(['thread.create', 'thread.turn.start'])
    const create = engine.commands.find((command) => command.type === 'thread.create')!
    const turn = engine.commands.find((command) => command.type === 'thread.turn.start')!
    expect(turn.threadId).toBe(create.threadId)
    expect(create).toMatchObject({ projectId: 'p1', title: 'Review cockpit-start.md' })
    await expect.poll(() => engine.uploads.length).toBe(1)
    expect(engine.uploads[0]).toContain('Pending comment.')
    expect(engine.uploads[0]).toContain('Held first.')
    expect(engine.uploads[0]).toContain('# Draft review')
    await expect(page.locator('.strata-draft')).toHaveCount(0)
    await expect(page.locator('.agent-row')).toContainText('Review cockpit-start.md')
    await expect(page.locator('.send-button')).toHaveText('Send ↗')
  } finally {
    await scenario.dispose()
    await closeEngine(engine)
  }
})

test('5.6: the active conversation in the same project is a recipient before it is attached, and the first Send attaches it', async ({}, testInfo: TestInfo) => {
  const engine = await startEngine()
  const scenario = await seededScenario(testInfo, engine.origin, '# Same project\n\nA passage to discuss.\n', 'cockpit-active.md')
  engine.setWorkspaceRoot(dirname(scenario.file))
  try {
    const page = await scenario.launch()
    await openThread(page, 'Second engine thread')
    await expect(page.locator('.agent-row')).toHaveCount(0)
    await expect(page.locator('.send-button')).toHaveText('Send ↗')

    const comment = await openComment(page, 'A passage to discuss')
    const pill = comment.getByRole('checkbox', { name: 'Second engine thread' })
    await expect(pill).toBeChecked()
    await expect(comment.locator('label[data-attached="false"]')).toHaveCount(1)
    await comment.getByRole('textbox', { name: /Annotation text/i }).fill('Attach by sending.')
    await comment.getByRole('textbox', { name: /Annotation text/i }).press('Enter')

    await expect.poll(() => engine.uploads.length).toBe(1)
    expect(engine.uploads[0]).toContain('Attach by sending.')
    expect(engine.commands.find((command) => command.type === 'thread.turn.start')).toMatchObject({ threadId: 't2' })
    await expect(page.locator('.agent-row')).toContainText('Second engine thread')
  } finally {
    await scenario.dispose()
    await closeEngine(engine)
  }
})
