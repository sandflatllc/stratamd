import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { save, selectTextInVisualEditor, send, setSource, type Scenario } from './harness'
import { seededScenario, startEngine, type FakeEngine } from './cockpit-engine-harness'
import { agentActs, annotationByText, attachThread, openThread, uploadsFor } from './cockpit-agent'

// The agent-collaboration suite (docs/plans/completed/agent-collaboration-plan.md §9)
// on the cockpit: the Lead, the review board, the item panel inside
// Conversation, orphans, detaching, and save state. Agents are T3 threads
// attached to the document; they act by posting strata blocks (§5.9). The
// agent-to-agent message test is gone with messages (cockpit plan §11 phase 5).

interface Fixture { value: Scenario; engine: FakeEngine }

async function scenario(testInfo: TestInfo, content: string, name: string, threads: Array<['t1' | 't2', string]> = [['t1', 'Agent A'], ['t2', 'Agent B']]): Promise<Fixture> {
  const engine = await startEngine({ titles: Object.fromEntries(threads) })
  const value = await seededScenario(testInfo, engine.origin, content, name)
  const page = await value.launch()
  for (const [id, title] of threads) {
    await openThread(page, title)
    await attachThread(page, id, title)
  }
  await openThread(page, threads[0]![1])
  await page.getByRole('tablist', { name: 'Document navigation' }).getByRole('tab', { name: 'Contents' }).click()
  return { value, engine }
}

async function dispose(fixture: Fixture): Promise<void> {
  await fixture.value.dispose()
  await fixture.engine.close()
}

function agentEdit({ value, engine }: Fixture, threadId: string, quote: string, replace: string): void {
  agentActs(engine, threadId, [{ verb: 'edit', anchor: { document: value.file, quote }, match: quote, replace }])
}

/** Panels open with a scale animation; wait until the element stops moving before measuring. */
async function stableBox(page: Page, target: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  let bounds = await target.boundingBox()
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await page.waitForTimeout(60)
    const next = await target.boundingBox()
    if (bounds && next && Math.abs(next.x - bounds.x) < 0.5 && Math.abs(next.y - bounds.y) < 0.5 && Math.abs(next.width - bounds.width) < 0.5) {
      return next
    }
    bounds = next
  }
  expect(bounds).toBeTruthy()
  return bounds!
}

async function dragBy(page: Page, handle: Locator, dx: number, dy: number): Promise<void> {
  await handle.scrollIntoViewIfNeeded()
  // Snap the enclosing panel's open animation to its end so the sampled
  // coordinates are the settled ones; a press beside the handle would land in
  // the document instead.
  await handle.evaluate((element) => {
    const host = element.closest('.annotation-composer, .thread-panel') ?? element
    for (const animation of host.getAnimations({ subtree: true })) {
      try { animation.finish() } catch { /* infinite animations cannot finish */ }
    }
  })
  const bounds = await stableBox(page, handle)
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
  await page.mouse.down()
  await page.mouse.move(bounds.x + bounds.width / 2 + dx, bounds.y + bounds.height / 2 + dy, { steps: 5 })
  await page.mouse.up()
}

