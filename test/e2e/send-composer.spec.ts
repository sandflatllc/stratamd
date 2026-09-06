import { openAppMenu } from './harness'
import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'
import { selectTextInVisualEditor, setSource, type Scenario } from './harness'
import { seededScenario, startEngine, type FakeEngine } from './cockpit-engine-harness'
import { agentActs, attachThread, openThread, uploadsFor } from './cockpit-agent'

/** Layout size, immune to the pop-in animation's transform (which xvfb can leave mid-frame). */
async function layoutSize(target: Locator): Promise<{ width: number; height: number }> {
  return target.evaluate((el) => ({ width: (el as HTMLElement).offsetWidth, height: (el as HTMLElement).offsetHeight }))
}

/** Waits for the pop-in transform to clear so pointer coordinates match layout. */
async function settled(page: Page, target: Locator): Promise<void> {
  await expect.poll(async () => {
    const box = await target.boundingBox()
    const layout = await layoutSize(target)
    return box === null ? -1 : Math.abs(box.width - layout.width)
  }, { timeout: 4_000 }).toBeLessThan(1)
}

// The send-composer suite (docs/plans/completed/send-composer-plan.md §10): never echo an
// agent its own work, verdicts instead of diffs, item selection with skip
// semantics, and the modal's size and zoom. Agents are attached T3 threads
// whose edits arrive as strata blocks (§5.9); deliveries are turn uploads.

interface Fixture { value: Scenario; engine: FakeEngine }

