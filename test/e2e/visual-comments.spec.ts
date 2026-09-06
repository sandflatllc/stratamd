import { expect, test, type Page } from '@playwright/test'
import { readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { selectNavigationTab } from './harness'
import { seededScenario, startEngine, type FakeEngine } from './cockpit-engine-harness'

/**
 * The image comment loop (docs/plans/open/visual-review, phase 1 checklist):
 * a pasted screenshot opens the session, Hold survives a relaunch, Send
 * carries the marked screenshot inside the budget, the agent answers by
 * revision, and Looks right and Still wrong work without extra turns.
 */

/** Ctrl+V with a screenshot on the clipboard: a 320 by 200 PNG drawn in the page, as Chromium delivers a paste. */
async function pasteScreenshot(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const canvas = document.createElement('canvas')
    canvas.width = 320; canvas.height = 200
    const context = canvas.getContext('2d')!
    context.fillStyle = '#f6f7fb'; context.fillRect(0, 0, 320, 200)
    context.fillStyle = '#5b4aa8'; context.fillRect(200, 20, 100, 36)
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((value) => resolve(value!), 'image/png'))
    const transfer = new DataTransfer()
    transfer.items.add(new File([blob], 'image.png', { type: 'image/png' }))
    const target = document.querySelector('textarea[aria-label="Message conversation"]')
    if (!target) throw new Error('The composer is not on screen')
    target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }))
  })
}

async function openLiveThread(page: Page) {
  await page.getByRole('tablist', { name: 'Document navigation' }).getByRole('tab', { name: 'Projects' }).click()
  await page.getByRole('button', { name: /^Open Live engine thread$/ }).click()
  return page.getByRole('region', { name: 'Conversation' })
}

const session = (page: Page) => page.getByRole('dialog', { name: 'Mark up the image' })

/** One region mark, one arrow, and a note; returns the session locator. */
async function markUp(page: Page, note: string) {
  const dialog = session(page)
  await expect(dialog).toBeVisible()
  const tools = dialog.getByRole('toolbar', { name: 'Annotation tools' })
  for (const name of ['Mark', 'Draw', 'Arrow', 'Erase']) await expect(tools.getByRole('button', { name: new RegExp(`^${name}`) })).toBeVisible()
  const surface = dialog.locator('.visual-surface')
  await expect(surface.locator('img')).toBeVisible()
  await surface.click({ position: { x: 40, y: 40 } })
  await expect(dialog.locator('.visual-chip').filter({ hasText: 'Region 1' })).toBeVisible()
  await tools.getByRole('button', { name: /^Arrow/ }).click()
  const box = (await surface.boundingBox())!
  await page.mouse.move(box.x + 60, box.y + 120)
  await page.mouse.down()
  await page.mouse.move(box.x + 140, box.y + 60, { steps: 4 })
  await page.mouse.up()
  await expect(dialog.locator('.visual-chip').filter({ hasText: 'arrow' })).toBeVisible()
  await dialog.getByRole('textbox', { name: 'Visual comment' }).fill(note)
  return dialog
}

const evidenceFiles = async (dataHome: string) => (await readdir(join(dataHome, 'stratamd', 'visual-evidence')).catch(() => [] as string[])).filter((name) => name.endsWith('.bin'))
const stagedFiles = async (dataHome: string) => (await readdir(join(dataHome, 'stratamd', 'composer-attachments')).catch(() => [] as string[])).filter((name) => name.endsWith('.bin'))

/** The agent answers a visual comment by revision. */
function agentReplies(engine: FakeEngine, id: string, revision: number, text: string, ready: boolean): string {
  return engine.postAssistant('t1', `${text}\n\n\`\`\`strata\n${JSON.stringify([{ verb: 'reply', anchor: { item: id }, revision, text, ready }])}\n\`\`\``)
}

