import { expect, test, type Page, type TestInfo } from './test'
import { openThread } from './cockpit-agent'
import { seededScenario, startEngine } from './cockpit-engine-harness'
async function capture(page: Page, testInfo: TestInfo, state: string) {
  await page.evaluate(async () => { document.documentElement.dataset.typing = 'true'; await document.fonts.ready })
  await page.screenshot({ path: testInfo.outputPath(`recovery-${state}.png`), animations: 'disabled', caret: 'hide' })
}
async function setup(testInfo: TestInfo) {
  const engine = await startEngine({ settings: { continueThreadsAfterServerUpdate: false } })
  const scenario = await seededScenario(testInfo, engine.origin)
  await scenario.writeSettings({ theme: 'strata-night' })
  const page = await scenario.launch()
  await scenario.app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1440, 1000))
  await openThread(page, 'Live engine thread')
  await page.getByRole('button', { name: 'Open in center' }).click()
  await page.getByRole('textbox', { name: 'Message conversation' }).fill('Keep this unsent draft.')
  return { engine, scenario, page }
}
test('restart preference defaults off and persists through the existing engine settings API', async ({}, testInfo) => {
  const { engine, scenario, page } = await setup(testInfo)
  try {
    await page.getByRole('button', { name: 'Engine status' }).click()
    const checkbox = page.getByRole('checkbox', { name: 'Continue interrupted work after restart' })
    await expect(checkbox).not.toBeChecked()
    await capture(page, testInfo, 'setting')
    await checkbox.check()
    await expect.poll(() => engine.rpcRequests.filter(request => request.tag === 'server.updateSettings').map(request => request.payload)).toContainEqual({ patch: { continueThreadsAfterServerUpdate: true } })
    await page.getByRole('button', { name: 'Close', exact: true }).click()
    await page.getByRole('button', { name: 'Engine status' }).click()
    await expect(checkbox).toBeChecked()
  } finally { await scenario.dispose(); await engine.close() }
})
test('reconnect retains transcript, draft and held native answer without sending again', async ({}, testInfo) => {
  const { engine, scenario, page } = await setup(testInfo)
  try {
    await page.getByRole('button', { name: 'Answer question', exact: true }).click()
    const answer = page.getByRole('dialog', { name: 'Answer question' })
    await answer.getByRole('textbox', { name: 'Answer release' }).fill('Keep this held answer.')
    await answer.getByRole('button', { name: 'Hold answer', exact: true }).click()
    engine.setOnline(false)
    await expect(page.getByTestId('conversation-disconnected')).toBeVisible()
    await expect(page.getByRole('textbox', { name: 'Message conversation' })).toHaveValue('Keep this unsent draft.')
    await expect(page.locator('.conversation-messages')).toContainText('Read-side conversation from T3.')
    await capture(page, testInfo, 'reconnecting')
    engine.setOnline(true)
    await page.getByTestId('conversation-disconnected').getByRole('button', { name: 'Reconnect' }).click()
    await expect(page.locator('.thread-recovery-notice')).toContainText('confirmed the original turn')
    await capture(page, testInfo, 'resumed')
    await page.getByRole('button', { name: 'Edit answer', exact: true }).click()
    await expect(answer.getByRole('textbox', { name: 'Answer release' })).toHaveValue('Keep this held answer.')
    expect(engine.commands).toHaveLength(0)
  } finally { await scenario.dispose(); await engine.close() }
})
test('failed recovery offers an explicit new message without consuming the draft or held answer', async ({}, testInfo) => {
  const { engine, scenario, page } = await setup(testInfo)
  try {
    await page.getByRole('button', { name: 'Answer question', exact: true }).click()
    const answer = page.getByRole('dialog', { name: 'Answer question' })
    await answer.getByRole('textbox', { name: 'Answer release' }).fill('Do not send this answer.')
    await answer.getByRole('button', { name: 'Hold answer', exact: true }).click()
    engine.setOnline(false)
    await expect(page.getByTestId('conversation-disconnected')).toBeVisible()
    engine.finish(); engine.setOnline(true)
    await page.getByTestId('conversation-disconnected').getByRole('button', { name: 'Reconnect' }).click()
    await expect(page.locator('.thread-recovery-notice')).toHaveAttribute('data-state', 'failed')
    await capture(page, testInfo, 'failed')
    await page.getByRole('button', { name: 'Continue with a message', exact: true }).click()
    await expect(page.locator('.thread-recovery-notice')).toContainText('Strata sent a new continuation message')
    await expect(page.getByRole('textbox', { name: 'Message conversation' })).toHaveValue('Keep this unsent draft.')
    await capture(page, testInfo, 'continued')
    expect(engine.commands).toHaveLength(1)
    expect(engine.commands[0]).toMatchObject({ type: 'thread.turn.start', message: { text: 'Continue where you left off.', attachments: [] } })
    await page.evaluate(() => window.strata.continueInterruptedThread('t1'))
    expect(engine.commands).toHaveLength(1)
    await page.getByRole('button', { name: 'Edit answer', exact: true }).click()
    await expect(answer.getByRole('textbox', { name: 'Answer release' })).toHaveValue('Do not send this answer.')
  } finally { await scenario.dispose(); await engine.close() }
})