test('2. the full mode-3 round: brief, claim, denial, Lead accept and save, user Keep', async ({}, testInfo) => {
  const original = '# Round\n\nUse the old wording here.\n'
  const fixture = await scenario(testInfo, original, 'round.md')
  const { value, engine } = fixture
  try {
    const page = value.page!
    const briefed = `${original}\nBrief: settle the wording between you.\n`
    await setSource(page, briefed)
    await value.waitForBuffer(briefed)
    await send(page, { note: 'Agent A, take the lead and land what you both agree on.', recipientNames: ['Agent A', 'Agent B'] })
    await expect.poll(() => uploadsFor(engine, 't2').length).toBe(2)

    agentActs(engine, 't1', [{ verb: 'lead', document: value.file, action: 'claim' }])
    await expect.poll(async () => (await value.inspectDocument()).attachments?.find((item) => item.agent === 't1')?.lead).toBe(true)
    agentActs(engine, 't2', [
      { verb: 'lead', document: value.file, action: 'claim' },
      { verb: 'suggest', anchor: { document: value.file, quote: 'old wording' }, replacement: 'agreed wording' },
    ])
    const suggestion = await annotationByText(value, 'agreed wording')
    expect((await value.inspectDocument()).attachments?.find((item) => item.agent === 't2')?.lead).toBe(false)
    agentActs(engine, 't1', [
      { verb: 'accept', anchor: { item: suggestion.id } },
      { verb: 'save', document: value.file },
    ])

    // The round ends saved and fully reviewable: the accepted text is on disk
    // and still pending in the editor as a Lead-authored change.
    await expect.poll(() => readFile(value.file, 'utf8')).toContain('agreed wording')
    await expect(page.locator('.change-group-heading').filter({ hasText: 'Saved' })).toContainText('Saved · 1')
    await expect(page.locator('.change-row').filter({ hasText: 'Agent A' })).toBeVisible()
    const keep = page.getByRole('button', { name: /^Keep change /i }).first()
    await expect(keep).toBeVisible()
    await keep.click()
    await expect(page.locator('.changes-panel .empty-state')).toContainText('All caught up.')
    expect((await value.inspectDocument()).document).toContain('agreed wording')

    // Agent B learns on its next delivery that its claim was denied, naming the holder.
    await send(page, { note: 'Round closed.', recipientNames: ['Agent B'] })
    await expect.poll(() => uploadsFor(engine, 't2').length).toBe(3)
    expect(uploadsFor(engine, 't2')[2]).toContain('1. failed: LEAD_TAKEN: Agent A (t1) already holds the Lead')
    expect(uploadsFor(engine, 't2')[2]).toContain('2. applied as a_')
  } finally {
    await dispose(fixture)
  }
})

test('3. the review board is a map: centered spans, rich rows, capped change rows, and the crown', async ({}, testInfo) => {
  const paragraphs = Array.from({ length: 40 }, (_, index) => `Paragraph ${index + 1} keeps the document long enough to scroll.`)
  const original = `# Board\n\nSome **bold** and plain text.\n\n${paragraphs.join('\n\n')}\n`
  const fixture = await scenario(testInfo, original, 'board.md')
  const { value, engine } = fixture
  try {
    const page = value.page!
    agentActs(engine, 't1', [{ verb: 'comment', anchor: { document: value.file, quote: 'Some **bold** and plain text.' }, text: 'Formatting sample.' }])
    await annotationByText(value, 'Formatting sample.')

    // A quote containing **bold** renders bold in the row, never raw syntax.
    await page.getByRole('tablist', { name: 'Document review' }).getByRole('tab', { name: /^Items/ }).click()
    const row = page.locator('.annotations-panel .annotation-row').first()
    await expect(row.locator('strong')).toHaveText('bold')
    await expect(row).not.toContainText('**')

    // Clicking the row centers the span; the selected-annotation highlight marks it.
    await row.click()
    await expect(page.locator('.strata-annotation.is-active').first()).toBeInViewport()
    await page.keyboard.press('Escape')

    // A hunk spanning many lines shows at most two lines in its row.
    const last = paragraphs.at(-1)!
    agentEdit(fixture, 't1', last, `${last}\n\nAgent addition line one.\n\nAgent addition line two.\n\nAgent addition line three.`)
    await page.getByRole('tablist', { name: 'Document review' }).getByRole('tab', { name: /^Changes/ }).click()
    const changeRow = page.locator('.changes-panel .change-row').first()
    await expect(changeRow).toContainText('Agent A')
    await expect(changeRow.locator('.change-snippet > span')).toHaveCount(2)
    await changeRow.locator('.change-row-jump, .change-meta').first().click()
    await expect(page.getByRole('textbox', { name: /Document editor/i }).getByText('Agent addition line two.')).toBeInViewport()

    // The crown sits on every row; a non-holder click grants, the holder click revokes,
    // and the border marks the holder in the agent's own color.
    await expect(page.locator('.agent-row .crown')).toHaveCount(2)
    await page.getByRole('button', { name: 'Make Agent A the Lead' }).click()
    await expect(page.locator('.agent-row-lead')).toHaveCount(1)
    await expect(page.locator('.agent-row-lead')).toContainText('Agent A')
    expect((await value.inspectDocument()).attachments?.find((item) => item.agent === 't1')?.lead).toBe(true)

    // A click on the other row transfers in one action.
    await page.getByRole('button', { name: 'Make Agent B the Lead' }).click()
    await expect(page.locator('.agent-row-lead')).toContainText('Agent B')
    expect((await value.inspectDocument()).attachments?.find((item) => item.agent === 't2')?.lead).toBe(true)

    await page.getByRole('button', { name: 'Remove the Lead from Agent B' }).click()
    await expect(page.locator('.agent-row-lead')).toHaveCount(0)
  } finally {
    await dispose(fixture)
  }
})

