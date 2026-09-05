import { expect, test, type Locator, type Page } from '@playwright/test'
import { seededScenario, startEngine } from './cockpit-engine-harness'

async function openLiveThread(page: Page, placement: 'side' | 'center'): Promise<Locator> {
  await page.getByRole('tablist', { name: 'Document navigation' }).getByRole('tab', { name: 'Projects' }).click()
  await page.getByRole('button', { name: /^Open Live engine thread$/ }).click()
  if (placement === 'center') await page.getByRole('button', { name: 'Open in center' }).click()
  return page.locator(`.conversation-panel[data-placement="${placement}"]`)
}

/** The turn section holding a given message. */
function turnOf(panel: Locator, messageId: string): Locator {
  return panel.locator('.conversation-turn').filter({ has: panel.page().locator(`[data-message-id="${messageId}"]`) })
}

/** Message ids and row kinds in transcript order inside one turn. */
function rowOrder(turn: Locator) {
  return turn.locator('[data-history-row]').evaluateAll((rows) => rows.map((row) => (row as HTMLElement).dataset.messageId ?? row.className.split(' ')[0]))
}

for (const placement of ['side', 'center'] as const) test(`a completed turn folds to the owner's message, one disclosure, the answer, and its files in ${placement}`, async ({}, testInfo) => {
  const engine = await startEngine({ conversationParity: true })
  engine.complete()
  const scenario = await seededScenario(testInfo, engine.origin)
  try {
    const page = await scenario.launch()
    await page.setViewportSize({ width: 1440, height: 1000 })
    const panel = await openLiveThread(page, placement)
    // The live turn completed before the app opened: request, Worked for, answer, changed files, nothing else.
    const latest = turnOf(panel, 'm1')
    await expect(latest.locator('[data-message-id="live-user"]')).toContainText('Run the build.')
    await expect(latest.locator('.conversation-turn-toggle')).toHaveCount(1)
    await expect(latest.locator('.conversation-turn-toggle')).toHaveText(/^Worked for [\d.]+(ms|s|m)/)
    await expect(latest.locator('.conversation-turn-toggle')).toHaveAttribute('aria-expanded', 'false')
    await expect(latest.locator('[data-message-id="m1"]')).toContainText('Read-side conversation from T3.')
    await expect(latest.getByRole('region', { name: 'Changed files' })).toContainText('2 changed files')
    await expect(latest.locator('.conversation-working-row')).toHaveCount(0)
    await expect(latest.locator('.conversation-work-entry')).toHaveCount(0)
    await expect(panel.locator('.conversation-turn-toggle')).toHaveCount(3)

    // An older turn with progress prose and a search: the fold hides both, in place of the first hidden row.
    const older = turnOf(panel, 'old-agent-2')
    const toggle = older.locator('.conversation-turn-toggle')
    await expect(toggle).toHaveText(/^Worked for 4\.0s/)
    await expect(older.locator('[data-message-id="old-agent-2-progress"]')).toHaveCount(0)
    expect(await rowOrder(older)).toEqual(['old-user-2', 'conversation-turn-fold', 'old-agent-2'])
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await expect(older.locator('[data-message-id="old-agent-2-progress"]')).toContainText('Checking the grouping order first.')
    expect(await rowOrder(older)).toEqual(['old-user-2', 'conversation-turn-fold', 'old-agent-2-progress', 'conversation-work-group', 'old-agent-2'])
    await expect(older.locator('.conversation-turn-toggle')).toHaveCount(1)
    const search = older.locator('.conversation-work-toggle')
    await expect(search).toHaveText(/Searched the web 1 time/)
    await expect(search).toHaveAttribute('aria-expanded', 'false')
    await search.click()
    const entry = older.locator('.conversation-work-entry')
    await expect(entry).toContainText('Searched web')
    await expect(entry).toContainText('T3 timeline rules')
    await expect(entry.locator('pre')).toHaveCount(0)
    await entry.getByRole('button').click()
    await expect(entry.locator('pre')).toContainText('T3 timeline rules')
    await page.mouse.move(1300, 60)
    await page.screenshot({ animations: 'disabled', path: testInfo.outputPath(`${placement}-open-turn.png`) })
    await toggle.click()
    await expect(older.locator('[data-message-id="old-agent-2-progress"]')).toHaveCount(0)
    await expect(older.locator('[data-message-id="old-agent-2"]')).toContainText('Second finished answer also stays visible.')
    await page.screenshot({ animations: 'disabled', path: testInfo.outputPath(`${placement}-folded.png`) })
  } finally { await scenario.dispose(); await engine.close() }
})

