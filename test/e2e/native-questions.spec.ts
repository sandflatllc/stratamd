import type { Page } from './test'
import { expect, test } from './test'
import { seededScenario, startEngine } from './cockpit-engine-harness'

async function capture(page: Page, path: string) {
  await page.clock.setFixedTime(new Date('2026-09-03T12:02:00Z'))
  await page.evaluate(async () => {
    document.documentElement.dataset.typing = 'true'
    await document.fonts.ready
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  })
  await page.screenshot({ path, animations: 'disabled', caret: 'hide' })
}

for (const mode of ['message', 'blocking'] as const) test(`native ${mode} question drafts survive close and reload; Hold stays private until Send`, async ({}, testInfo) => {
  const engine = await startEngine(mode === 'message' ? { userInputResponseMode: 'message' } : {})
  const scenario = await seededScenario(testInfo, engine.origin)
  try {
    await scenario.writeSettings({ theme: 'strata-night' })
    const page = await scenario.launch()
    await scenario.app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1440, 1000))
    await page.getByRole('tab', { name: 'Projects', exact: true }).click()
    await page.getByRole('button', { name: /^Open Live engine thread$/ }).click()
    await page.getByRole('button', { name: 'Open in center' }).click()
    await page.getByRole('button', { name: 'Answer question', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Answer question' })
    await expect(dialog).toContainText(mode === 'message' ? 'can keep working' : 'is waiting')
    await expect(dialog.getByRole('button', { name: 'Dismiss', exact: true })).toHaveCount(mode === 'message' ? 1 : 0)
    await dialog.getByRole('button', { name: 'Version one' }).click()
    await capture(page, testInfo.outputPath(`questions-${mode === 'message' ? 'asking' : 'blocking'}.png`))
    await dialog.getByRole('textbox', { name: 'Answer release' }).fill('Version two')
    await dialog.getByRole('button', { name: 'Close dialog' }).click()
    expect(engine.commands).toEqual([])
    await page.reload()
    await page.getByRole('button', { name: 'Answer question', exact: true }).click()
    await expect(dialog.getByRole('textbox', { name: 'Answer release' })).toHaveValue('Version two')
    await dialog.getByRole('textbox', { name: 'Answer release' }).press('Enter')
    await expect(dialog).toHaveCount(0)
    const composer = page.getByRole('textbox', { name: 'Message conversation' })
    await expect(composer).toBeFocused()
    expect(engine.commands).toEqual([])
    await page.reload()
    await expect(page.getByText('Answer held · Version two', { exact: true })).toBeVisible()
    await capture(page, testInfo.outputPath(`questions-held-${mode}.png`))
    if (mode === 'message') await page.getByRole('button', { name: 'Send', exact: true }).click()
    else await composer.press('Enter')
    await expect.poll(() => engine.commands.filter(command => command.type === 'thread.user-input.respond')).toHaveLength(1)
    expect(engine.commands).toEqual([expect.objectContaining({ type: 'thread.user-input.respond', threadId: 't1', requestId: 'input-1', answers: { release: 'Version two' } })])
    await expect(page.getByText('Answer sent · Version two', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Edit answer', exact: true })).toHaveCount(0)
    await capture(page, testInfo.outputPath(`questions-sent-${mode}.png`))
  } finally { await scenario.dispose(); await engine.close() }
})

test('native async dismissal survives reconnect and sends no answer, message or turn', async ({}, testInfo) => {
  const engine = await startEngine({ userInputResponseMode: 'message' })
  const scenario = await seededScenario(testInfo, engine.origin)
  try {
    await scenario.writeSettings({ theme: 'strata-night' })
    const page = await scenario.launch()
    await scenario.app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1440, 1000))
    await page.getByRole('tab', { name: 'Projects', exact: true }).click()
    await page.getByRole('button', { name: /^Open Live engine thread$/ }).click()
    await page.getByRole('button', { name: 'Open in center' }).click()
    await page.getByRole('button', { name: 'Answer question', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Answer question' })
    await dialog.getByRole('textbox', { name: 'Answer release' }).fill('Private answer')
    await dialog.getByRole('button', { name: 'Hold answer', exact: true }).click()
    engine.setOnline(false)
    await expect(page.getByTestId('conversation-disconnected')).toBeVisible()
    engine.setOnline(true)
    await expect(page.getByTestId('conversation-disconnected')).toHaveCount(0)
    await page.getByRole('button', { name: 'Edit answer', exact: true }).click()
    await expect(dialog.getByRole('textbox', { name: 'Answer release' })).toHaveValue('Private answer')
    await dialog.getByRole('button', { name: 'Dismiss', exact: true }).click()
    await expect(page.getByText('Question dismissed', { exact: true })).toBeVisible()
    expect(engine.commands).toEqual([{ type: 'thread.user-input.dismiss', commandId: expect.any(String), threadId: 't1', requestId: 'input-1', createdAt: expect.any(String) }])
    await page.reload()
    await expect(page.getByText('Question dismissed', { exact: true })).toBeVisible()
    await expect(page.getByText('Answer held · Private answer', { exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Answer question', exact: true })).toHaveCount(0)
    await capture(page, testInfo.outputPath('questions-dismissed.png'))
  } finally { await scenario.dispose(); await engine.close() }
})

for (const action of ['respond', 'dismiss'] as const) test(`failed native ${action} preserves the private answer for retry`, async ({}, testInfo) => {
  const engine = await startEngine({ userInputResponseMode: 'message', rejectFirstUserInput: action })
  const scenario = await seededScenario(testInfo, engine.origin)
  try {
    await scenario.writeSettings({ theme: 'strata-night' })
    const page = await scenario.launch()
    await scenario.app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1440, 1000))
    await page.getByRole('tab', { name: 'Projects', exact: true }).click()
    await page.getByRole('button', { name: /^Open Live engine thread$/ }).click()
    await page.getByRole('button', { name: 'Answer question', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Answer question' })
    await dialog.getByRole('textbox', { name: 'Answer release' }).fill('Private retry')
    const submit = action === 'dismiss' ? dialog.getByRole('button', { name: 'Dismiss', exact: true }) : page.getByRole('textbox', { name: 'Message conversation' })
    if (action === 'respond') await dialog.getByRole('button', { name: 'Hold answer', exact: true }).click()
    if (action === 'dismiss') await submit.click(); else await submit.press('Enter')
    await expect(page.getByRole('alert').filter({ hasText: 'The engine refused the command (400)' })).toBeVisible()
    expect(engine.commands).toEqual([])
    if (action === 'dismiss') await expect(dialog.getByRole('textbox', { name: 'Answer release' })).toHaveValue('Private retry')
    else await expect(page.getByText('Answer held · Private retry', { exact: true })).toBeVisible()
    await capture(page, testInfo.outputPath(`questions-${action}-error.png`))
    if (action === 'dismiss') await submit.click(); else await submit.press('Enter')
    await expect.poll(() => engine.commands).toEqual([expect.objectContaining({ type: `thread.user-input.${action}`, requestId: 'input-1', ...(action === 'respond' ? { answers: { release: 'Private retry' } } : {}) })])
  } finally { await scenario.dispose(); await engine.close() }
})

test('multi-select preserves provider values across Hold and sends an array', async ({}, testInfo) => {
  const engine = await startEngine({ userInputResponseMode: 'message', userInputQuestions: [{ id: 'choice', question: 'Choose checks', multiSelect: true, allowCustomAnswer: false, options: [{ label: 'First check', value: 'first' }, { label: 'Second check', value: 'second' }] }] })
  const scenario = await seededScenario(testInfo, engine.origin)
  try {
    const page = await scenario.launch()
    await page.getByRole('tab', { name: 'Projects', exact: true }).click()
    await page.getByRole('button', { name: 'Open Live engine thread', exact: true }).click()
    await page.getByRole('button', { name: 'Answer question', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Answer question' })
    await dialog.getByRole('button', { name: 'First check', exact: true }).click()
    await dialog.getByRole('button', { name: 'Second check', exact: true }).click()
    await expect(dialog.getByRole('button', { name: 'First check', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await dialog.getByRole('button', { name: 'Hold answer' }).click()
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect.poll(() => engine.commands.filter(command => command.type === 'thread.user-input.respond')).toEqual([expect.objectContaining({ answers: { choice: ['first', 'second'] } })])
  } finally { await scenario.dispose(); await engine.close() }
})
