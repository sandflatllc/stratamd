import { expect, test, type Page, type TestInfo } from './test'
import { DEFAULT_PROVIDERS, seededScenario, startEngine } from './cockpit-engine-harness'
import { openThread } from './cockpit-agent'
import { primaryKey } from './harness'

const at = '2026-09-03T12:02:00Z'
const skill = (name: string, description: string) => ({ name, description, enabled: true, path: `/workspace/skills/${name}/SKILL.md` })
const catalog = { slashCommands: [{ name: 'compact', description: 'Compacts context immediately' }], skills: [
  { ...skill('agent-browser', 'Open pages, inspect UI, and capture evidence'), userInvocationOnly: true },
  skill('design', 'Create and review UI proposals'),
  { ...skill('disabled', 'Do not show'), enabled: false },
  { ...skill('agent-only', 'Do not show'), userInvocable: false },
] }
const providers = (commands = catalog) => DEFAULT_PROVIDERS.map((provider, index) => ({ ...provider as object,
  slashCommands: [], skills: [skill('wrong-workspace', 'Not for this checkout')],
  workspaceSnapshots: [{ cwd: '/tmp/cockpit', checkedAt: at, ...(index === 0 ? commands : { slashCommands: [], skills: [skill('wrong-account', 'Not for this account')] }) }],
}))
async function capture(page: Page, testInfo: TestInfo, state: string) {
  await page.mouse.move(1300, 980)
  await page.evaluate(async () => { await document.fonts.ready; document.documentElement.dataset.typing = 'true' })
  await page.screenshot({ path: testInfo.outputPath(`skills-${state}.png`), animations: 'disabled', caret: 'hide' })
}
async function setup(testInfo: TestInfo, idle = false) {
  const engine = await startEngine({ providers: providers(), pendingRequests: false, projectsParity: true })
  if (idle) engine.complete(at)
  engine.setMessage('# Inspection page review\n\nThe main offer is clear. I’ll review the inspection flow and the supporting copy.\n\n## Keep the next step visible\n\nUse a direct call to action and explain what happens after a homeowner requests an inspection.\n')
  const scenario = await seededScenario(testInfo, engine.origin)
  await scenario.writeSettings({ theme: 'strata-night' })
  const page = await scenario.launch()
  await scenario.app!.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.setContentSize(1440, 1000); BrowserWindow.getAllWindows()[0]!.webContents.setZoomFactor(1) })
  await page.clock.setFixedTime(new Date(at))
  await page.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }' })
  await openThread(page, 'Live engine thread')
  await page.getByRole('button', { name: 'Open in center', exact: true }).click()
  await page.getByRole('tablist', { name: 'Document navigation' }).getByRole('tab', { name: 'Projects' }).click()
  return { engine, scenario, page, input: page.getByRole('textbox', { name: 'Message conversation' }), menu: page.getByRole('region', { name: 'Command and skill search' }) }
}

test('provider workspace skills filter, select by keyboard, restore and send only after explicit submission', async ({}, testInfo) => {
  const { engine, scenario, page, input, menu } = await setup(testInfo)
  try {
    await input.fill('/')
    await expect(menu.getByRole('option')).toHaveCount(3)
    await expect(menu.getByRole('option', { name: /^\$agent-browser / })).toHaveAttribute('aria-selected', 'true')
    await capture(page, testInfo, 'menu')
    await input.press('ArrowUp')
    await expect(menu.getByRole('option', { name: /^\/compact / })).toHaveAttribute('aria-disabled', 'true')
    await input.press('Enter')
    expect(engine.commands.filter(command => command.type === 'thread.turn.start')).toEqual([])
    await input.press('ArrowDown')
    await input.press('ArrowDown')
    await expect(menu.getByRole('option', { name: /^\$design / })).toHaveAttribute('aria-selected', 'true')
    await input.press('ArrowUp')
    await expect(menu.getByRole('option', { name: /^\$agent-browser / })).toHaveAttribute('aria-selected', 'true')
    await input.fill('/evidence')
    await expect(menu.getByRole('option')).toHaveCount(1)
    await input.fill('/browser')
    await expect(menu.getByRole('option')).toHaveCount(1)
    await capture(page, testInfo, 'filtered')
    await input.fill('/roof-estimate')
    await expect(menu.getByText('No matching command or skill')).toBeVisible()
    await capture(page, testInfo, 'empty')
    await menu.getByRole('button', { name: 'Clear search' }).click()
    await expect(input).toHaveValue('/')
    await expect(menu.getByRole('option')).toHaveCount(3)
    await input.fill('/browser')
    await input.press('Enter')
    await expect(input).toHaveValue('$agent-browser ')
    await expect(menu).toHaveCount(0)
    expect(engine.commands.filter(command => command.type === 'thread.turn.start')).toEqual([])
    await input.fill('$agent-browser Review the inspection page.')
    await capture(page, testInfo, 'inserted')
    await page.reload()
    await expect(input).toHaveValue('$agent-browser Review the inspection page.')
    expect(engine.commands.filter(command => command.type === 'thread.turn.start')).toEqual([])
    await input.press('Enter')
    await expect.poll(() => engine.commands.filter(command => command.type === 'thread.turn.start')).toHaveLength(1)
    expect(engine.commands.find(command => command.type === 'thread.turn.start')).toMatchObject({ message: { text: '$agent-browser Review the inspection page.' } })
  } finally { await scenario.dispose(); await engine.close() }
})