test('a running turn stays open and folds once it completes', async ({}, testInfo) => {
  const engine = await startEngine({ conversationParity: true })
  const scenario = await seededScenario(testInfo, engine.origin)
  try {
    const page = await scenario.launch()
    const panel = await openLiveThread(page, 'side')
    const live = turnOf(panel, 'm1')
    await expect(live.locator('.conversation-working-row')).toContainText('Working')
    await expect(live.locator('.conversation-work-entry').filter({ hasText: 'Running electron-vite' })).toBeVisible()
    await expect(live.locator('.conversation-turn-toggle')).toHaveCount(0)
    await expect(panel.locator('.conversation-turn-toggle')).toHaveCount(2)
    engine.complete()
    const toggle = live.locator('.conversation-turn-toggle')
    await expect(toggle).toHaveText(/^Worked for [\d.]+(ms|s|m)/)
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(live.locator('.conversation-working-row')).toHaveCount(0)
    await expect(live.locator('.conversation-work-entry')).toHaveCount(0)
    await expect(live.locator('[data-message-id="m1"]')).toBeVisible()
    await toggle.click()
    // The call that never reported completion reads as finished once the turn has.
    await expect(live.locator('.conversation-work-toggle')).toHaveText(/Ran 1 command/)
    await live.locator('.conversation-work-toggle').click()
    await expect(live.locator('.conversation-work-entry').filter({ hasText: 'Ran electron-vite' })).toBeVisible()
  } finally { await scenario.dispose(); await engine.close() }
})

test('a turn the owner stops stays open with You stopped after, and folds on reload', async ({}, testInfo) => {
  const engine = await startEngine({ conversationParity: true })
  const scenario = await seededScenario(testInfo, engine.origin)
  try {
    let page = await scenario.launch()
    let panel = await openLiveThread(page, 'side')
    let live = turnOf(panel, 'm1')
    await expect(live.locator('.conversation-working-row')).toContainText('Working')
    await panel.getByRole('button', { name: 'Stop' }).click()
    await expect.poll(() => engine.commands.some((command) => command.type === 'thread.turn.interrupt')).toBe(true)
    let toggle = live.locator('.conversation-turn-toggle')
    await expect(toggle).toHaveText(/^You stopped after [\d.]+(ms|s|m)/)
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await expect(live.locator('.conversation-working-row')).toHaveCount(0)
    await expect(live.locator('.conversation-work-toggle')).toBeVisible()
    await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('stopped-open.png') })
    // A reload folds the stopped turn like any other settled turn.
    await scenario.stop()
    page = await scenario.launch()
    panel = await openLiveThread(page, 'side')
    live = turnOf(panel, 'm1')
    toggle = live.locator('.conversation-turn-toggle')
    await expect(toggle).toHaveText(/^You stopped after [\d.]+(ms|s|m)/)
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(live.locator('.conversation-work-toggle')).toHaveCount(0)
  } finally { await scenario.dispose(); await engine.close() }
})

test('Find and a comment marker open the folded turn that holds their target', async ({}, testInfo) => {
  const engine = await startEngine({ conversationParity: true })
  engine.complete()
  const scenario = await seededScenario(testInfo, engine.origin)
  try {
    const page = await scenario.launch()
    await page.setViewportSize({ width: 1440, height: 1000 })
    const panel = await openLiveThread(page, 'center')
    const older = turnOf(panel, 'old-agent-2')
    const first = turnOf(panel, 'old-agent-1')
    const toggle = older.locator('.conversation-turn-toggle')
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await panel.getByRole('searchbox', { name: 'Find in conversation' }).fill('grouping order first')
    await panel.getByRole('button', { name: 'Next', exact: true }).click()
    const progress = older.locator('[data-message-id="old-agent-2-progress"]')
    await expect(progress).toBeInViewport()
    await expect(progress.locator('.strata-prosemirror')).toBeVisible()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    // Only the target's turn opens.
    await expect(first.locator('.conversation-turn-toggle')).toHaveAttribute('aria-expanded', 'false')
    await panel.getByRole('searchbox', { name: 'Find in conversation' }).fill('')

    const commentId = await page.evaluate(async () => {
      const thread = (await window.strata.getState()).engine.projects.flatMap((project) => project.threads).find((candidate) => candidate.id === 't1')!
      const message = thread.messages.find((candidate) => candidate.id === 'old-agent-2-progress')!
      const source = message.prose ?? message.text
      const from = source.indexOf('grouping order')
      return window.strata.holdMessageComment('t1', { messageId: 'old-agent-2-progress', from, to: from + 'grouping order'.length, kind: 'comment', text: 'Why the order first?' })
    })
    // The owner's own fold wins over the reveal until the next navigation.
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(progress).toHaveCount(0)
    const marker = panel.getByRole('navigation', { name: 'Conversation history' }).locator(`[data-marker-id="${commentId}"]`)
    await expect(marker).toBeVisible()
    await marker.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await expect(progress.locator(`[data-draft-id="${commentId}"], [data-annotation-id="${commentId}"]`).first()).toBeInViewport()
    await expect(page.getByRole('region', { name: 'Saved comment' })).toContainText('Why the order first?')
    await page.mouse.move(1300, 60)
    await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('marker-reveal.png') })
  } finally { await scenario.dispose(); await engine.close() }
})
