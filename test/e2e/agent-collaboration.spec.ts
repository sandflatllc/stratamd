import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Scenario, save, selectTextInVisualEditor, send, setSource, spawnCli, type Payload } from './harness'

// The agent-collaboration suite (docs/plans/completed/agent-collaboration-plan.md §9): messages,
// the Lead, the review board, the thread panel, orphans, and save state.

async function scenario(testInfo: TestInfo, content: string, name: string): Promise<Scenario> {
  const value = await Scenario.create(testInfo, content, name)
  await value.launch()
  return value
}

/** Runs one CLI call whose stdout is a plain JSON object, not a payload. */
async function cliJson(value: Scenario, args: string[]): Promise<Record<string, unknown>> {
  const result = await value.cli(args)
  expect(result.code, result.stderr || result.stdout).toBe(0)
  return JSON.parse(result.stdout) as Record<string, unknown>
}

async function suggestionId(value: Scenario): Promise<string> {
  const state = await value.state()
  const suggestion = state.annotations?.find((item) => item.kind === 'suggestion')
  expect(suggestion, JSON.stringify(state.annotations)).toBeTruthy()
  return suggestion!.id
}

async function writeTaggedBuffer(value: Scenario, agent: string, name: string, content: string): Promise<void> {
  const state = await value.state()
  expect(state.buffer).toBeTruthy()
  const tagged = await value.cli(['changed', value.file, '--as', agent, '--name', name])
  expect(tagged.code, tagged.stderr).toBe(0)
  await value.atomicWrite(state.buffer!, content)
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

test('1. a message queues while working, wakes a blocked attach, and points the recipient at state', async ({}, testInfo) => {
  const original = '# Messages\n\nThe quoted target sentence.\n'
  const value = await scenario(testInfo, original, 'messages.md')
  try {
    const page = value.page!
    expect((await value.attach('agent-a', 'Agent A')).event).toBe('initial')
    expect((await value.attach('agent-b', 'Agent B')).event).toBe('initial')
    const annotated = await value.cli([
      'annotate', value.file,
      '--kind', 'comment',
      '--quote', 'quoted target sentence',
      '--text', 'Look here first.',
      '--as', 'agent-a',
    ])
    expect(annotated.code, annotated.stderr).toBe(0)

    // While the recipient is working, the note queues and the rail shows the
    // existing pending badge in plain words. No traffic feed, no approval gate.
    const first = await cliJson(value, ['send', value.file, '--as', 'agent-a', '--text', 'Round one is ready.'])
    expect(first.sent).toEqual([{ agent: 'agent-b', name: 'Agent B' }])
    const rowB = page.locator('.agent-row').filter({ hasText: 'Agent B' })
    await expect(rowB).toContainText('has an update waiting')

    const queued = await value.attach('agent-b', 'Agent B')
    expect(queued).toMatchObject({ event: 'message', notes: ['Round one is ready.'], from: { agent: 'agent-a', name: 'Agent A' } })
    await expect(rowB).toContainText('working')

    // A blocked attach returns the next message at once.
    const child = spawnCli(['attach', value.file, '--as', 'agent-b', '--timeout', '30'], value.env)
    let stdout = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { stdout += chunk })
    const exited = new Promise<number>((resolve) => child.once('close', (code) => resolve(code ?? 1)))
    await expect(rowB).toContainText('waiting for changes')
    await page.waitForTimeout(250)

    const second = await cliJson(value, ['send', value.file, '--as', 'agent-a', '--text', 'Ring when caught up.'])
    expect(second.sent).toEqual([{ agent: 'agent-b', name: 'Agent B' }])
    expect(await exited).toBe(0)
    const delivered = JSON.parse(stdout) as Payload
    expect(delivered).toMatchObject({ event: 'message', notes: ['Ring when caught up.'], from: { agent: 'agent-a' } })
    expect(delivered.text).toContain('Message from Agent A (agent-a):')
    expect(delivered.text).toContain('stratamd state')

    // The message is the doorbell; state is where the substance lives.
    const state = await value.state()
    expect(state.annotations?.map((item) => item.text)).toContain('Look here first.')
    expect(state.attachments).toEqual([
      { agent: 'agent-a', name: 'Agent A', state: 'working', lead: false },
      { agent: 'agent-b', name: 'Agent B', state: 'working', lead: false },
    ])
  } finally {
    await value.dispose()
  }
})

