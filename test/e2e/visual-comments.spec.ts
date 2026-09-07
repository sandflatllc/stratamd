import { expect, test, type Page } from './test'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { paintCommentSheet } from '../../src/shared/visual-comment-sheet'
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
  const conversation = page.getByRole('region', { name: 'Conversation' })
  await expect(conversation.getByRole('textbox', { name: 'Message conversation' })).toBeVisible()
  return conversation
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
    // The destination stays readable, with the thread title available on hover.
    await expect(dialog.locator('.visual-context')).toHaveText('Send to this conversation')
    await expect(dialog.locator('.visual-context')).toHaveAttribute('title', 'Pasted image · 320 × 200 · Live engine thread')
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
    await restored.getByRole('button', { name: /^Remove held visual comment:/ }).click()
    await expect(restored).toHaveCount(0)
    await expect.poll(() => evidenceFiles(dataHome)).toHaveLength(0)
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
    await expect(conversation.locator('.conversation-capacity')).toHaveText('Send carries 3 files and 1 marked screenshot · 4 of 8')
    // Setting the comment aside for this send keeps it held and drops it from the count.
    await conversation.getByRole('checkbox', { name: 'Include', exact: true }).uncheck()
    await expect(conversation.locator('.conversation-capacity')).toHaveText('Send carries 3 files · 3 of 8')
    await expect(conversation.locator('.conversation-visual-card .visual-status')).toHaveText('held')
    await conversation.getByRole('checkbox', { name: 'Include', exact: true }).check()
    await expect(conversation.locator('.conversation-capacity')).toHaveText('Send carries 3 files and 1 marked screenshot · 4 of 8')
    // The composer sends one image per visual comment, with exact matching details in the message.
    await conversation.getByRole('textbox', { name: 'Message conversation' }).fill('Both at once')
    const stop = conversation.getByRole('button', { name: 'Stop' })
    if (await stop.isVisible()) await stop.click()
    await conversation.getByRole('button', { name: 'Send', exact: true }).click()
    await expect.poll(() => engine.commands.filter((command) => command.type === 'thread.turn.start').length).toBe(1)
    const turn = engine.commands.find((command) => command.type === 'thread.turn.start')!.message as { text: string; attachments: Array<{ type: string; name: string }> }
    expect(turn.text).toContain('Both at once')
    expect(turn.text).toContain('Marked beside three files.')
    expect(turn.attachments.map((attachment) => attachment.type)).toEqual(['file', 'file', 'file', 'image'])
    expect(turn.attachments[3]!.name).toMatch(/^visual-[0-9a-f]{8}-r1-1\.png$/)
    const store = JSON.parse(await readFile(join(scenario.env.XDG_DATA_HOME!, 'stratamd', 'engine-visual-comments.json'), 'utf8'))
    const records = Object.values(store.comments) as Array<{ revisions: Array<{ evidence: string[] }> }>
    const exported = await readFile(join(scenario.env.XDG_DATA_HOME!, 'stratamd', 'visual-evidence', `${records[0]!.revisions[0]!.evidence[0]}.bin`))
    expect(exported.readUInt32BE(16)).toBe(720) // 320 px screenshot plus a 400 px note column.
    expect(exported.readUInt32BE(20)).toBeGreaterThanOrEqual(200)
    await testInfo.attach('sent-comment-sheet', { body: exported, contentType: 'image/png' })
    await expect.poll(async () => (await page.evaluate(() => window.strata.getState())).engine.projects.flatMap(project => project.threads).flatMap(thread => thread.messages).some(message => message.role === 'user' && message.text === 'Both at once')).toBe(true)

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
    expect(first.text).toContain('Visual comment: Region 1.')
    expect(first.attachments.map((attachment) => attachment.type)).toEqual(['image'])
    const context = first.text
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
    const turn = engine.commands.find((command) => command.type === 'thread.turn.start')!.message as { text: string; attachments: Array<{ id: string }> }
    expect(turn.attachments).toHaveLength(1)
    expect(turn.text).toContain('First wording.')
    await expect(card.locator('.visual-status')).toHaveText('sent')
  } finally {
    await scenario.dispose()
    await engine.close()
  }
})


test('cancelling a pasted photo removes the attachment and survives reopening the conversation', async ({}, testInfo) => {
  const engine = await startEngine({ pendingRequests: false })
  const scenario = await seededScenario(testInfo, engine.origin)
  try {
    let page = await scenario.launchEmpty()
    await openLiveThread(page)
    await pasteScreenshot(page)
    const dialog = session(page)
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Cancel attachment', exact: true }).click()
    await expect(dialog).toBeHidden()
    await expect(page.locator('.conversation-attachment-preview')).toHaveCount(0)
    await expect(page.locator('.conversation-visual-card')).toHaveCount(0)
    await expect.poll(() => stagedFiles(String(scenario.env.XDG_DATA_HOME))).toHaveLength(0)
    await scenario.stop()
    page = await scenario.launchEmpty()
    await openLiveThread(page)
    await expect(page.locator('.conversation-attachment-preview')).toHaveCount(0)
    await expect(session(page)).toBeHidden()
    expect(engine.commands.filter(command => command.type === 'thread.turn.start')).toHaveLength(0)
  } finally { await scenario.dispose(); await engine.close() }
})


test('comment sheets preserve screenshot pixels and grow for long notes below wide captures', async ({}, testInfo) => {
  const engine = await startEngine({ pendingRequests: false })
  const scenario = await seededScenario(testInfo, engine.origin)
  try {
    const page = await scenario.launchEmpty()
    const image = await page.evaluate(() => {
      const canvas = document.createElement('canvas')
      canvas.width = 1769; canvas.height = 130
      const ctx = canvas.getContext('2d')!
      ctx.fillStyle = 'rgb(12, 24, 36)'; ctx.fillRect(0, 0, canvas.width, canvas.height)
      return canvas.toDataURL('image/png')
    })
    const sheet = await page.evaluate(paintCommentSheet, { image, text: ('Round the corners without covering the screenshot.\n').repeat(15) + 'End of the comment.', labels: ['Region 1'], adjustments: [], requested: false })
    expect(sheet.width).toBe(1769)
    expect(sheet.height).toBeGreaterThan(700)
    const pixels = await page.evaluate(async (sheet) => {
      const img = new Image(); img.src = sheet.dataUrl; await img.decode()
      const canvas = document.createElement('canvas'); canvas.width = sheet.width; canvas.height = sheet.height
      const ctx = canvas.getContext('2d')!; ctx.drawImage(img, 0, 0)
      return { screenshot: [...ctx.getImageData(100, 100, 1, 1).data], paper: [...ctx.getImageData(1, 140, 1, 1).data], bottomInk: [...ctx.getImageData(30, sheet.height - 90, 700, 60).data].filter((channel, index) => index % 4 !== 3 && channel < 100).length }
    }, sheet)
    expect(pixels.screenshot).toEqual([12, 24, 36, 255])
    expect(pixels.paper).toEqual([245, 246, 248, 255])
    expect(pixels.bottomInk).toBeGreaterThan(10)
    await testInfo.attach('wide-comment-sheet', { body: Buffer.from(sheet.dataUrl.split(',')[1]!, 'base64'), contentType: 'image/png' })
  } finally { await scenario.dispose(); await engine.close() }
})
