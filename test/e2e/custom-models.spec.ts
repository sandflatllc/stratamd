import type { Page } from './test'
import { mkdir } from 'node:fs/promises'
import { expect, test } from './test'
import { DEFAULT_PROVIDERS, seededScenario, startEngine } from './cockpit-engine-harness'
import { openAppMenu } from './harness'

const descriptors = [
  { id: 'effort', label: 'Reasoning effort', type: 'select', description: 'Reported as supported by this provider.', currentValue: 'high', promptInjectedValues: ['high'], options: [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High', isDefault: true }] },
  { id: 'fastMode', label: 'Fast mode', type: 'boolean', currentValue: false },
]
const entry = { slug: 'gpt-5.6', name: 'Inspection reviewer', futureModel: { keep: 42 }, capabilities: { futureCapability: 'keep', optionDescriptors: [...descriptors, { id: 'futureOption', type: 'future', payload: ['keep'] }] } }
const provider = { driver: 'codex', displayName: 'Codex work', enabled: true, config: { futureConfig: 'keep', customModels: ['legacy-model', entry] } }
const providers = () => DEFAULT_PROVIDERS.map((provider, index) => index ? provider : { ...provider as object, models: [{ slug: entry.slug, name: entry.name, isDefault: true, capabilities: { optionDescriptors: descriptors } }] })

async function sizeModelDialog(page: Page) {
  const dialog = page.getByRole('dialog', { name: 'Codex work', exact: true })
  const bounds = (await dialog.boundingBox())!
  const grip = (await page.getByRole('button', { name: 'Resize Codex work', exact: true }).boundingBox())!
  const x = grip.x + grip.width / 2, y = grip.y + grip.height / 2
  await page.mouse.move(x, y); await page.mouse.down()
  await page.mouse.move(x + (960 - bounds.width) / 2, y + (760 - bounds.height) / 2)
  await page.mouse.up()
  await expect.poll(async () => Math.round((await dialog.boundingBox())!.width)).toBe(960)
  await expect.poll(async () => Math.round((await dialog.boundingBox())!.height)).toBe(760)
}

test('custom model details and defaults preserve legacy and unknown settings through real reads, edits, and turn dispatch', async ({}, testInfo) => {
  const engine = await startEngine({ providers: providers(), settings: { providerInstances: { codex: provider } } })
  const scenario = await seededScenario(testInfo, engine.origin)
  const captures = process.env.STRATAMD_MODELS_CAPTURES ?? testInfo.outputPath('models')
  try {
    await scenario.writeSettings({ theme: 'strata-night' })
    const page = await scenario.launch()
    await scenario.app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1440, 1000))
    await page.addStyleTag({ content: '* { animation: none !important; caret-color: transparent !important; }' })
    await mkdir(captures, { recursive: true })
    await openAppMenu(page); await page.getByRole('menuitem', { name: 'Usage Limits', exact: true }).click()
    await page.getByRole('button', { name: 'Manage Codex work' }).click()
    await page.getByRole('tab', { name: 'Models', exact: true }).click()
    await sizeModelDialog(page)
    await page.getByLabel('Custom model ID').fill('gpt-5.6')
    await page.getByLabel('Custom model display name').fill('Inspection reviewer')
    await page.screenshot({ path: `${captures}/models-mixed-list.png` })
    await page.getByRole('button', { name: 'Edit Inspection reviewer', exact: true }).click()
    await expect(page.getByText('Provider ID: gpt-5.6.', { exact: false })).toBeVisible()
    await page.screenshot({ path: `${captures}/models-edit.png` })
    await page.getByRole('tab', { name: 'Options', exact: true }).click()
    await expect(page.getByLabel('Reasoning effort', { exact: true })).toHaveValue('high')
    await expect(page.getByLabel('Fast mode', { exact: true })).not.toBeChecked()
    await page.screenshot({ path: `${captures}/models-options.png` })
    await page.getByRole('tab', { name: 'Details', exact: true }).click()
    await page.getByLabel('Model display name').fill('Named reviewer')
    await page.getByRole('tab', { name: 'Options', exact: true }).click()
    await page.getByLabel('Reasoning effort', { exact: true }).selectOption('low')
    await page.getByRole('switch', { name: 'Fast mode', exact: true }).click()
    // The untouched config is updated by another client while this model is edited.
    engine.setSettings({ providerInstances: { codex: { ...provider, config: { ...provider.config, futureConfig: 'changed elsewhere' } } } })
    await page.getByRole('button', { name: 'Save model', exact: true }).click()
    await expect(page.getByLabel('Custom model ID')).toBeVisible()
    const saved = (await page.evaluate(() => window.strata.readEngineSettings())).providerInstances.codex!.config!
    expect(saved).toEqual({ futureConfig: 'changed elsewhere', customModels: ['legacy-model', { ...entry, name: 'Named reviewer', capabilities: { ...entry.capabilities, optionDescriptors: [{ ...descriptors[0], currentValue: 'low' }, { ...descriptors[1], currentValue: true }, entry.capabilities.optionDescriptors[2]] } }] })
    // The engine owns its model report. Publish its newly saved model as a real provider would.
    const model = (saved.customModels as typeof entry[])[1]!
    engine.setProviders(DEFAULT_PROVIDERS.map((value, index) => index ? value : { ...value as object, models: [{ ...model, isDefault: true }] }))
    await page.evaluate(() => window.strata.refreshAccounts())
    await page.getByRole('button', { name: 'Done', exact: true }).click()
    await page.getByRole('button', { name: 'Close', exact: true }).click()
    await page.getByRole('tab', { name: 'Projects', exact: true }).click()
    await page.getByRole('button', { name: 'New thread in Cockpit project' }).click()
    await page.getByRole('button', { name: 'Choose model and account' }).click()
    await page.getByRole('button', { name: 'Use Named reviewer', exact: true }).click()
    await page.getByLabel('Message conversation').fill('Review the inspection.')
    await page.getByLabel('Message conversation').press('Enter')
    await expect.poll(() => engine.commands.filter(command => command.type === 'thread.turn.start').length).toBe(1)
    expect(engine.commands.find(command => command.type === 'thread.turn.start')).toMatchObject({ modelSelection: { instanceId: 'codex', model: 'gpt-5.6', options: [{ id: 'effort', value: 'low' }, { id: 'fastMode', value: true }] } })
  } finally { await scenario.dispose(); await engine.close() }
})

