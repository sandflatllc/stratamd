import { expect, test, type Page } from '@playwright/test'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Scenario } from './harness'

// Crash containment end to end (docs/plans/completed/crash-hardening-plan.md §9). The harness
// sets STRATAMD_CRASH_PROBE, so every boundary renders a hidden probe button
// that throws on the render after it is clicked. Probes overlap at a fixed
// corner, so clicks are dispatched rather than hit-tested.

interface LogLine {
  level: string
  scope: string
  message: string
  componentStack?: string
}

async function logLines(scenario: Scenario): Promise<LogLine[]> {
  const path = join(String(scenario.env.XDG_DATA_HOME), 'stratamd/logs/stratamd.log')
  const raw = await readFile(path, 'utf8').catch(() => '')
  return raw.trimEnd().split('\n').filter(Boolean).map((line) => JSON.parse(line) as LogLine)
}

async function crash(page: Page, region: string): Promise<void> {
  await page.getByRole('button', { name: `Crash probe: ${region}` }).dispatchEvent('click')
}

const DOC = '# Containment\n\nThe quick brown fox jumps over the lazy dog.\n\nA second paragraph holds the anchor text.\n'

test('a pane crash shows the pane card, leaves the rest working, logs once, and reloads intact', async ({}, testInfo) => {
  test.setTimeout(120_000)
  const scenario = await Scenario.create(testInfo, DOC, 'containment.md')
  try {
    const page = await scenario.launch()

    // A pending hunk before the crash: the card's promise covers review state.
    const attach = await scenario.attach('ag_crash', 'Prober')
    await scenario.tag('ag_crash', 'Prober')
    const buffer = await readFile(attach.buffer!, 'utf8')
    await writeFile(attach.buffer!, buffer.replace('lazy dog', 'patient dog'))
    await expect(page.locator('.changes-panel .change-row').first()).toBeVisible()

    await crash(page, 'editor')
    const card = page.locator('.boundary-card')
    await expect(card).toContainText('This part of the window hit a problem')

    // The other panes keep working: the rail's change row and the explorer's
    // file entry are both still there.
    await expect(page.locator('.changes-panel .change-row').first()).toBeVisible()
    await expect(page.getByText('containment.md', { exact: false }).first()).toBeVisible()

    // Exactly one boundary report for this crash (§3's single-owner rule).
    await expect.poll(async () => (await logLines(scenario)).filter((line) => line.scope === 'boundary:editor').length).toBe(1)
    const report = (await logLines(scenario)).find((line) => line.scope === 'boundary:editor')!
    expect(report.message).toContain('Crash probe: editor')
    expect(report.componentStack).toBeTruthy()

    await card.getByRole('button', { name: 'Reload' }).click()
    // The pending hunk renders as track changes, so the replacement word sits
    // beside its Keep/Revert widget rather than in continuous prose.
    await expect(page.getByRole('textbox', { name: /document editor/i })).toContainText('patient', { timeout: 15_000 })
    await expect(page.locator('.changes-panel .change-row').first()).toBeVisible()
  } finally {
    await scenario.dispose()
  }
})

test('a root crash right after typing keeps the newest keystrokes through reload', async ({}, testInfo) => {
  test.setTimeout(120_000)
  const scenario = await Scenario.create(testInfo, DOC, 'containment.md')
  try {
    const page = await scenario.launch()
    const editor = page.getByRole('textbox', { name: /document editor/i })
    await editor.click()
    await page.keyboard.press('End')
    await page.keyboard.type(' SURVIVES')
    // Crash before the 180 ms mirror debounce fires: only the module-scope
    // pending buffer and the root boundary's flush can save these keystrokes.
    await crash(page, 'window')
    const card = page.locator('.boundary-card')
    await expect(card).toContainText('StrataMD hit a problem showing this window')
    await expect.poll(async () => (await logLines(scenario)).filter((line) => line.scope === 'boundary:window').length).toBe(1)

    await card.getByRole('button', { name: 'Reload' }).click()
    await expect(editor).toContainText('SURVIVES', { timeout: 15_000 })
  } finally {
    await scenario.dispose()
  }
})

test('event-handler failures and detached rejections are logged without touching the UI', async ({}, testInfo) => {
  test.setTimeout(120_000)
  const scenario = await Scenario.create(testInfo, DOC, 'containment.md')
  try {
    const page = await scenario.launch()
    // Scheduled inside the page: a directly thrown evaluate error would be
    // captured by Playwright instead of reaching the browser-global handlers.
    await page.evaluate(() => {
      window.setTimeout(() => {
        throw new Error('net probe throw')
      }, 0)
      void Promise.reject(new Error('net probe rejection'))
    })
    await expect.poll(async () => {
      const lines = await logLines(scenario)
      return ['window', 'window:promise'].filter((scope) => lines.some((line) => line.scope === scope && line.message.includes('net probe'))).length
    }).toBe(2)
    await expect(page.locator('.boundary-card')).toHaveCount(0)
    await expect(page.getByRole('textbox', { name: /document editor/i })).toBeVisible()
  } finally {
    await scenario.dispose()
  }
})
