import { expect, test } from '@playwright/test'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Scenario, projectRoot, selectTextInVisualEditor } from './harness'

// The reported flow: the user opens the comment composer, an agent edit lands
// while they type, and Submit fails with "The selected quote no longer
// matches the buffer" because the captured from/to offsets refer to the
// pre-edit markdown.
test('a comment composed before an agent edit above still lands', async ({}, testInfo) => {
  test.setTimeout(120_000)
  const sample = await readFile(join(projectRoot, 'test/corpus/real/strata-product-page.md'), 'utf8')
  const scenario = await Scenario.create(testInfo, sample, 'strata.md')
  try {
    const page = await scenario.launch()
    const pageErrors: string[] = []
    page.on('pageerror', (error) => pageErrors.push(error.stack ?? error.message))
    await page.waitForTimeout(1_500)

    const attach = await scenario.attach('ag_repro', 'Claude')
    expect(attach.buffer).toBeTruthy()
    await scenario.tag('ag_repro', 'Claude')

    // Open the composer on a paragraph far below the top.
    await selectTextInVisualEditor(page, 'Reviewing it is still awkward.')
    const menu = page.getByRole('menu', { name: /annotate selection/i })
    await menu.waitFor({ state: 'visible', timeout: 10_000 })
    await page.locator('.selection-menu button').first().click()
    const composer = page.locator('.annotation-composer')
    await composer.waitFor({ state: 'visible', timeout: 10_000 })
    await composer.locator('textarea').fill('typed before the agent edit')

    // While the composer is open, the agent edits text ABOVE the selection,
    // shifting every later offset.
    const buffer = await readFile(attach.buffer!, 'utf8')
    const target = 'Write with agents. Keep the final say.'
    expect(buffer.includes(target)).toBe(true)
    await writeFile(attach.buffer!, buffer.replace(target, 'Write with several collaborating agents. Keep the final say, always.'))
    const editor = page.getByRole('textbox', { name: /document editor/i })
    await expect(editor).toContainText('several collaborating agents', { timeout: 10_000 })
    await page.waitForTimeout(1_000)

    await page.evaluate(() => (document.querySelector('.annotation-composer') as HTMLFormElement).requestSubmit())
    await expect.poll(async () => {
      const toasts = page.locator('.toast')
      const count = await toasts.count()
      const texts: string[] = []
      for (let index = 0; index < count; index += 1) texts.push((await toasts.nth(index).textContent()) ?? '')
      return texts.join(' | ')
    }, { timeout: 10_000 }).not.toBe('')
    const toasts = page.locator('.toast')
    const count = await toasts.count()
    const texts: string[] = []
    for (let index = 0; index < count; index += 1) texts.push((await toasts.nth(index).textContent()) ?? '')

    const state = await scenario.state()
    const stored = state.annotations?.find((a) => a.text === 'typed before the agent edit')
    expect(pageErrors, pageErrors.join('\n')).toEqual([])
    expect(texts.join(' | ')).not.toContain('no longer matches')
    expect(stored?.quote).toBe('Reviewing it is still awkward.')
  } finally {
    await scenario.dispose()
  }
})