test('2. the full mode-3 round: brief, claim, denial, Lead accept and save, user Keep', async ({}, testInfo) => {
  const original = '# Round\n\nUse the old wording here.\n'
  const value = await scenario(testInfo, original, 'round.md')
  try {
    const page = value.page!
    expect((await value.attach('agent-a', 'Agent A')).event).toBe('initial')
    expect((await value.attach('agent-b', 'Agent B')).event).toBe('initial')

    const briefed = `${original}\nBrief: settle the wording between you.\n`
    await setSource(page, briefed)
    await value.waitForBuffer(briefed)
    await send(page, { note: 'Agent A, take the lead and land what you both agree on.' })

    expect((await value.cli(['lead', value.file, '--as', 'agent-a'])).code).toBe(0)
    const denied = await value.cli(['lead', value.file, '--as', 'agent-b'])
    expect(denied.code).toBe(3)
    expect(JSON.parse(denied.stderr)).toMatchObject({
      code: 'LEAD_TAKEN',
      detail: { holder: { agent: 'agent-a', name: 'Agent A' } },
    })

    const proposed = await value.cli([
      'annotate', value.file,
      '--kind', 'suggestion',
      '--quote', 'old wording',
      '--text', 'agreed wording',
      '--as', 'agent-b',
    ])
    expect(proposed.code, proposed.stderr).toBe(0)
    const annotation = await suggestionId(value)
    expect((await value.cli(['accept', value.file, '--annotation', annotation, '--as', 'agent-a'])).code).toBe(0)
    expect((await value.cli(['save', value.file, '--as', 'agent-a'])).code).toBe(0)

    // The round ends saved and fully reviewable: the accepted text is on disk
    // and still pending in the editor as a Lead-authored change.
    expect(await readFile(value.file, 'utf8')).toContain('agreed wording')
    await expect(page.locator('.change-group-heading').filter({ hasText: 'Saved' })).toContainText('Saved · 1')
    await expect(page.locator('.change-row').filter({ hasText: 'Agent A' })).toBeVisible()
    const keep = page.getByRole('button', { name: /^Keep change /i }).first()
    await expect(keep).toBeVisible()
    await keep.click()
    await expect(page.locator('.changes-panel .empty-state')).toContainText('All caught up.')
    expect((await value.state()).document).toContain('agreed wording')
  } finally {
    await value.dispose()
  }
})

test('3. the review board is a map: centered spans, rich rows, capped change rows, and the crown', async ({}, testInfo) => {
  const paragraphs = Array.from({ length: 40 }, (_, index) => `Paragraph ${index + 1} keeps the document long enough to scroll.`)
  const original = `# Board\n\nSome **bold** and plain text.\n\n${paragraphs.join('\n\n')}\n`
  const value = await scenario(testInfo, original, 'board.md')
  try {
    const page = value.page!
    expect((await value.attach('agent-a', 'Agent A')).event).toBe('initial')
    expect((await value.attach('agent-b', 'Agent B')).event).toBe('initial')

    const annotated = await value.cli([
      'annotate', value.file,
      '--kind', 'comment',
      '--quote', 'Some **bold** and plain text.',
      '--text', 'Formatting sample.',
      '--as', 'agent-a',
    ])
    expect(annotated.code, annotated.stderr).toBe(0)

    // A quote containing **bold** renders bold in the row, never raw syntax.
    const row = page.locator('.annotations-panel .annotation-row').first()
    await expect(row.locator('strong')).toHaveText('bold')
    await expect(row).not.toContainText('**')

    // Clicking the row centers the span; the selected-annotation highlight marks it.
    await row.click()
    await expect(page.locator('.strata-annotation.is-active').first()).toBeInViewport()
    await page.keyboard.press('Escape')

    // A hunk spanning many lines shows at most two lines in its row.
    const appended = `${original}\nAgent addition line one.\n\nAgent addition line two.\n\nAgent addition line three.\n`
    await writeTaggedBuffer(value, 'agent-a', 'Agent A', appended)
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
    expect((await value.state()).attachments?.find((item) => item.agent === 'agent-a')?.lead).toBe(true)

    // A click on the other row transfers in one action.
    await page.getByRole('button', { name: 'Make Agent B the Lead' }).click()
    await expect(page.locator('.agent-row-lead')).toContainText('Agent B')
    expect((await value.state()).attachments?.find((item) => item.agent === 'agent-b')?.lead).toBe(true)

    await page.getByRole('button', { name: 'Remove the Lead from Agent B' }).click()
    await expect(page.locator('.agent-row-lead')).toHaveCount(0)
  } finally {
    await value.dispose()
  }
})

