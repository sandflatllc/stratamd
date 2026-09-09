import { expect, test, type Page, type TestInfo } from './test'
import { primaryKey } from './harness'
import { openThread } from './cockpit-agent'
import { DEFAULT_PROVIDERS, seededScenario, startEngine, type FakeEngine } from './cockpit-engine-harness'

const providers = () => DEFAULT_PROVIDERS.map((value, index) => ({ ...value as object, slashCommands: index === 0 ? [{ name: 'compact', description: 'Compacts context immediately' }] : [], skills: [] }))
const at = '2026-09-03T12:02:00.000Z'
const command = (engine: FakeEngine) => engine.commands.filter(command => command.type === 'thread.turn.start').at(-1)!
const activity = (engine: FakeEngine, kind: string, payload: Record<string, unknown>, id: string) => engine.appendActivity({ id, kind, payload, summary: kind === 'context-compaction' ? 'Context compacted' : 'Context compaction failed', tone: kind === 'context-compaction' ? 'info' : 'error', turnId: null, createdAt: at })
async function capture(page: Page, testInfo: TestInfo, state: string) {
  await page.evaluate(() => { document.documentElement.dataset.typing = 'true' })
  await page.screenshot({ path: testInfo.outputPath(`compact-${state}.png`), animations: 'disabled', caret: 'hide' })
}
async function setup(testInfo: TestInfo) {
  const engine = await startEngine({ providers: providers(), pendingRequests: false, projectsParity: true })
  engine.complete(at)
  engine.setMessage('# Inspection page review\n\nThe main offer is clear. I’ll review the inspection flow and the supporting copy.\n\n## Keep the next step visible\n\nUse a direct call to action and explain what happens after the homeowner requests an inspection.')
  engine.appendActivity({ id: 'context-before', kind: 'context-window.updated', payload: { usedTokens: 176000, maxTokens: 200000 }, summary: 'Context window updated', tone: 'info', turnId: null, createdAt: at })
  const scenario = await seededScenario(testInfo, engine.origin)
  await scenario.writeSettings({ theme: 'strata-night' })
  const page = await scenario.launch()
  await page.clock.setFixedTime(new Date(at))
  await page.setViewportSize({ width: 1440, height: 1000 })
  await openThread(page, 'Live engine thread')
  await page.getByRole('button', { name: 'Open in center' }).click()
  await expect(page.locator('.conversation-panel[data-placement="center"]')).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Message conversation' })).toBeVisible()
  await page.getByRole('textbox', { name: 'Message conversation' }).fill('Keep this unsent draft.')
  return { engine, scenario, page }
}

test('compact command preserves draft, held work and transcript through working and reported completion', async ({}, testInfo) => {
  const { engine, scenario, page } = await setup(testInfo)
  try {
    await page.evaluate(() => window.strata.holdMessageComment('t1', { messageId: 'm1', from: 2, to: 12, kind: 'comment', text: 'Keep this held.' }))
    const before = await page.evaluate(async () => {
      const view = await window.strata.getState()
      const thread = view.engine.projects.flatMap(project => project.threads).find(thread => thread.id === 't1')!
      return { comments: thread.comments, documents: thread.documents, text: thread.messages.find(message => message.id === 'm1')!.text, document: view.activeDocument }
    })
    await page.getByRole('button', { name: /Context window: 88%/ }).click()
    await expect(page.getByRole('button', { name: 'Compact context', exact: true })).toBeEnabled()
    await capture(page, testInfo, 'ready')
    await page.getByRole('button', { name: 'Compact context', exact: true }).click()
    await page.keyboard.press('Escape')
    await expect(page.locator('.context-compaction-notice')).toContainText('Compacting context')
    await capture(page, testInfo, 'working')
    expect(command(engine).message).toMatchObject({ text: '/compact', attachments: [] })
    expect(engine.uploads).toHaveLength(0)
    const messageId = (command(engine).message as { messageId: string }).messageId
    activity(engine, 'context-compaction', { requestId: messageId, state: 'compacted', beforeTokens: 176000, afterTokens: 48000 }, 'compact-success')
    engine.appendActivity({ id: 'context-after', kind: 'context-window.updated', payload: { usedTokens: 48000, maxTokens: 200000 }, summary: 'Context window updated', tone: 'info', turnId: null, createdAt: at })
    engine.complete(at)
    await expect(page.locator('.context-compaction-notice')).toContainText('176,000 → 48,000 tokens')
    await capture(page, testInfo, 'done')
    await expect(page.getByRole('textbox', { name: 'Message conversation' })).toHaveValue('Keep this unsent draft.')
    const after = await page.evaluate(async () => {
      const view = await window.strata.getState()
      const thread = view.engine.projects.flatMap(project => project.threads).find(thread => thread.id === 't1')!
      return { comments: thread.comments, documents: thread.documents, text: thread.messages.find(message => message.id === 'm1')!.text, document: view.activeDocument }
    })
    expect(after).toEqual(before)

    // The native top-layer popup must retain the conversation pane's text zoom.
    await page.getByRole('button', { name: /Context window: 24%/ }).click()
    const popup = page.getByRole('dialog', { name: 'Context actions' })
    const heading = popup.locator('h3')
    const description = popup.locator('p').first()
    const action = popup.getByRole('button', { name: 'Compact context', exact: true })
    const notice = page.locator('.context-compaction-notice')
    await expect(heading).toHaveCSS('font-size', '14px')
    await expect(notice).toHaveCSS('font-size', '13px')
    await heading.hover()
    await page.keyboard.press(primaryKey('Equal'))
    await expect(popup).toHaveCSS('font-size', '14.3px')
    await expect(heading).toHaveCSS('font-size', '15.4px')
    await expect(description).toHaveCSS('font-size', '13.2px')
    await expect(action).toHaveCSS('font-size', '13.2px')
    await expect(notice).toHaveCSS('font-size', '14.3px')
    await capture(page, testInfo, 'zoomed')
    await page.keyboard.press(primaryKey('Minus'))
    await expect(heading).toHaveCSS('font-size', '14px')
    await expect(notice).toHaveCSS('font-size', '13px')
  } finally { await scenario.dispose(); await engine.close() }
})