async function scenario(testInfo: TestInfo, content: string, threads: Array<['t1' | 't2', string]> = [['t1', 'Agent A']]): Promise<Fixture> {
  const engine = await startEngine({ titles: { t1: 'Agent A', t2: 'Agent B' } })
  const value = await seededScenario(testInfo, engine.origin, content, 'plan.md')
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

/** The thread edits every listed passage in one message and the hunks show for review. */
async function agentEditsAll({ value, engine }: Fixture, threadId: string, name: string, edits: Array<[quote: string, replace: string]>): Promise<void> {
  agentActs(engine, threadId, edits.map(([quote, replace]) => ({ verb: 'edit', anchor: { document: value.file, quote }, match: quote, replace })))
  await expect(value.page!.getByRole('button', { name: new RegExp(`^Keep change by ${name}: `) })).toHaveCount(edits.length, { timeout: 15_000 })
}

async function openComposer(page: Page) {
  await page.getByRole('button', { name: /^Send/i }).first().click()
  const dialog = page.getByRole('dialog', { name: /Send changes/i })
  await expect(dialog).toBeVisible()
  return dialog
}

test('a reverted agent edit reaches its author as a verdict and others as a user diff', async ({}, testInfo) => {
  const fixture = await scenario(testInfo, 'Alpha.\n\nBeta.\n', [['t1', 'Agent A'], ['t2', 'Agent B']])
  const { value, engine } = fixture
  try {
    const page = value.page!
    await agentEditsAll(fixture, 't1', 'Agent A', [['Beta.', 'Agent line.']])
    const revert = page.getByRole('button', { name: /^Revert change /i }).first()
    await expect(revert).toBeVisible()
    await revert.click()

    const dialog = await openComposer(page)
    await dialog.getByRole('checkbox', { name: 'Agent A', exact: true }).check()
    await dialog.getByRole('checkbox', { name: 'Agent B', exact: true }).check()
    await dialog.getByRole('tab', { name: 'Agent A' }).click()
    // The author sees its verdict, never its own change as an item.
    await expect(dialog.locator('.send-item-event')).toHaveCount(1)
    await expect(dialog.locator('.send-item-event')).toContainText(/removed their change/)
    await expect(dialog.locator('.send-item[data-author]')).toHaveCount(0)

    await dialog.getByRole('button', { name: /Exact text/i }).click()
    await expect(dialog.locator('.delivery-preview')).toContainText('Your change was reverted: Agent line.')
    await expect(dialog.locator('.delivery-preview')).not.toContainText('Changes by user:')
    await dialog.getByRole('tab', { name: 'Agent B' }).click()
    await expect(dialog.locator('.delivery-preview')).toContainText('Changes by user:')
    await expect(dialog.locator('.delivery-preview')).not.toContainText('Your change was reverted')

    await dialog.getByRole('button', { name: /^Send$/i }).click()
    await expect(dialog).toBeHidden()

    await expect.poll(() => uploadsFor(engine, 't1').length).toBe(2)
    await expect.poll(() => uploadsFor(engine, 't2').length).toBe(2)
    const author = uploadsFor(engine, 't1')[1]!
    expect(author).toContain('Your change was reverted: Agent line.')
    expect(author).not.toContain('Changes by user:')
    const peer = uploadsFor(engine, 't2')[1]!
    expect(peer).toContain('Changes by user:')
    expect(peer).toContain('-Agent line.')
    expect(peer).toContain('+Beta.')
    expect(peer).not.toContain('Your change was reverted')
  } finally {
    await dispose(fixture)
  }
})

test('a deselected change is skipped, marked partial, and never offered again', async ({}, testInfo) => {
  const fixture = await scenario(testInfo, 'Alpha.\n\nBeta.\n')
  const { value, engine } = fixture
  try {
    const page = value.page!
    await setSource(page, 'Alpha updated.\n\nBeta.\n\nGamma added.\n')
    const dialog = await openComposer(page)
    const rows = dialog.locator('.send-item[data-author="user"]')
    await expect(rows).toHaveCount(2)
    await rows.first().locator('input').uncheck()

    await dialog.getByRole('button', { name: /Exact text/i }).click()
    const preview = dialog.locator('.delivery-preview')
    await expect(preview).toContainText('Gamma added.')
    await expect(preview).not.toContainText('Alpha updated.')
    await expect(preview).toContainText('Parts of the document changed that are not included here.')

    await dialog.getByRole('button', { name: /^Send$/i }).click()
    await expect(dialog).toBeHidden()

    await expect.poll(() => uploadsFor(engine, 't1').length).toBe(2)
    const payload = uploadsFor(engine, 't1')[1]!
    expect(payload).toContain('Parts of the document changed that are not included here.')
    expect(payload).toContain('+Gamma added.')
    expect(payload).not.toContain('Alpha updated.')

    // The skipped change is behind the acknowledged baseline now: nothing left to send.
    await expect(page.getByRole('button', { name: /^Send/i }).first()).toBeDisabled()
  } finally {
    await dispose(fixture)
  }
})

test('a review-heavy composer puts the owner comment first and keeps its rows and scroll position while the note refreshes', async ({}, testInfo) => {
  const count = 45
  const unchanged = Array.from({ length: count }, (_, index) => `Paragraph ${index}.\n\nDivider ${index}.`).join('\n\n')
  const ownerTarget = 'Owner comment target.'
  const fixture = await scenario(testInfo, `# Review\n\n${ownerTarget}\n\n${unchanged}\n`, [['t1', 'Agent A'], ['t2', 'Agent B']])
  const { value, engine } = fixture
  try {
    const page = value.page!
    await agentEditsAll(fixture, 't2', 'Agent B', Array.from({ length: count }, (_, index) => [`Paragraph ${index}.`, `External paragraph ${index}.`] as [string, string]))

    await selectTextInVisualEditor(page, ownerTarget)
    const annotate = page.getByRole('menu', { name: /annotate selection/i })
    await expect(annotate).toBeVisible()
    await annotate.getByRole('menuitem', { name: /Comment/i }).click()
    const annotationComposer = page.locator('.annotation-composer')
    await annotationComposer.getByRole('textbox', { name: /Annotation text/i }).fill('Please review this note.')
    await annotationComposer.getByRole('button', { name: /^Hold$/ }).click()
    await expect(annotationComposer).toBeHidden()

    const dialog = await openComposer(page)
    // Exact names: once the preview lands, item rows are named "Agent B Paragraph 0. External" and would match a loose lookup.
    await dialog.getByRole('checkbox', { name: 'Agent A', exact: true }).check()
    await dialog.getByRole('checkbox', { name: 'Agent B', exact: true }).uncheck()
    await dialog.getByRole('tab', { name: 'Agent A' }).click()
    const body = dialog.locator('.send-tab-body')
    await expect(body).toHaveAttribute('aria-busy', 'false')
    const headings = dialog.locator('.send-group-heading')
    await expect(headings).toHaveCount(2)
    await expect(headings.nth(0)).toContainText('Your comments')
    await expect(headings.nth(1)).toContainText('Changes not made by you')

    const externalRows = dialog.locator('.send-item[data-author="external"]')
    await expect(externalRows).toHaveCount(count)
    expect(await externalRows.locator('input').evaluateAll((inputs) => inputs.every((input) => !(input as HTMLInputElement).checked))).toBe(true)
    const comment = dialog.locator('.send-item-draft').filter({ hasText: 'Please review this note.' })
    await expect(comment).toHaveCount(1)
    await expect(comment.locator('input')).toBeChecked()

    await body.evaluate((element) => { element.scrollTop = element.scrollHeight })
    const scrollBefore = await body.evaluate((element) => element.scrollTop)
    expect(scrollBefore).toBeGreaterThan(0)
    await body.evaluate((element) => {
      const state = window as typeof window & { __sendEmptyInsertions?: number; __sendObserver?: MutationObserver }
      state.__sendEmptyInsertions = 0
      state.__sendObserver = new MutationObserver((records) => {
        for (const record of records) {
          for (const node of record.addedNodes) {
            if (!(node instanceof Element)) continue
            if (node.matches('.send-empty')) state.__sendEmptyInsertions! += 1
            state.__sendEmptyInsertions! += node.querySelectorAll('.send-empty').length
          }
        }
      })
      state.__sendObserver.observe(element, { childList: true, subtree: true })
    })
    const bodyHandle = await body.elementHandle()
    const rowHandle = await externalRows.nth(20).elementHandle()
    expect(bodyHandle).toBeTruthy()
    expect(rowHandle).toBeTruthy()

    const note = 'Ready for the focused review.'
    await dialog.getByRole('textbox', { name: /Note for recipients/i }).pressSequentially(note)
    await expect(body).toHaveAttribute('aria-busy', 'false')
    expect(await body.evaluate(() => (window as typeof window & { __sendEmptyInsertions?: number }).__sendEmptyInsertions ?? -1)).toBe(0)
    expect(await bodyHandle!.evaluate((element) => element.isConnected)).toBe(true)
    expect(await rowHandle!.evaluate((element) => element.isConnected)).toBe(true)
    expect(await body.evaluate((element) => element.scrollTop)).toBe(scrollBefore)

    await dialog.getByRole('button', { name: /Exact text/i }).click()
    await expect(dialog.locator('.delivery-preview')).toContainText(note)
    await dialog.getByRole('button', { name: /^Send$/i }).click()
    await expect(dialog).toBeHidden()

    await expect.poll(() => uploadsFor(engine, 't1').length).toBe(2)
    const payload = uploadsFor(engine, 't1')[1]!
    expect(payload).toContain(`- ${note}`)
    expect(payload).toContain('Please review this note.')
    expect(payload).not.toContain('Changes by')
    expect(uploadsFor(engine, 't2')).toHaveLength(1)
  } finally {
    await dispose(fixture)
  }
})

test('the composer resizes with a remembered size and zooms like the panes', async ({}, testInfo) => {
  const fixture = await scenario(testInfo, 'Alpha.\n\nBeta.\n')
  const { value } = fixture
  try {
    const page = value.page!
    await setSource(page, 'Alpha updated.\n\nBeta.\n')

    let dialog = await openComposer(page)
    await settled(page, dialog)
    const before = await layoutSize(dialog)

    const handle = dialog.locator('.send-composer-resize')
    const grip = await handle.boundingBox()
    expect(grip).toBeTruthy()
    await page.mouse.move(grip!.x + grip!.width / 2, grip!.y + grip!.height / 2)
    await page.mouse.down()
    await page.mouse.move(grip!.x + 160, grip!.y + 120, { steps: 6 })
    await page.mouse.up()
    const resized = await layoutSize(dialog)
    expect(resized.width).toBeGreaterThan(before.width + 100)

    await dialog.getByRole('button', { name: /^Cancel$/i }).click()
    await expect(dialog).toBeHidden()
    dialog = await openComposer(page)
    const reopened = await layoutSize(dialog)
    expect(Math.abs(reopened.width - resized.width)).toBeLessThan(12)

    // Ctrl+wheel over the composer zooms it; the top bar offers the reset.
    // Playwright's mouse.wheel does not carry the held Control through Electron,
    // so dispatch the same event the handler sees.
    await dialog.evaluate((el) => el.dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY: -120, bubbles: true, cancelable: true })))
    await expect.poll(() => dialog.evaluate((el) => getComputedStyle(el).getPropertyValue('--zoom').trim()), { timeout: 5_000 }).toBe('1.1')

    // The backdrop covers the top bar, so close the composer before resetting.
    await dialog.getByRole('button', { name: /^Cancel$/i }).click()
    await expect(dialog).toBeHidden()
    const reset = page.getByRole('menuitem', { name: /Reset zoom/i })
    await openAppMenu(page)
    await expect(reset).toBeVisible()
    await reset.click()
    await expect(reset).toBeHidden()
  } finally {
    await dispose(fixture)
  }
})