test('3b. disconnect confirms only when queued sends would be discarded, and ends the attachment', async ({}, testInfo) => {
  const original = '# Disconnect\n\nOriginal sentence.\n'
  const value = await scenario(testInfo, original, 'disconnect.md')
  try {
    const page = value.page!
    expect((await value.attach('agent-a', 'Agent A')).event).toBe('initial')
    expect((await value.attach('agent-b', 'Agent B')).event).toBe('initial')

    const edited = '# Disconnect\n\nOriginal sentence, edited.\n'
    await setSource(page, edited)
    await value.waitForBuffer(edited)
    await send(page, { recipientNames: ['Agent B'] })
    await expect(page.locator('.agent-row').filter({ hasText: 'Agent B' })).toContainText('has an update waiting')

    // A queued Send delivery is the user's data: disconnect confirms first, and cancel keeps both.
    await page.getByRole('button', { name: 'Disconnect Agent B' }).click()
    const dialog = page.getByRole('dialog', { name: /Disconnect Agent B/i })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toBeHidden()
    await expect(page.locator('.agent-row').filter({ hasText: 'Agent B' })).toContainText('has an update waiting')
    expect((await value.attach('agent-b', 'Agent B')).event).toBe('send')

    // A message-only queue disconnects without a prompt.
    const sent = await value.cli(['send', value.file, '--as', 'agent-b', '--text', 'One note.', '--to', 'agent-a'])
    expect(sent.code, sent.stderr).toBe(0)
    await page.getByRole('button', { name: 'Disconnect Agent A' }).click()
    await expect(page.getByRole('dialog', { name: /Disconnect Agent A/i })).toHaveCount(0)
    await expect(page.locator('.agent-row').filter({ hasText: 'Agent A' })).toHaveCount(0)
    const gone = await value.cli(['send', value.file, '--as', 'agent-a', '--text', 'Still here?'])
    expect(gone.code).toBe(2)
    expect(JSON.parse(gone.stderr)).toMatchObject({ code: 'ATTACHMENT_NOT_FOUND' })
  } finally {
    await value.dispose()
  }
})

test('4. the thread panel opens beside a span pages below the fold, works, and keeps only its size', async ({}, testInfo) => {
  const filler = Array.from({ length: 70 }, (_, index) => `Filler paragraph ${index + 1} pads the page.`)
  const original = `# Threads\n\n${filler.slice(0, 60).join('\n\n')}\n\nThe needle sentence sits far below the fold.\n\n${filler.slice(60).join('\n\n')}\n`
  const value = await scenario(testInfo, original, 'threads.md')
  const settingsPath = join(String(value.env.XDG_CONFIG_HOME), 'stratamd', 'settings.json')
  try {
    const page = value.page!
    expect((await value.attach('agent-a', 'Agent A')).event).toBe('initial')
    const annotated = await value.cli([
      'annotate', value.file,
      '--kind', 'comment',
      '--quote', 'needle sentence',
      '--text', 'Found it?',
      '--as', 'agent-a',
    ])
    expect(annotated.code, annotated.stderr).toBe(0)

    // A rail click centers the span and opens the panel beside it, inside the viewport.
    await page.locator('.annotations-panel .annotation-row').first().click()
    const panel = page.getByRole('dialog', { name: /comment thread/i })
    await expect(panel).toBeVisible()
    await expect(panel).toBeInViewport()
    await expect(page.locator('.strata-annotation.is-active').first()).toBeInViewport()

    // Reply and Resolve work from the panel.
    const reply = panel.getByRole('textbox', { name: 'Reply' })
    await reply.fill('Replying from the panel')
    await reply.press('Enter')
    await expect(panel.getByText('Replying from the panel', { exact: true })).toBeVisible()
    await expect.poll(async () => {
      const state = await value.state() as unknown as { annotations?: Array<{ replies?: Array<{ text: string }> }> }
      return state.annotations?.flatMap((item) => item.replies ?? []).map((item) => item.text) ?? []
    }).toContain('Replying from the panel')

    // Resizing persists the size; the position is derived fresh each open.
    await dragBy(page, panel.getByRole('button', { name: 'Resize thread panel' }), 120, 80)
    await expect.poll(async () => {
      try {
        return JSON.parse(await readFile(settingsPath, 'utf8')).panels?.threadPanel?.width ?? null
      } catch {
        return null
      }
    }, { timeout: 15_000 }).toBe(780)
    await panel.getByRole('button', { name: 'Close thread' }).click()
    await expect(panel).toBeHidden()

    // The in-editor highlight opens the same panel.
    await page.locator('.strata-annotation').first().click()
    await expect(panel).toBeVisible()
    await expect.poll(() => panel.evaluate((element) => (element as HTMLElement).style.width)).toBe('780px')

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
    await page.locator('.annotations-panel .annotation-row').first().click()
    await expect(panel).toBeVisible()
    await panel.getByRole('button', { name: /Resolve thread/i }).click()
    await expect(page.locator('.annotations-panel .annotation-row')).toHaveCount(0)
    // Resolving closes the panel, so the rail's Clear resolved button is reachable.
    await expect(panel).toBeHidden()
    await page.getByRole('button', { name: 'Clear resolved' }).click()
    await expect.poll(async () => ((await value.state()).annotations ?? []).length).toBe(0)
  } finally {
    await value.dispose()
  }
})