test('1: with no document open, a pasted screenshot opens the session, and Hold survives a relaunch', async ({}, testInfo) => {
  const engine = await startEngine({ pendingRequests: false })
  const scenario = await seededScenario(testInfo, engine.origin)
  const dataHome = String(scenario.env.XDG_DATA_HOME)
  try {
    let page = await scenario.launchEmpty()
    let conversation = await openLiveThread(page)
    await expect(conversation.getByRole('textbox', { name: 'Message conversation' })).toBeVisible()
    await pasteScreenshot(page)
    const dialog = await markUp(page, 'The button floats above the table header.')
    // The card names the destination thread in plain words, and no label names a file or selector.
    await expect(dialog.locator('.visual-context')).toContainText('Pasted image · 320 × 200 · to Live engine thread')
    expect(await dialog.textContent()).not.toMatch(/\.png|selector|\.tsx|px\b/)
    await dialog.getByRole('button', { name: 'Hold' }).click()
    await expect(dialog).toBeHidden()
    // The staged image moved into the evidence store with its marked version; the composer shows the held card, not an attachment.
    await expect.poll(() => evidenceFiles(dataHome)).toHaveLength(2)
    expect(await stagedFiles(dataHome)).toHaveLength(0)
    await expect(conversation.locator('.conversation-attachment-preview')).toHaveCount(0)
    const staged = conversation.locator('.conversation-visual-card')
    await expect(staged).toHaveCount(1)
    await expect(staged.locator('.visual-status')).toHaveText('held')
    await expect(staged).toContainText('The button floats above the table header.')
    await expect(staged.locator('.visual-meta')).toHaveText('1 thing marked · 1 arrow')
    await expect(staged.locator('.visual-thumb img')).toHaveAttribute('src', /^strata-visual:\/\/evidence\//)

    await scenario.stop()
    page = await scenario.launchEmpty()
    conversation = await openLiveThread(page)
    const restored = conversation.locator('.conversation-visual-card')
    await expect(restored).toHaveCount(1)
    await expect(restored).toContainText('The button floats above the table header.')
    await expect(restored.locator('.visual-meta')).toHaveText('1 thing marked · 1 arrow')
    expect(await stagedFiles(dataHome)).toHaveLength(0)
    // Open brings the marks back into the session.
    await restored.getByRole('button', { name: 'Open the marked image' }).click()
    const reopened = session(page)
    await expect(reopened.locator('.visual-chip').filter({ hasText: 'Region 1' })).toBeVisible()
    await expect(reopened.getByRole('textbox', { name: 'Visual comment' })).toHaveValue('The button floats above the table header.')
    await page.keyboard.press('Escape')
    await expect(reopened).toBeHidden()
  } finally {
    await scenario.dispose()
    await engine.close()
  }
})

test('2: the capacity line says what Send carries beside ordinary attachments', async ({}, testInfo) => {
  const engine = await startEngine({ pendingRequests: false })
  const scenario = await seededScenario(testInfo, engine.origin)
  try {
    const page = await scenario.launchEmpty()
    const conversation = await openLiveThread(page)
    await expect(conversation.getByRole('textbox', { name: 'Message conversation' })).toBeVisible()
    await conversation.locator('.conversation-attachment-input').setInputFiles([1, 2, 3].map((index) => ({ name: `notes-${index}.md`, mimeType: 'text/markdown', buffer: Buffer.from(`# Notes ${index}\n`) })))
    await expect(conversation.locator('.conversation-attachment-preview')).toHaveCount(3)
    await expect(conversation.locator('.conversation-capacity')).toHaveText('Send carries 3 files · 3 of 8')
    await pasteScreenshot(page)
    const dialog = await markUp(page, 'Marked beside three files.')
    await dialog.getByRole('button', { name: 'Hold' }).click()
    await expect(dialog).toBeHidden()
    await expect(conversation.locator('.conversation-attachment-preview')).toHaveCount(3)
    await expect(conversation.locator('.conversation-capacity')).toHaveText('Send carries 3 files, 1 marked screenshot, and the context file · 5 of 8')
    // Setting the comment aside for this send keeps it held and drops it from the count.
    await conversation.getByRole('button', { name: /^Set aside/ }).click()
    await expect(conversation.locator('.conversation-capacity')).toHaveText('Send carries 3 files · 3 of 8')
    await expect(conversation.locator('.conversation-visual-card .visual-status')).toHaveText('held')
    await conversation.getByRole('button', { name: /^Include/ }).click()
    await expect(conversation.locator('.conversation-capacity')).toHaveText('Send carries 3 files, 1 marked screenshot, and the context file · 5 of 8')
    // The composer Send carries the files, the marked screenshot, and the context file in one turn.
    await conversation.getByRole('textbox', { name: 'Message conversation' }).fill('Both at once')
    const stop = conversation.getByRole('button', { name: 'Stop' })
    if (await stop.isVisible()) await stop.click()
    await conversation.getByRole('button', { name: 'Send', exact: true }).click()
    await expect.poll(() => engine.commands.filter((command) => command.type === 'thread.turn.start').length).toBe(1)
    const turn = engine.commands.find((command) => command.type === 'thread.turn.start')!.message as { text: string; attachments: Array<{ type: string; name: string }> }
    expect(turn.text).toBe('Both at once')
    expect(turn.attachments.map((attachment) => attachment.type)).toEqual(['file', 'file', 'file', 'image', 'file'])
    expect(turn.attachments[3]!.name).toMatch(/^visual-[0-9a-f]{8}-r1-1\.png$/)
    await expect(conversation.locator('.conversation-visual-card')).toHaveCount(0)
  } finally {
    await scenario.dispose()
    await engine.close()
  }
})

test('3: Send now, a ready reply by revision, Looks right without a turn, Still wrong as a new revision, and a late reply that changes nothing', async ({}, testInfo) => {
  const engine = await startEngine({ pendingRequests: false })
  const scenario = await seededScenario(testInfo, engine.origin, '# Review\n\nThe clients table.\n', 'visual-loop.md')
  engine.setWorkspaceRoot(dirname(scenario.file))
  try {
    const page = await scenario.launch()
    await selectNavigationTab(page, 'Projects')
    const conversation = await openLiveThread(page)
    await selectNavigationTab(page, 'Conversation')
    await expect(conversation.getByRole('textbox', { name: 'Message conversation' })).toBeVisible()
    await pasteScreenshot(page)
    const dialog = await markUp(page, 'Move the button into the header row.')
    await dialog.getByRole('button', { name: 'Send now' }).click()
    await expect(dialog).toBeHidden()
    await expect.poll(() => engine.commands.filter((command) => command.type === 'thread.turn.start').length).toBe(1)
    const first = engine.commands.find((command) => command.type === 'thread.turn.start')!.message as { text: string; attachments: Array<{ type: string; id: string }> }
    expect(first.text).toBe('Visual comment: Region 1.')
    expect(first.attachments.map((attachment) => attachment.type)).toEqual(['image', 'file'])
    const context = engine.uploadsById.get(first.attachments[1]!.id)!
    expect(context).toContain('## Visual comments')
    expect(context).toContain('Move the button into the header row.')
    const id = /"id": "(v_[^"]+)"/.exec(context)![1]!

    // The Items rail lists the comment under its own filter; the fake engine lists the sent message, so it reads sent.
    await page.getByRole('tab', { name: /^Items/ }).click()
    const items = page.locator('#review-panel-annotations')
    await items.getByRole('button', { name: 'Visual' }).click()
    const card = items.locator('.visual-card-row')
    await expect(card).toHaveCount(1)
    await expect(card.locator('.visual-status')).toHaveText('sent')
    await expect(card.locator('.visual-where')).toHaveText('Pasted image · 320 × 200')

    // A ready reply naming revision 1 moves the card to ready for review.
    agentReplies(engine, id, 1, 'Moved the button into the header row.', true)
    await expect(card.locator('.visual-status')).toHaveText('ready for review')
    await expect(card.locator('.visual-reply')).toContainText('Moved the button into the header row.')
    await expect(conversation.locator('.conversation-visual-reply')).toContainText('ready for review')

    // Still wrong opens the next private note over the same marks; Send now makes revision 2.
    await card.getByRole('button', { name: 'Still wrong' }).click()
    const again = session(page)
    await expect(again).toBeVisible()
    await expect(again.locator('.visual-chip').filter({ hasText: 'Region 1' })).toBeVisible()
    await again.getByRole('textbox', { name: 'Visual comment' }).fill('Closer, but it still overlaps the first column.')
    await again.getByRole('button', { name: 'Send now' }).click()
    await expect(again).toBeHidden()
    await expect.poll(() => engine.commands.filter((command) => command.type === 'thread.turn.start').length).toBe(2)
    await expect(card.locator('.visual-status')).toHaveText('sent')

    // A late reply to revision 1 stays readable and leaves the card unchanged.
    agentReplies(engine, id, 1, 'One more note on the first pass.', true)
    await expect(page.getByRole('region', { name: 'Conversation' })).toContainText('One more note on the first pass.')
    await expect(card.locator('.visual-status')).toHaveText('sent')
    await expect(card.getByRole('button', { name: 'Looks right' })).toHaveCount(0)

    agentReplies(engine, id, 2, 'Pulled it clear of the first column.', true)
    await expect(card.locator('.visual-status')).toHaveText('ready for review')
    // Looks right marks the card done and starts no turn.
    await card.getByRole('button', { name: 'Looks right' }).click()
    await expect(card.locator('.visual-status')).toHaveText('done')
    await expect(card).toContainText('Accepted')
    expect(engine.commands.filter((command) => command.type === 'thread.turn.start')).toHaveLength(2)
  } finally {
    await scenario.dispose()
    await engine.close()
  }
})

