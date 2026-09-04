import { expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { projectRoot } from './harness'
import { seededScenario, startEngine } from './cockpit-engine-harness'
import { agentEdits, attachThread, openThread } from './cockpit-agent'

// 2026-08-30 incident replay: an attached agent inserted rows into the
// delivery table of the open product page. The splice for that update
// outgrew the parsed snapshot and the editor threw an uncaught RangeError,
// unmounting the whole renderer into a blank window. The exact bytes matter,
// so the document is the frozen corpus fixture; the edit now arrives as a
// strata block from the agent's thread (§5.9).
test('an agent table edit updates the open editor instead of blanking it', async ({}, testInfo) => {
  test.setTimeout(120_000)
  const sample = await readFile(join(projectRoot, 'test/corpus/real/strata-product-page.md'), 'utf8')
  const anchor = '| Direct edits | A larger buffer edit appears as an attributed pending hunk. Keep advances the reviewed copy; Revert restores the earlier text. |'
  const insertion = `${anchor}\n| Messages | An attached agent can send a short note to another. The note wakes a waiting recipient and queues for an absent one; one note may wait per sender and recipient pair. |\n| The Lead | The one agent you put in charge. Only the Lead may accept or reject other agents' suggestions, resolve their threads, and save. Lead accepts and saves still leave pending changes for your review. |`
  expect(sample.includes(anchor)).toBe(true)

  const engine = await startEngine({ titles: { t1: 'Claude' } })
  const scenario = await seededScenario(testInfo, engine.origin, sample, 'strata.md')
  try {
    const page = await scenario.launch()
    const pageErrors: string[] = []
    page.on('pageerror', (error) => pageErrors.push(error.stack ?? error.message))
    await openThread(page, 'Claude')
    await attachThread(page, 't1', 'Claude')
    await page.getByRole('tablist', { name: 'Document navigation' }).getByRole('tab', { name: 'Contents' }).click()

    agentEdits(engine, 't1', scenario.file, anchor, anchor, insertion)

    const editor = page.getByRole('textbox', { name: /document editor/i })
    await expect(editor).toContainText('The one agent you put in charge', { timeout: 10_000 })
    await expect(page.locator('.change-row').filter({ hasText: 'Claude' })).toHaveCount(1)
    expect(pageErrors, pageErrors.join('\n')).toEqual([])
  } finally {
    await scenario.dispose()
    await engine.close()
  }
})