test('3b. detach confirms only when queued sends would be discarded, and ends the attachment', async ({}, testInfo) => {
  const original = '# Detach\n\nOriginal sentence.\n'
  const fixture = await scenario(testInfo, original, 'detach.md')
  const { value, engine } = fixture
  try {
    const page = value.page!
    const edited = '# Detach\n\nOriginal sentence, edited.\n'
    await setSource(page, edited)
    await value.waitForBuffer(edited)
    // With the engine down, the Send delivery waits in the attachment's queue.
    engine.setOnline(false)
    await expect(page.getByRole('button', { name: 'Engine status' })).toHaveText(/Disconnected/)
    await send(page, { recipientNames: ['Agent B'] })
    await expect.poll(async () => (await page.evaluate(async () => (await window.strata.getState()).activeDocument?.attachments.find((item) => item.agent.id === 't2')?.queuedSendCount))).toBe(1)

    // A queued Send delivery is the user's data: detach confirms first, and cancel keeps both.
    await page.getByRole('button', { name: 'Detach Agent B' }).click()
    const dialog = page.getByRole('dialog', { name: /Detach Agent B/i })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toBeHidden()
    await expect(page.locator('.agent-row').filter({ hasText: 'Agent B' })).toBeVisible()
    engine.setOnline(true)
    await expect.poll(() => uploadsFor(engine, 't2').length, { timeout: 10_000 }).toBe(2)
    expect(uploadsFor(engine, 't2')[1]).toContain('edited')

    // An attachment with nothing queued detaches without a prompt, and its thread's blocks are ignored from then on.
    await page.getByRole('button', { name: 'Detach Agent A' }).click()
    await expect(page.getByRole('dialog', { name: /Detach Agent A/i })).toHaveCount(0)
    await expect(page.locator('.agent-row').filter({ hasText: 'Agent A' })).toHaveCount(0)
    agentActs(engine, 't1', [{ verb: 'comment', anchor: { document: value.file, quote: 'Original sentence' }, text: 'Still here?' }])
    await page.waitForTimeout(400)
    expect((await value.inspectDocument()).annotations?.some((item) => item.text === 'Still here?')).toBe(false)
  } finally {
    await dispose(fixture)
  }
})