test('an unsupported saved selection blocks save and concurrent custom model edits are refused', async ({}, testInfo) => {
  const invalidEntry = { ...entry, capabilities: { ...entry.capabilities, optionDescriptors: [{ ...descriptors[0], currentValue: 'lots' }, descriptors[1], entry.capabilities.optionDescriptors[2]] } }
  const base = { ...provider, config: { ...provider.config, customModels: ['legacy-model', invalidEntry] } }
  const engine = await startEngine({ providers: providers(), settings: { providerInstances: { codex: base } } })
  const scenario = await seededScenario(testInfo, engine.origin)
  const captures = process.env.STRATAMD_MODELS_CAPTURES ?? testInfo.outputPath('models')
  try {
    await scenario.writeSettings({ theme: 'strata-night' })
    const page = await scenario.launch()
    await scenario.app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1440, 1000))
    await page.addStyleTag({ content: '* { animation: none !important; caret-color: transparent !important; }' })
    await openAppMenu(page); await page.getByRole('menuitem', { name: 'Usage Limits', exact: true }).click()
    await page.getByRole('button', { name: 'Manage Codex work' }).click()
    await page.getByRole('tab', { name: 'Models', exact: true }).click()
    await sizeModelDialog(page)
    await page.getByRole('button', { name: 'Edit Inspection reviewer', exact: true }).click()
    await page.getByRole('tab', { name: 'Options', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Save model', exact: true })).toBeDisabled()
    await expect(page.getByRole('alert')).toContainText('Choose a supported value for Reasoning effort')
    await expect(page.getByLabel('Reasoning effort', { exact: true })).toHaveAttribute('aria-invalid', 'true')
    await mkdir(captures, { recursive: true }); await page.screenshot({ path: `${captures}/models-invalid.png` })
    await page.getByLabel('Reasoning effort', { exact: true }).selectOption('high')
    await expect(page.getByRole('button', { name: 'Save model', exact: true })).toBeEnabled()
    engine.setSettings({ providerInstances: { codex: { ...base, config: { ...base.config, customModels: [...base.config.customModels, 'other-client-model'] } } } })
    await page.getByRole('button', { name: 'Save model', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText('changed in another client')
    expect((await page.evaluate(() => window.strata.readEngineSettings())).providerInstances.codex?.config?.customModels).toEqual([...base.config.customModels, 'other-client-model'])
  } finally { await scenario.dispose(); await engine.close() }
})

test('unsupported options for the selected model are refused before a turn or attachment is sent', async ({}, testInfo) => {
  const engine = await startEngine({ providers: providers() })
  const scenario = await seededScenario(testInfo, engine.origin)
  try {
    const page = await scenario.launch()
    for (const options of [[{ id: 'effort', value: 'invented' }], [{ id: 'unreported', value: true }]]) {
      const uploads = engine.uploads.length
      const error = await page.evaluate(async options => {
        try {
          await window.strata.startConversationTurn('t1', { instanceId: 'codex', model: 'gpt-5.6', effort: null, options, access: 'approval-required', text: 'Must not send', attachments: [{ kind: 'text', name: 'private.txt', text: 'Must not upload' }] })
          return ''
        } catch (error) { return String(error) }
      }, options)
      expect(error).toContain('supported')
      expect(engine.uploads).toHaveLength(uploads)
      expect(engine.commands.filter(command => command.type === 'thread.turn.start')).toHaveLength(0)
    }
  } finally { await scenario.dispose(); await engine.close() }
})


test('adding a display name writes a structured model while its provider ID remains explicit', async ({}, testInfo) => {
  const base = { driver: 'codex', config: { futureConfig: 'keep', customModels: [] } }
  const engine = await startEngine({ providers: DEFAULT_PROVIDERS, settings: { providerInstances: { codex: base } } })
  const scenario = await seededScenario(testInfo, engine.origin)
  const captures = process.env.STRATAMD_MODELS_CAPTURES ?? testInfo.outputPath('models')
  try {
    await scenario.writeSettings({ theme: 'strata-night' })
    const page = await scenario.launch()
    await scenario.app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1440, 1000))
    await page.addStyleTag({ content: '* { animation: none !important; caret-color: transparent !important; }' })
    await openAppMenu(page); await page.getByRole('menuitem', { name: 'Usage Limits', exact: true }).click()
    await page.getByRole('button', { name: 'Manage Codex work' }).click()
    await page.getByRole('tab', { name: 'Models', exact: true }).click()
    await sizeModelDialog(page)
    await page.getByLabel('Custom model ID').fill('inspection-custom-model')
    await page.getByLabel('Custom model display name').fill('Inspection reviewer')
    await page.getByRole('heading', { name: 'Codex work', exact: true }).click()
    await mkdir(captures, { recursive: true }); await page.screenshot({ path: `${captures}/models-list.png` })
    await page.getByRole('button', { name: 'Add custom model', exact: true }).click()
    await expect(page.getByLabel('Custom model ID')).toHaveValue('')
    expect((await page.evaluate(() => window.strata.readEngineSettings())).providerInstances.codex?.config).toEqual({ futureConfig: 'keep', customModels: [{ slug: 'inspection-custom-model', name: 'Inspection reviewer' }] })
  } finally { await scenario.dispose(); await engine.close() }
})