test('4: a failed Send stays retryable and retry sends the frozen revision, not a newer draft', async ({}, testInfo) => {
  const engine = await startEngine({ pendingRequests: false })
  const scenario = await seededScenario(testInfo, engine.origin, '# Review\n\nThe clients table.\n', 'visual-retry.md')
  engine.setWorkspaceRoot(dirname(scenario.file))
  try {
    const page = await scenario.launch()
    await selectNavigationTab(page, 'Projects')
    await openLiveThread(page)
    await selectNavigationTab(page, 'Conversation')
    await pasteScreenshot(page)
    const dialog = await markUp(page, 'First wording.')
    engine.failNextTurn()
    await dialog.getByRole('button', { name: 'Send now' }).click()
    await expect(dialog).toBeHidden()
    await page.getByRole('tab', { name: /^Items/ }).click()
    const card = page.locator('#review-panel-annotations .visual-card-row')
    await expect(card.locator('.visual-status')).toHaveText('send failed')
    await expect(card.getByRole('alert')).toContainText('Send failed')
    expect(engine.commands.filter((command) => command.type === 'thread.turn.start')).toHaveLength(0)
    await card.getByRole('button', { name: 'Retry' }).click()
    await expect.poll(() => engine.commands.filter((command) => command.type === 'thread.turn.start').length).toBe(1)
    const turn = engine.commands.find((command) => command.type === 'thread.turn.start')!.message as { attachments: Array<{ id: string }> }
    expect(engine.uploadsById.get(turn.attachments[1]!.id)).toContain('First wording.')
    await expect(card.locator('.visual-status')).toHaveText('sent')
  } finally {
    await scenario.dispose()
    await engine.close()
  }
})
