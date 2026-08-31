import { expect, test } from '@playwright/test'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Scenario, projectRoot } from './harness'

// 2026-08-30 incident replay: an attached agent inserted rows into the
// delivery table of the open product page by editing the working buffer. The
// splice for that update outgrew the parsed snapshot and the editor threw an
// uncaught RangeError, unmounting the whole renderer into a blank window.
// The exact bytes matter, so the document is the frozen corpus fixture.
test('an agent table edit to the buffer updates the open editor instead of blanking it', async ({}, testInfo) => {
  test.setTimeout(120_000)
  const sample = await readFile(join(projectRoot, 'test/corpus/real/strata-product-page.md'), 'utf8')
  const anchor = '| Direct edits | A larger buffer edit appears as an attributed pending hunk. Keep advances the reviewed copy; Revert restores the earlier text. |\n| Ghost |'
  const insertion = '| Direct edits | A larger buffer edit appears as an attributed pending hunk. Keep advances the reviewed copy; Revert restores the earlier text. |\n| Messages | An attached agent can send a short note to another. The note wakes a waiting recipient and queues for an absent one; one note may wait per sender and recipient pair. |\n| The Lead | The one agent you put in charge. Only the Lead may accept or reject other agents\' suggestions, resolve their threads, and save. Lead accepts and saves still leave pending changes for your review. |\n| Ghost |'

  const scenario = await Scenario.create(testInfo, sample, 'strata.md')
  try {
    const page = await scenario.launch()
    const pageErrors: string[] = []
    page.on('pageerror', (error) => pageErrors.push(error.stack ?? error.message))

    const attach = await scenario.attach('ag_repro', 'Claude')
    expect(attach.buffer).toBeTruthy()
    await scenario.tag('ag_repro', 'Claude')

    const buffer = await readFile(attach.buffer!, 'utf8')
    expect(buffer.includes(anchor)).toBe(true)
    await writeFile(attach.buffer!, buffer.replace(anchor, insertion))

    const editor = page.getByRole('textbox', { name: /document editor/i })
    await expect(editor).toContainText('The one agent you put in charge', { timeout: 10_000 })
    expect(pageErrors, pageErrors.join('\n')).toEqual([])
  } finally {
    await scenario.dispose()
  }
})
