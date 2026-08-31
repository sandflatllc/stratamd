import { expect, test } from '@playwright/test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { Scenario, save } from './harness'

const run = promisify(execFile)

// The seeding and save-history suite (docs/plans/completed/ghost-redesign-plan.md §10): an
// untracked file inside a git work tree — the case that motivated the plan —
// seeds from itself, a tagged multi-write burst keeps its name on every row,
// each Save lists a round in the rail, expansion is read-only, and the
// history survives a restart.

test('an untracked file seeds from itself; a tagged burst stays named; save rounds persist', async ({}, testInfo) => {
  const scenario = await Scenario.create(testInfo, '# Plan\n\nOriginal.\n', 'plan.md')
  const documents = dirname(scenario.file)
  await run('git', ['-C', documents, 'init', '-q'])
  await run('git', ['-C', documents, 'config', 'user.email', 'test@example.com'])
  await run('git', ['-C', documents, 'config', 'user.name', 'Test'])
  await writeFile(join(documents, 'other.md'), 'committed\n')
  await run('git', ['-C', documents, 'add', 'other.md'])
  await run('git', ['-C', documents, 'commit', '-qm', 'unrelated'])

  try {
    const page = await scenario.launch()
    const state = await scenario.state()
    expect(state.buffer).toBeTruthy()

    // One tag, two writes: both hunks discrete and named, never one
    // whole-document insert (the ghost is the document itself).
    await scenario.tag('ag_e2e', 'Claude')
    await scenario.atomicWrite(state.buffer!, '# Plan, revised\n\nOriginal.\n')
    await expect(page.locator('.change-row').filter({ hasText: 'Claude' })).toHaveCount(1)
    await scenario.atomicWrite(state.buffer!, '# Plan, revised\n\nOriginal.\n\nAppendix.\n')
    await expect(page.locator('.change-row').filter({ hasText: 'Claude' })).toHaveCount(2)

    await save(page)
    await expect(page.locator('.save-history-heading')).toContainText('Saves · 1')
    await expect(page.locator('.save-round-row').filter({ hasText: 'Last save' })).toContainText('Claude')

    // A second round in a region the first never touched, then the older row
    // expands read-only from its own snapshots — it excludes the newer round's
    // text and offers no actions.
    await scenario.atomicWrite(state.buffer!, '# Plan, revised\n\nOriginal text.\n\nAppendix.\n')
    await expect(page.locator('.change-row').filter({ hasText: 'Claude' })).toHaveCount(3)
    await save(page)
    await expect(page.locator('.save-history-heading')).toContainText('Saves · 2')
    await expect(page.locator('.save-round-row')).toHaveCount(2)

    await page.locator('.save-round-row').filter({ hasText: 'Saved ' }).click()
    const hunks = page.locator('.save-round-hunk')
    await expect(hunks.filter({ hasText: 'Plan, revised' }).first()).toBeVisible()
    await expect(hunks.filter({ hasText: 'Original text' })).toHaveCount(0)
    await expect(page.locator('.save-round-hunks .keep-button')).toHaveCount(0)
    await expect(page.locator('.save-round-hunks .revert-button')).toHaveCount(0)

    // The history survives a restart.
    await scenario.stop()
    const reopened = await scenario.launch()
    await expect(reopened.locator('.save-history-heading')).toContainText('Saves · 2')
    await expect(reopened.locator('.save-round-row')).toHaveCount(2)
    await expect(reopened.locator('.save-round-row').filter({ hasText: 'Last save' })).toContainText('Claude')
  } finally {
    await scenario.dispose()
  }
})