test('5. an orphaned thread keeps every affordance except the jump', async ({}, testInfo) => {
  const original = '# Orphans\n\nKeep the quoted span here for now.\n\nOther text stays.\n'
  const value = await scenario(testInfo, original, 'orphans.md')
  try {
    const page = value.page!
    expect((await value.attach('agent-a', 'Agent A')).event).toBe('initial')
    const annotated = await value.cli([
      'annotate', value.file,
      '--kind', 'comment',
      '--quote', 'quoted span',
      '--text', 'Anchored to text that will vanish.',
      '--as', 'agent-a',
    ])
    expect(annotated.code, annotated.stderr).toBe(0)

    const rewritten = '# Orphans\n\nEverything is different now.\n\nOther text stays.\n'
    await setSource(page, rewritten)
    await value.waitForBuffer(rewritten)

    const row = page.locator('.annotations-panel .annotation-row').first()
    await expect(row.locator('.annotation-chip')).toHaveText('text removed')

    // The row opens the thread with the original quote shown; there is nothing to jump to.
    await row.click()
    const panel = page.getByRole('dialog', { name: /comment thread/i })
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
    await expect.poll(async () => ((await value.state()).annotations ?? []).length).toBe(0)
    await expect(page.locator('.annotations-panel')).toContainText('Select text to comment')
  } finally {
    await value.dispose()
  }
})

test('6. save state is always visible: groups, the tab dot, the Save button, and the tinted total', async ({}, testInfo) => {
  const original = '# Save state\n\nFirst paragraph.\n\nLast paragraph.\n'
  const value = await scenario(testInfo, original, 'save-state.md')
  try {
    const page = value.page!
    expect((await value.attach('agent-a', 'Agent A')).event).toBe('initial')
    const footer = page.locator('.save-state-footer')
    const dot = page.locator('.tab-dirty-dot')
    const saveButton = page.locator('.save-button')
    await expect(footer).toContainText('Everything saved')
    await expect(dot).toHaveCount(0)
    await expect(saveButton).toHaveText('Saved')

    // An agent buffer write lands under Unsaved with the dot shown and Save accented.
    await writeTaggedBuffer(value, 'agent-a', 'Agent A', `${original}\nAgent line one.\n`)
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
    await writeTaggedBuffer(value, 'agent-a', 'Agent A', `${original}\nAgent line two.\n`)
    await save(page)
    await expect(page.locator('.change-group-heading')).toHaveText(['Saved · 1'])
    const current = (await value.state()).document!
    await writeTaggedBuffer(value, 'agent-a', 'Agent A', current.replace('First paragraph.', 'First paragraph, adjusted.'))
    await expect(page.locator('.change-group-heading')).toHaveText(['Unsaved · 1', 'Saved · 1'])
    await expect(page.locator('.pending-status')).toHaveAttribute('data-unsaved', 'true')
    await expect(page.locator('.pending-status')).toHaveText('2 pending')
  } finally {
    await value.dispose()
  }
})