test('Compact uses the existing action and an empty workspace catalog overrides provider skills', async ({}, testInfo) => {
  const { engine, scenario, page, input, menu } = await setup(testInfo, true)
  try {
    engine.setProviders(providers({ ...catalog, slashCommands: [...catalog.slashCommands, { name: 'review', description: 'Review changes' }] }))
    await page.evaluate(() => window.strata.refreshAccounts())
    await input.fill('/review')
    // The design skill also matches its description; the exact command name wins selection.
    await expect(menu.getByRole('option')).toHaveCount(2)
    await expect(menu.getByRole('option', { name: /^\/review / })).toHaveAttribute('aria-selected', 'true')
    await input.press('Tab')
    await expect(input).toHaveValue('/review ')
    expect(engine.commands.filter(command => command.type === 'thread.turn.start')).toEqual([])
    await input.fill('Keep this draft.\n/compact')
    await expect(menu.getByRole('option', { name: /^\/compact / })).toHaveAttribute('aria-disabled', 'false')
    await input.press('Enter')
    await expect.poll(() => engine.commands.filter(command => command.type === 'thread.turn.start')).toHaveLength(1)
    expect(engine.commands.find(command => command.type === 'thread.turn.start')).toMatchObject({ message: { text: '/compact', attachments: [] } })
    await expect(input).toHaveValue('Keep this draft.\n')
    await expect(page.locator('.context-compaction-notice')).toContainText('Compacting context')
    expect(engine.uploads).toEqual([])
    engine.setProviders(providers({ slashCommands: [], skills: [] }))
    await page.evaluate(() => window.strata.refreshAccounts())
    await input.fill('/')
    await expect(menu.getByRole('option')).toHaveCount(0)
    await expect(menu.getByText('No matching command or skill')).toBeVisible()
    await input.press('Enter')
    expect(engine.commands.filter(command => command.type === 'thread.turn.start')).toHaveLength(1)
    await input.press('Escape')
    await expect(menu).toHaveCount(0)
    engine.setProviders(providers())
    await page.evaluate(() => window.strata.refreshAccounts())
    await input.fill('/browser')
    const label = menu.getByRole('option').locator('strong')
    await expect(label).toBeVisible()
    const beforeZoom = await label.evaluate(element => parseFloat(getComputedStyle(element).fontSize))
    await label.hover()
    await page.keyboard.press(primaryKey('Equal'))
    await expect.poll(() => label.evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThan(beforeZoom)
  } finally { await scenario.dispose(); await engine.close() }
})

test('unmatched paths and dollar amounts fall through to ordinary Send on Enter', async ({}, testInfo) => {
  const { engine, scenario, input, menu } = await setup(testInfo)
  try {
    for (const text of ['/tmp', '$500']) {
      await input.fill(text)
      await expect(menu.getByText('No matching command or skill')).toBeVisible()
      await input.press('Enter')
      await expect.poll(() => engine.commands.some(command => command.type === 'thread.turn.start' && (command.message as { text: string }).text === text)).toBe(true)
    }
  } finally { await scenario.dispose(); await engine.close() }
})
