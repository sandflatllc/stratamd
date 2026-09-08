import { expect, test } from './test'
import { DEFAULT_PROVIDERS, seededScenario, startEngine } from './cockpit-engine-harness'
import { openAppMenu } from './harness'

const instanceSettings = {
  codex: { driver: 'codex', enabled: true, displayName: 'Codex work', config: { binaryPath: '', homePath: '', shadowHomePath: '', launchArgs: '', future: 'keep' }, environment: [{ name: 'SAVED_TOKEN', value: '', sensitive: true, valueRedacted: true }] },
  'claude-main': { driver: 'claudeAgent', enabled: true, config: { binaryPath: '', homePath: '', launchArgs: '', autoCompactWindow: '' } },
  cursor: { driver: 'cursor', enabled: false, config: { binaryPath: '', apiEndpoint: '' } },
  opencode: { driver: 'opencode', enabled: false, config: { binaryPath: '', serverUrl: '', serverPassword: '' } },
}
const extra = ['cursor', 'opencode'].map(driver => ({ instanceId: driver, driver, displayName: driver, enabled: false, installed: false, status: 'unknown', auth: { status: 'unauthenticated' } }))

test('provider secrets keep explicit replacement/removal and only edited fields overwrite concurrent settings', async ({}, testInfo) => {
  const engine = await startEngine({ settings: { providerInstances: instanceSettings }, providers: [...DEFAULT_PROVIDERS, ...extra] })
  const scenario = await seededScenario(testInfo, engine.origin)
  try {
    const page = await scenario.launch()
    await openAppMenu(page); await page.getByRole('menuitem', { name: 'Usage Limits', exact: true }).click()
    await page.getByRole('button', { name: 'Manage Codex work' }).click()
    await page.getByText('Advanced configuration', { exact: true }).click()
    await expect(page.getByLabel('Variable 1 value')).toHaveCount(0)
    await page.getByLabel('Display name', { exact: true }).fill('Renamed')
    await page.getByLabel('Accent color', { exact: true }).fill('#123456')
    await page.getByLabel('Binary path', { exact: true }).fill('/opt/codex')
    await page.getByLabel('Account home path', { exact: true }).fill('/opt/account')
    await page.getByLabel('Shadow home path', { exact: true }).fill('/opt/shadow')
    await page.getByLabel('Launch arguments', { exact: true }).fill('--test-argument')
    engine.setSettings({ providerInstances: { ...instanceSettings, codex: { ...instanceSettings.codex, config: { ...instanceSettings.codex.config, future: 'changed elsewhere' } } } })
    await page.getByRole('button', { name: 'Save changes', exact: true }).click()
    await expect(page.getByRole('dialog', { name: 'Usage Limits', exact: true })).toBeVisible()
    let current = (await page.evaluate(() => window.strata.readEngineSettings())).providerInstances.codex!
    expect(current).toMatchObject({ displayName: 'Renamed', accentColor: '#123456', config: { binaryPath: '/opt/codex', homePath: '/opt/account', shadowHomePath: '/opt/shadow', launchArgs: '--test-argument', future: 'changed elsewhere' }, environment: [{ value: '', valueRedacted: true }] })
    await page.getByRole('button', { name: 'Manage Codex work' }).click()
    await page.getByText('Advanced configuration', { exact: true }).click()
    await page.getByRole('button', { name: 'Replace SAVED_TOKEN' }).click()
    await page.getByRole('button', { name: 'Save changes', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText('Enter a value')
    await page.getByLabel('Variable 1 value').fill('test-only-replacement')
    await page.getByRole('button', { name: 'Add environment variable' }).click()
    await page.getByLabel('Variable 2 name').fill('PLAIN_SETTING')
    await page.getByLabel('Variable 2 value').fill('visible')
    await page.getByRole('switch', { name: 'Secret PLAIN_SETTING' }).click()
    await page.getByRole('button', { name: 'Save changes', exact: true }).click()
    await expect(page.getByRole('dialog', { name: 'Usage Limits', exact: true })).toBeVisible()
    current = (await page.evaluate(() => window.strata.readEngineSettings())).providerInstances.codex!
    expect(current.environment?.[0]).toMatchObject({ value: 'test-only-replacement', valueRedacted: false })
    await page.getByRole('button', { name: 'Manage Codex work' }).click()
    await page.getByText('Advanced configuration', { exact: true }).click()
    await page.getByRole('button', { name: 'Remove SAVED_TOKEN' }).click()
    await page.getByRole('button', { name: 'Save changes', exact: true }).click()
    await expect(page.getByRole('dialog', { name: 'Usage Limits', exact: true })).toBeVisible()
    expect((await page.evaluate(() => window.strata.readEngineSettings())).providerInstances.codex?.environment).toHaveLength(1)
  } finally { await scenario.dispose(); await engine.close() }
})

test('Claude, Cursor, and OpenCode expose their own fields without enabling disabled accounts', async ({}, testInfo) => {
  const engine = await startEngine({ settings: { providerInstances: instanceSettings }, providers: [...DEFAULT_PROVIDERS, ...extra] })
  const scenario = await seededScenario(testInfo, engine.origin)
  try {
    const page = await scenario.launch()
    await openAppMenu(page); await page.getByRole('menuitem', { name: 'Usage Limits', exact: true }).click()
    for (const [name, fields] of [ ['Claude', { 'Account home path': '/opt/claude-home', 'Launch arguments': '--debug', 'Auto-compact after': '250000' }], ['cursor', { 'API endpoint': 'https://cursor.example.test' }], ['opencode', { 'Server URL': 'http://127.0.0.1:9191', 'Server password': 'disposable-password' }] ] as const) {
      await page.getByRole('button', { name: `Manage ${name}` }).click()
      await page.getByText('Advanced configuration', { exact: true }).click()
      for (const [label, value] of Object.entries(fields)) await page.getByLabel(label, { exact: true }).fill(value)
      if (name === 'opencode') await expect(page.getByText('T3 stores this optional password in plain text.')).toBeVisible()
      await page.getByRole('button', { name: 'Save changes', exact: true }).click()
      await expect(page.getByRole('dialog', { name: 'Usage Limits', exact: true })).toBeVisible()
    }
    const saved = (await page.evaluate(() => window.strata.readEngineSettings())).providerInstances
    expect(saved['claude-main']?.config).toMatchObject({ autoCompactWindow: '250000' })
    expect(saved.cursor).toMatchObject({ enabled: false, config: { apiEndpoint: 'https://cursor.example.test' } })
    expect(saved.opencode).toMatchObject({ enabled: false, config: { serverUrl: 'http://127.0.0.1:9191', serverPassword: 'disposable-password' } })
  } finally { await scenario.dispose(); await engine.close() }
})

test('model order and custom ids persist separately, and a Claude-only account can repair generated text', async ({}, testInfo) => {
  const providers = structuredClone(DEFAULT_PROVIDERS) as Array<{ instanceId: string; installed?: boolean; auth?: unknown; models?: Array<Record<string, unknown>> }>
  providers[0]!.models!.push({ slug: 'gpt-5.4-mini', name: 'GPT-5.4 Mini' })
  const engine = await startEngine({ providers, settings: { providerInstances: instanceSettings, textGenerationModelSelection: { instanceId: 'codex', model: 'gpt-5.6', options: [] } } })
  const scenario = await seededScenario(testInfo, engine.origin)
  try {
    let page = await scenario.launch()
    const open = async () => { await openAppMenu(page); await page.getByRole('menuitem', { name: 'Usage Limits', exact: true }).click() }
    await open(); await page.getByRole('button', { name: 'Manage Codex work' }).click(); await page.getByRole('tab', { name: 'Models', exact: true }).click()
    await page.getByRole('button', { name: 'Move GPT-5.4 Mini up' }).click()
    await expect(page.locator('.provider-model-row').first()).toContainText('GPT-5.4 Mini')
    await page.getByLabel('Custom model ID').fill('custom-model-for-test')
    await page.getByRole('button', { name: 'Add custom model' }).click()
    await expect(page.getByLabel('Custom model ID')).toHaveValue('')
    expect((await page.evaluate(() => window.strata.readEngineSettings())).providerInstances.codex?.config?.customModels).toEqual(['custom-model-for-test'])
    await scenario.stop(); page = await scenario.launch(); await open()
    await page.getByRole('button', { name: 'Manage Codex work' }).click(); await page.getByRole('tab', { name: 'Models', exact: true }).click()
    await expect(page.locator('.provider-model-row').first()).toContainText('GPT-5.4 Mini')
    await page.getByRole('button', { name: 'Done', exact: true }).click()
    providers[0]!.auth = { status: 'unauthenticated' }
    engine.setProviders(providers)
    await page.getByRole('button', { name: 'Close', exact: true }).click(); await open()
    await expect(page.getByRole('button', { name: 'Choose a model in Settings' })).toBeVisible()
    await page.getByRole('button', { name: 'Choose a model in Settings' }).click()
    const section = page.getByRole('region', { name: 'Text generation model', exact: true })
    await section.locator(':scope > details > summary').click()
    await section.getByRole('button', { name: 'Claude', exact: true }).click()
    await page.getByRole('button', { name: 'Save changes', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toBeDisabled()
    expect((await page.evaluate(() => window.strata.readEngineSettings())).textGenerationModelSelection).toMatchObject({ instanceId: 'claude-main', model: 'claude-fable-5-1' })
  } finally { await scenario.dispose(); await engine.close() }
})