test('compact failure is actionable, retry awaits real completion, and unsupported workspace refuses dispatch', async ({}, testInfo) => {
  const { engine, scenario, page } = await setup(testInfo)
  try {
    await page.getByRole('button', { name: /Context window: 88%/ }).click()
    await page.getByRole('button', { name: 'Compact context', exact: true }).click()
    await page.keyboard.press('Escape')
    await expect(page.locator('.context-compaction-notice')).toContainText('Compacting context')
    activity(engine, 'provider.turn.start.failed', { requestId: (command(engine).message as { messageId: string }).messageId, detail: 'Provider session expired. Sign in to this account and retry.' }, 'compact-failure')
    engine.complete(at)
    await expect(page.getByRole('button', { name: 'Retry compaction' })).toBeEnabled()
    await capture(page, testInfo, 'failed')
    await page.getByRole('button', { name: 'Retry compaction' }).click()
    await expect(page.locator('.context-compaction-notice')).toContainText('Compacting context')
    activity(engine, 'context-compaction', { requestId: (command(engine).message as { messageId: string }).messageId, state: 'compacted' }, 'compact-no-counts')
    engine.complete(at)
    await expect(page.locator('.context-compaction-notice')).toHaveText('Context compacted. Conversation history is still available.')
    const state = await page.evaluate(() => window.strata.getState())
    const cwd = state.engine.projects[0]!.workspaceRoot
    engine.setProviders(providers().map((provider, index) => ({ ...provider, workspaceSnapshots: index === 0 ? [{ cwd, checkedAt: at, slashCommands: [], skills: [] }] : [] })))
    await page.evaluate(() => window.strata.refreshAccounts())
    await page.getByRole('button', { name: /Context window: 88%/ }).click()
    await expect(page.getByRole('button', { name: 'Compact context', exact: true })).toBeDisabled()
    await expect(page.getByText('This agent does not support manual compaction in this workspace.')).toBeVisible()
    await capture(page, testInfo, 'unsupported')
    const count = engine.commands.length
    const error = await page.evaluate(async () => {
      try { await window.strata.compactContext('t1', { model: 'gpt-5.6', instanceId: 'codex', effort: 'medium', access: 'full-access' }); return null }
      catch (failure) { return String(failure) }
    })
    expect(error).toContain('does not report manual compaction')
    expect(engine.commands).toHaveLength(count)
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Move to side' }).click()
    await expect(page.locator('.conversation-panel[data-placement="side"]')).toBeVisible()
    await page.getByRole('button', { name: /Context window: 88%/ }).click()
    const popup = page.getByRole('dialog', { name: 'Context actions' })
    await expect(popup).toBeVisible()
    expect(await popup.evaluate(element => element.matches(':popover-open'))).toBe(true)
    const bounds = (await popup.boundingBox())!
    expect(bounds.x).toBeGreaterThanOrEqual(0)
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(1440)
    await expect(page.getByRole('textbox', { name: 'Message conversation' })).toHaveValue('Keep this unsent draft.')
  } finally { await scenario.dispose(); await engine.close() }
})
