import { expect, test, type Page } from './test'
import { seededScenario, startEngine } from './cockpit-engine-harness'

/** A 1 by 1 PNG, enough for Chromium to decode a thumbnail from. */
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
const PNG_BYTES = Buffer.from(PNG_BASE64, 'base64').byteLength
/** Set STRATA_CAPTURES=1 to write the review captures under docs/design/conversation-composer/captures/. */
const capture = async (page: Page, name: string) => { if (process.env.STRATA_CAPTURES) await page.screenshot({ path: `docs/design/conversation-composer/captures/${name}.png` }) }

/** Ctrl+V with an image on the clipboard: the paste event carries a File, as Chromium delivers it. */
async function pasteImage(page: Page, name = 'image.png'): Promise<void> {
  await page.evaluate(({ base64, name }) => {
    const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0))
    const transfer = new DataTransfer()
    transfer.items.add(new File([bytes], name, { type: 'image/png' }))
    const target = document.querySelector('textarea[aria-label="Message conversation"]')
    if (!target) throw new Error('The composer is not on screen')
    target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }))
  }, { base64: PNG_BASE64, name })
}

async function openLiveThread(page: Page) {
  await page.getByRole('tablist', { name: 'Document navigation' }).getByRole('tab', { name: 'Projects' }).click()
  await page.getByRole('button', { name: /^Open Live engine thread$/ }).click()
  return page.getByRole('region', { name: 'Conversation' })
}

test('6.0: a pasted screenshot stages as an image attachment, survives reload, and uploads with its real type', async ({}, testInfo) => {
  const engine = await startEngine()
  const scenario = await seededScenario(testInfo, engine.origin)
  try {
    const page = await scenario.launch()
    let conversation = await openLiveThread(page)
    await conversation.getByRole('textbox', { name: 'Message conversation' }).fill('Look at this')
    await pasteImage(page)
    const preview = conversation.locator('.conversation-attachment-preview[data-kind="image"]')
    await expect(preview).toHaveCount(1)
    await expect(preview).toContainText(/^pasted-image-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.png/)
    await expect(preview.locator('img')).toHaveAttribute('src', /^data:image\//)
    // The paste inserted no text.
    await expect(conversation.getByRole('textbox', { name: 'Message conversation' })).toHaveValue('Look at this')

    // A second paste in the same second would repeat the name; the id keeps them apart either way.
    await conversation.locator('.conversation-attachment-input').setInputFiles({ name: 'reference.md', mimeType: 'text/markdown', buffer: Buffer.from('# Reference\n') })
    await expect(conversation.locator('.conversation-attachment-preview')).toHaveCount(2)
    await capture(page, 'image-staged')

    // The image bytes live with the main process, so the draft comes back whole after a reload.
    await page.reload()
    conversation = await openLiveThread(page)
    await expect(conversation.locator('.conversation-attachment-preview')).toHaveCount(2)
    await expect(conversation.locator('.conversation-attachment-preview[data-kind="image"] img')).toHaveAttribute('src', /^data:image\//)
    await expect(conversation.getByRole('textbox', { name: 'Message conversation' })).toHaveValue('Look at this')

    await conversation.getByRole('button', { name: 'Remove reference.md' }).click()
    await expect(conversation.locator('.conversation-attachment-preview')).toHaveCount(1)

    const stop = conversation.getByRole('button', { name: 'Stop' })
    if (await stop.isVisible()) await stop.click()
    await conversation.getByRole('button', { name: 'Send', exact: true }).click()
    await expect.poll(() => engine.commands.filter((command) => command.type === 'thread.turn.start').length).toBe(1)
    const turn = engine.commands.find((command) => command.type === 'thread.turn.start')!.message as { text: string; attachments: Array<Record<string, unknown>> }
    expect(turn.text).toBe('Look at this')
    expect(turn.attachments).toHaveLength(1)
    expect(turn.attachments[0]).toMatchObject({ type: 'image', mimeType: 'image/png', sizeBytes: PNG_BYTES, name: expect.stringMatching(/^pasted-image-.*\.png$/) })
    expect(engine.uploadRequests).toEqual([{ attachmentId: String(turn.attachments[0]!.id), contentType: 'image/png', byteLength: PNG_BYTES }])
    await expect(conversation.locator('.conversation-attachment-preview')).toHaveCount(0)
    await capture(page, 'image-sent')
  } finally {
    await scenario.dispose()
    await engine.close()
  }
})

test('6.0: an unsupported image type is refused by name and plain text still pastes as text', async ({}, testInfo) => {
  const engine = await startEngine()
  const scenario = await seededScenario(testInfo, engine.origin)
  try {
    const page = await scenario.launch()
    const conversation = await openLiveThread(page)
    await conversation.getByRole('textbox', { name: 'Message conversation' }).waitFor()
    await page.evaluate(() => {
      const transfer = new DataTransfer()
      transfer.items.add(new File(['<svg xmlns="http://www.w3.org/2000/svg"/>'], 'logo.svg', { type: 'image/svg+xml' }))
      document.querySelector('textarea[aria-label="Message conversation"]')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }))
    })
    await expect(conversation.getByRole('alert')).toContainText('logo.svg is a image/svg+xml image. Attach a PNG, JPEG, GIF, or WebP image.')
    await expect(conversation.locator('.conversation-attachment-preview')).toHaveCount(0)
    // Plain text is left to the textarea: the composer does not claim the event.
    const claimed = await page.evaluate(() => {
      const transfer = new DataTransfer()
      transfer.setData('text/plain', 'typed by paste')
      const event = new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true })
      document.querySelector('textarea[aria-label="Message conversation"]')!.dispatchEvent(event)
      return event.defaultPrevented
    })
    expect(claimed).toBe(false)
  } finally {
    await scenario.dispose()
    await engine.close()
  }
})
