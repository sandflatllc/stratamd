import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'
import { Scenario, setSource } from './harness'

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
// semantics, and the modal's size and zoom.

async function scenario(testInfo: TestInfo, content: string): Promise<Scenario> {
  const value = await Scenario.create(testInfo, content, 'plan.md')
  await value.launch()
  return value
}

async function writeTaggedBuffer(value: Scenario, agent: string, name: string, content: string): Promise<void> {
  const state = await value.state()
  expect(state.buffer).toBeTruthy()
  const tagged = await value.cli(['changed', value.file, '--as', agent, '--name', name])
  expect(tagged.code, tagged.stderr).toBe(0)
  await value.atomicWrite(state.buffer!, content)
}

async function openComposer(page: Page) {
  await page.getByRole('button', { name: /^Send/i }).first().click()
  const dialog = page.getByRole('dialog', { name: /Send changes/i })
  await expect(dialog).toBeVisible()
  return dialog
}

test('a reverted agent edit reaches its author as a verdict and others as a user diff', async ({}, testInfo) => {
  const value = await scenario(testInfo, 'Alpha.\n\nBeta.\n')
  try {
    const page = value.page!
    expect((await value.attach('agent-a', 'Agent A')).event).toBe('initial')
    expect((await value.attach('agent-b', 'Agent B')).event).toBe('initial')

    await writeTaggedBuffer(value, 'agent-a', 'Agent A', 'Alpha.\n\nBeta.\n\nAgent line.\n')
    const revert = page.getByRole('button', { name: /^Revert change /i }).first()
    await expect(revert).toBeVisible()
    await revert.click()

    const dialog = await openComposer(page)
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

    const author = await value.attach('agent-a', 'Agent A')
    expect(author.event).toBe('send')
    expect(author.segments ?? []).toHaveLength(0)
    expect(author.edits).toEqual([expect.objectContaining({ verdict: 'reverted', quote: 'Agent line.' })])
    expect(author.text).toContain('Your change was reverted: Agent line.')

    const peer = await value.attach('agent-b', 'Agent B')
    expect(peer.event).toBe('send')
    expect(peer.segments?.some((segment) => segment.author === 'user')).toBe(true)
    expect(peer.text).not.toContain('Your change was reverted')
  } finally {
    await value.dispose()
  }
})

test('a deselected change is skipped, marked partial, and never offered again', async ({}, testInfo) => {
  const value = await scenario(testInfo, 'Alpha.\n\nBeta.\n')
  try {
    const page = value.page!
    expect((await value.attach('agent-a', 'Agent A')).event).toBe('initial')

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

    const payload = await value.attach('agent-a', 'Agent A')
    expect(payload.event).toBe('send')
    expect(payload.partial).toBe(true)
    const added = payload.segments?.flatMap((segment) => segment.hunks.flatMap((hunk) => hunk.added)) ?? []
    expect(added).toContain('Gamma added.')
    expect(added).not.toContain('Alpha updated.')

    // The skipped change is behind the acknowledged baseline now: nothing left to send.
    await expect(page.getByRole('button', { name: /^Send/i }).first()).toBeDisabled()
  } finally {
    await value.dispose()
  }
})

test('the composer resizes with a remembered size and zooms like the panes', async ({}, testInfo) => {
  const value = await scenario(testInfo, 'Alpha.\n\nBeta.\n')
  try {
    const page = value.page!
    expect((await value.attach('agent-a', 'Agent A')).event).toBe('initial')
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
    const reset = page.getByRole('button', { name: /Reset zoom/i })
    await expect(reset).toBeVisible()
    await reset.click()
    await expect(reset).toBeHidden()
  } finally {
    await value.dispose()
  }
})
