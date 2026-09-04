import { expect, test } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { seededScenario, startEngine } from './cockpit-engine-harness'
import { modelSelectorProviders } from './model-selector-fixture'

for (const family of ['GPT', 'Claude'] as const) {
  test(`${family}: family, subscription, flagship, and ongoing conversation restrictions`, async ({}, testInfo) => {
    const providers = modelSelectorProviders()
    const engine = await startEngine({ providers })
    const scenario = await seededScenario(testInfo, engine.origin)
    const captures = process.env.STRATAMD_SELECTOR_CAPTURES ?? testInfo.outputPath('selector')
    try {
      const page = await scenario.launch()
      await scenario.app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1500, 1000))
      await page.getByRole('tab', { name: 'Projects', exact: true }).click()
      await page.getByRole('button', { name: 'New thread in Cockpit project' }).click()
      await page.getByRole('button', { name: 'Choose model and account' }).click()
      const picker = page.getByRole('region', { name: 'Models and accounts' })
      await picker.getByRole('button', { name: family, exact: true }).click()
      const subscription = family === 'GPT' ? 'codex' : 'claude-main'
      await picker.getByLabel('Subscription', { exact: true }).selectOption(subscription)
      await expect(picker.getByLabel('Subscription', { exact: true }).locator('option')).toHaveCount(2)
      const flagship = family === 'GPT' ? 'GPT-6-Astra' : 'Claude Fable 5.1'
      const other = family === 'GPT' ? 'GPT-5.6-Sol' : 'Claude Sonnet 5'
      await expect(picker.getByRole('button', { name: `Use ${flagship}` })).toBeVisible()
      await expect(picker.getByRole('button', { name: other, exact: true })).toBeHidden()
      await mkdir(captures, { recursive: true })
      await page.screenshot({ path: `${captures}/${family}-draft.png` })
      await picker.getByRole('button', { name: `Use ${flagship}` }).click()
      await page.getByLabel('Message conversation').fill(`Start ${family} work.`)
      await page.getByLabel('Message conversation').press('Enter')
      await expect(page.locator('.conversation-panel[data-placement="center"] .conversation-message.user')).toContainText(`Start ${family} work.`)
      const created = engine.commands.find(command => command.type === 'thread.create')!
      await page.getByRole('button', { name: 'Choose model and account' }).click()
      await expect(picker.getByRole('button', { name: 'GPT', exact: true })).toHaveCount(0)
      await expect(picker.getByRole('button', { name: 'Claude', exact: true })).toHaveCount(0)
      if (family === 'GPT') {
        await expect(picker).not.toContainText('Claude')
        await picker.getByLabel('Subscription', { exact: true }).selectOption('gpt-personal')
        await expect(picker.getByRole('button', { name: `Use ${flagship}` })).toHaveAttribute('aria-pressed', 'true')
      } else {
        await expect(picker.getByLabel('Subscription', { exact: true })).toHaveCount(0)
        await expect(picker).toContainText('Claude Work')
        await expect(picker).not.toContainText('Claude Personal')
        await expect(picker).not.toContainText('GPT')
      }
      await page.screenshot({ path: `${captures}/${family}-ongoing.png` })
      await picker.locator('summary').click()
      await expect(picker.getByRole('button', { name: other, exact: true })).toBeVisible()
      await page.screenshot({ path: `${captures}/${family}-other-models.png` })
      await picker.getByRole('button', { name: other, exact: true }).click()
      await page.getByLabel('Message conversation').fill(`Continue with ${other}.`)
      await page.getByLabel('Message conversation').press('Enter')
      await expect.poll(() => engine.commands.filter(command => command.type === 'thread.turn.start').length).toBe(2)
      expect(engine.commands.filter(command => command.type === 'thread.turn.start').at(-1)).toMatchObject({ threadId: created.threadId, modelSelection: { instanceId: family === 'GPT' ? 'gpt-personal' : 'claude-main', model: family === 'GPT' ? 'gpt-5.6-sol' : 'claude-sonnet-5' } })
      // Direct calls must be refused before an attachment is uploaded or a command is sent.
      for (const target of family === 'GPT' ? [{ instanceId: 'claude-main', model: 'claude-fable-5-1' }] : [{ instanceId: 'claude-personal', model: 'claude-fable-5-1' }, { instanceId: 'codex', model: 'gpt-6-astra' }]) {
        const uploads = engine.uploads.length
        const error = await page.evaluate(async ({ id, target }) => {
          try { await window.strata.startConversationTurn(id, { ...target, text: 'Invalid switch', effort: null, access: 'full-access', attachment: { name: 'private.txt', text: 'Must not upload.' } }); return '' } catch (error) { return String(error) }
        }, { id: String(created.threadId), target })
        expect(error).toContain(family === 'GPT' ? 'only supports GPT' : 'stays on subscription')
        expect(engine.uploads).toHaveLength(uploads)
        expect(engine.commands.filter(command => command.type === 'thread.turn.start')).toHaveLength(2)
      }
      if (family === 'Claude') {
        engine.setProviders(providers.map(provider => provider.instanceId === 'claude-main' ? { ...provider, enabled: false } : provider))
        await page.evaluate(() => window.strata.refreshAccounts())
        await expect(page.getByRole('alert')).toContainText('cannot take a turn')
        await page.getByRole('button', { name: 'Choose model and account' }).click()
        await expect(picker).not.toContainText('Claude Personal')
        await expect(picker.getByRole('button', { name: `Use ${flagship}` })).toBeDisabled()
        await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled()
        await page.screenshot({ path: `${captures}/Claude-unavailable.png` })
      }
    } finally { await scenario.dispose(); await engine.close() }
  })
}

test('a stale cross-family draft keeps its text but cannot change an existing GPT conversation', async ({}, testInfo) => {
  const engine = await startEngine({ providers: modelSelectorProviders() })
  const scenario = await seededScenario(testInfo, engine.origin)
  try {
    const page = await scenario.launch()
    await page.evaluate(() => localStorage.setItem('stratamd.conversation-draft.v1:thread:t1', JSON.stringify({ text: 'Keep this draft.', selection: { model: 'claude-fable-5-1', instanceId: 'claude-personal', effort: null, access: 'full-access' } })))
    await page.reload()
    await page.getByRole('tab', { name: 'Projects', exact: true }).click()
    await page.getByRole('button', { name: 'Open Live engine thread', exact: true }).click()
    await expect(page.getByLabel('Message conversation')).toHaveValue('Keep this draft.')
    await page.getByRole('button', { name: 'Choose model and account' }).click()
    const picker = page.getByRole('region', { name: 'Models and accounts' })
    await expect(picker).not.toContainText('Claude')
    await scenario.app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1000, 760))
    const bounds = await picker.boundingBox()
    expect(bounds!.x).toBeGreaterThanOrEqual(0)
    expect(bounds!.y).toBeGreaterThanOrEqual(0)
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(1000)
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(760)
    if (process.env.STRATAMD_SELECTOR_CAPTURES) await page.screenshot({ path: `${process.env.STRATAMD_SELECTOR_CAPTURES}/narrow.png` })
    await picker.getByRole('button', { name: 'Use GPT-6-Astra' }).click()
    await page.getByLabel('Message conversation').press('Enter')
    await expect.poll(() => engine.commands.filter(command => command.type === 'thread.turn.start').length).toBe(1)
    expect(engine.commands.find(command => command.type === 'thread.turn.start')).toMatchObject({ threadId: 't1', modelSelection: { instanceId: 'codex', model: 'gpt-6-astra' }, message: { text: 'Keep this draft.' } })
  } finally { await scenario.dispose(); await engine.close() }
})