test('4. an item pages below the fold opens in Conversation with the span centered, works, and keeps its own width', async ({}, testInfo) => {
  const filler = Array.from({ length: 70 }, (_, index) => `Filler paragraph ${index + 1} pads the page.`)
  const original = `# Threads\n\n${filler.slice(0, 60).join('\n\n')}\n\nThe needle sentence sits far below the fold.\n\n${filler.slice(60).join('\n\n')}\n`
  const fixture = await scenario(testInfo, original, 'threads.md', [['t1', 'Agent A']])
  const { value, engine } = fixture
  const settingsPath = join(String(value.env.XDG_CONFIG_HOME), 'stratamd', 'settings.json')
  try {
    const page = value.page!
    // Room for the default Conversation width beside the right rail and the editor's floor.
    await page.setViewportSize({ width: 1440, height: 900 })
    agentActs(engine, 't1', [{ verb: 'comment', anchor: { document: value.file, quote: 'needle sentence' }, text: 'Found it?' }])
    await annotationByText(value, 'Found it?')

    // A rail click centers the span in the editor and opens the item in the left window's Conversation.
    await page.getByRole('tablist', { name: 'Document review' }).getByRole('tab', { name: /^Items/ }).click()
    await page.locator('.annotations-panel .annotation-row').first().click()
    const panel = page.getByRole('region', { name: /comment thread/i })
    const navigation = page.getByRole('tablist', { name: 'Document navigation' })
    const leftWindow = page.locator('[data-pane="explorer"]')
    await expect(panel).toBeVisible()
    await expect(panel).toBeInViewport()
    await expect(navigation.getByRole('tab', { name: /^Conversation(?: \d+)?$/ })).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator('.strata-annotation.is-active').first()).toBeInViewport()
    await expect.poll(() => leftWindow.evaluate((element) => (element as HTMLElement).style.width)).toBe('660px')

    // Reply and Resolve work from the panel.
    const reply = panel.getByRole('textbox', { name: 'Reply' })
    await reply.fill('Replying from the panel')
    await reply.press('Enter')
    await expect(panel.getByText('Replying from the panel', { exact: true })).toBeVisible()
    await expect.poll(async () => {
      const state = await value.inspectDocument() as unknown as { annotations?: Array<{ replies?: Array<{ text: string }> }> }
      return state.annotations?.flatMap((item) => item.replies ?? []).map((item) => item.text) ?? []
    }).toContain('Replying from the panel')

    // Dragging the left window's handle while Conversation shows persists the
    // Conversation width and leaves the navigation width alone.
    await dragBy(page, page.getByRole('button', { name: 'Resize left window' }), 120, 0)
    await expect.poll(async () => {
      try {
        return JSON.parse(await readFile(settingsPath, 'utf8')).panels?.threadPanel?.width ?? null
      } catch {
        return null
      }
    }, { timeout: 15_000 }).toBe(780)
    expect(JSON.parse(await readFile(settingsPath, 'utf8')).panels?.explorerWidth).toBe(212)
    await panel.getByRole('button', { name: 'Close thread' }).click()
    await expect(panel).toBeHidden()
    // Closing returns the left window to navigation at its own width.
    await expect(navigation.getByRole('tab', { name: 'Contents', exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect.poll(() => leftWindow.evaluate((element) => (element as HTMLElement).style.width)).toBe('212px')

    // The in-editor highlight opens the same item at the remembered width.
    await page.locator('.strata-annotation').first().click()
    await expect(panel).toBeVisible()
    await expect.poll(() => leftWindow.evaluate((element) => (element as HTMLElement).style.width)).toBe('780px')

    // The writing modal gets the same resize treatment.
    await panel.getByRole('button', { name: 'Close thread' }).click()
    await selectTextInVisualEditor(page, 'far below the fold.')
    await page.getByRole('menu', { name: /Annotate selection/i }).getByRole('menuitem', { name: /Comment/i }).click()
    const composer = page.locator('.annotation-composer')
    await expect(composer).toBeVisible()
    // The composer opens just above the fold in this small window; bring its
    // bottom-right handle fully inside the island before grabbing it.
    await page.locator('.editor-scroll').evaluate((element) => element.scrollBy(0, 220))
    await dragBy(page, composer.getByRole('button', { name: 'Resize annotation composer' }), 90, 40)
    await expect.poll(async () => {
      try {
        return JSON.parse(await readFile(settingsPath, 'utf8')).panels?.annotationComposer?.width ?? null
      } catch {
        return null
      }
    }, { timeout: 15_000 }).toBe(420)
    await page.keyboard.press('Escape')
    // Dismissing refocuses the editor on the next frame, restoring its old
    // selection; wait that out, then pick a different span (the dismissed
    // range would not reopen the composer).
    await page.waitForTimeout(200)
    await selectTextInVisualEditor(page, 'below the fold.')
    await page.getByRole('menu', { name: /Annotate selection/i }).getByRole('menuitem', { name: /Comment/i }).click()
    await expect.poll(() => composer.evaluate((element) => (element as HTMLElement).style.width)).toBe('420px')
    await page.keyboard.press('Escape')

    // Resolve from the panel: the row leaves the rail, Clear resolved empties storage.
    await page.getByRole('tablist', { name: 'Document review' }).getByRole('tab', { name: /^Items/ }).click()
    await page.locator('.annotations-panel .annotation-row').first().click()
    await expect(panel).toBeVisible()
    await panel.getByRole('button', { name: /Resolve thread/i }).click()
    await expect(page.locator('.annotations-panel .annotation-row')).toHaveCount(0)
    // Resolving closes the item, so the rail's Clear resolved button is reachable.
    await expect(panel).toBeHidden()
    await page.getByRole('button', { name: 'Clear resolved' }).click()
    await expect.poll(async () => ((await value.inspectDocument()).annotations ?? []).length).toBe(0)
  } finally {
    await dispose(fixture)
  }
})

test('5. an orphaned item keeps every affordance except the jump', async ({}, testInfo) => {
  const original = '# Orphans\n\nKeep the quoted span here for now.\n\nOther text stays.\n'
  const fixture = await scenario(testInfo, original, 'orphans.md', [['t1', 'Agent A']])
  const { value, engine } = fixture
  try {
    const page = value.page!
    agentActs(engine, 't1', [{ verb: 'comment', anchor: { document: value.file, quote: 'quoted span' }, text: 'Anchored to text that will vanish.' }])
    await annotationByText(value, 'Anchored to text that will vanish.')

    const rewritten = '# Orphans\n\nEverything is different now.\n\nOther text stays.\n'
    await setSource(page, rewritten)
    await value.waitForBuffer(rewritten)

    await page.getByRole('tablist', { name: 'Document review' }).getByRole('tab', { name: /^Items/ }).click()
    const row = page.locator('.annotations-panel .annotation-row').first()
    await expect(row.locator('.annotation-chip')).toHaveText('text removed')

    // The row opens the item with the original quote shown; there is nothing to jump to.
    await row.click()
    const panel = page.getByRole('region', { name: /comment thread/i })
    await expect(panel).toBeVisible()
    await expect(panel.locator('.thread-panel-quote')).toContainText('quoted span')

    const reply = panel.getByRole('textbox', { name: 'Reply' })
    await reply.fill('Still useful context')
    await reply.press('Enter')
    await expect(panel.getByText('Still useful context', { exact: true })).toBeVisible()

    await panel.getByRole('button', { name: /Resolve thread/i }).click()
    await expect(panel).toBeHidden()
    await expect(page.locator('.annotations-panel .annotation-row')).toHaveCount(0)
    await page.getByRole('button', { name: 'Clear resolved' }).click()
    await expect.poll(async () => ((await value.inspectDocument()).annotations ?? []).length).toBe(0)
    await expect(page.locator('.annotations-panel')).toContainText('Select text to comment')
  } finally {
    await dispose(fixture)
  }
})

test('6. save state is always visible: groups, the tab dot, the Save button, and the tinted total', async ({}, testInfo) => {
  const original = '# Save state\n\nFirst paragraph.\n\nLast paragraph.\n'
  const fixture = await scenario(testInfo, original, 'save-state.md', [['t1', 'Agent A']])
  const { value } = fixture
  try {
    const page = value.page!
    const footer = page.locator('.save-state-footer')
    const dot = page.locator('.tab-dirty-dot')
    const saveButton = page.locator('.save-button')
    await expect(footer).toContainText('Everything saved')
    await expect(dot).toHaveCount(0)
    await expect(saveButton).toHaveText('Saved')

    // An agent edit lands under Unsaved with the dot shown and Save accented.
    agentEdit(fixture, 't1', 'Last paragraph.', 'Last paragraph.\n\nAgent line one.')
    await expect(page.locator('.change-group-heading')).toHaveText(['Unsaved · 1'])
    await expect(dot).toHaveCount(1)
    await expect(saveButton).toHaveText('Save')
    await expect(footer).toContainText('Unsaved changes')

    // Save moves it to the Saved group, clears the dot, and flips the footer sentence.
    await save(page)
    await expect(page.locator('.change-group-heading')).toHaveText(['Saved · 1'])
    await expect(dot).toHaveCount(0)
    await expect(saveButton).toHaveText('Saved')
    await expect(footer).toContainText('Everything saved')

    // Revert on a Saved hunk restores text the file does not have: unsaved again.
    await page.getByRole('button', { name: /^Revert change /i }).first().click()
    await expect(dot).toHaveCount(1)
    await expect(footer).toContainText('Unsaved changes')
    await save(page)
    await expect(footer).toContainText('Everything saved')

    // One saved and one fresh agent edit count one each and tint the top-bar total.
    agentEdit(fixture, 't1', 'Last paragraph.', 'Last paragraph.\n\nAgent line two.')
    await expect(page.locator('.change-group-heading')).toHaveText(['Unsaved · 1'])
    await save(page)
    await expect(page.locator('.change-group-heading')).toHaveText(['Saved · 1'])
    agentEdit(fixture, 't1', 'First paragraph.', 'First paragraph, adjusted.')
    await expect(page.locator('.change-group-heading')).toHaveText(['Unsaved · 1', 'Saved · 1'])
    await expect(page.locator('.pending-status')).toHaveAttribute('data-unsaved', 'true')
    await expect(page.locator('.pending-status')).toHaveText('2 pending')
  } finally {
    await dispose(fixture)
  }
})
