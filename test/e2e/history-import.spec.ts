import { mkdir } from 'node:fs/promises'
import { expect, test } from './test'
import { seededScenario, startEngine } from './cockpit-engine-harness'

const at = '2026-09-03T12:00:00Z'
for (const refusal of ['rpc', 'skipped'] as const) {
test(`native project import ${refusal} reports partial failure and retries without repeating successful projects or starting a turn`, async ({}, testInfo) => {
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  let secondAttempts = 0
  const engine = await startEngine({ historyRpc: async (tag, raw) => {
    if (tag === 'agentSessions.scan') return { scannedAt: at, candidates: [
      { path: '/tmp/cockpit', title: 'Cockpit project', projectId: 'p1', sources: ['codex'], threadCount: 1, lastActiveAt: at, alreadyImported: true, git: { remoteKey: 'repo', repository: 'strata/cockpit' } },
      { path: '/tmp/import-example', title: 'Example project', sources: ['claudeAgent'], threadCount: 1, lastActiveAt: at, alreadyImported: false, git: { remoteKey: 'repo', repository: 'strata/cockpit' } },
      { path: '/srv/openclaw/private', title: 'Private', sources: ['codex'], threadCount: 99, lastActiveAt: at, alreadyImported: false },
    ] }
    const input = raw as { projectId: string; expectedWorkspaceRoot: string }
    if (input.projectId === 'p1') { await held; return { importedCount: 1, skippedCount: 0 } }
    if (++secondAttempts === 1) {
      if (refusal === 'skipped') return { importedCount: 0, skippedCount: 1 }
      throw new Error('Cannot read /tmp/import-example native history. Check source access and retry.')
    }
    return { importedCount: 1, skippedCount: 0 }
  } })
  const scenario = await seededScenario(testInfo, engine.origin)
  try {
    await scenario.writeSettings({ theme: 'strata-night', animatedBackground: false })
    const page = await scenario.launch()
    await scenario.app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1440, 1000))
    const capture = async (state: string) => {
      if (!process.env.STRATA_IMPORT_EVIDENCE || refusal === 'rpc') return
      await mkdir(process.env.STRATA_IMPORT_EVIDENCE, { recursive: true })
      await page.mouse.move(10, 10)
      await page.screenshot({ path: `${process.env.STRATA_IMPORT_EVIDENCE}/import-${state}.png`, animations: 'disabled' })
    }
    await page.getByRole('tab', { name: 'Projects', exact: true }).click()
    await page.locator('.projects-header').getByRole('button', { name: 'Add project', exact: true }).click()
    await page.getByRole('button', { name: /Import existing work Copy recent/ }).click()
    const dialog = page.getByRole('dialog', { name: 'Import existing work' })
    await expect(dialog).toBeVisible(); await capture('sources')
    await dialog.getByRole('button', { name: 'Find projects' }).click()
    await expect(dialog.getByRole('heading', { name: 'Choose projects' })).toBeVisible()
    await expect(dialog.getByText('Private', { exact: true })).toHaveCount(0)
    await expect(dialog.getByRole('heading', { name: 'strata/cockpit' })).toHaveCount(1)
    for (const checkbox of await dialog.getByRole('checkbox').all()) await checkbox.check()
    await capture('select')
    await dialog.getByRole('button', { name: 'Review 2 projects' }).click()
    await expect(dialog.getByText('2 conversations found across 2 projects')).toBeVisible(); await capture('confirm')
    await dialog.getByRole('button', { name: 'Import conversations' }).click()
    await expect.poll(() => engine.rpcRequests.filter(request => request.tag === 'agentSessions.import').length).toBe(1)
    await capture('progress'); release()
    await expect(dialog.getByText('1 imported or already present · 1 project needs attention')).toBeVisible(); await capture('partial')
    await dialog.getByRole('button', { name: 'Retry failed import' }).click()
    await expect(dialog.getByRole('heading', { name: '2 conversations imported or already present' })).toBeVisible(); await capture('done')
    const imports = engine.rpcRequests.filter(request => request.tag === 'agentSessions.import')
    expect(imports.map(request => (request.payload as { expectedWorkspaceRoot: string }).expectedWorkspaceRoot)).toEqual(['/tmp/cockpit', '/tmp/import-example', '/tmp/import-example'])
    expect(engine.rpcRequests.find(request => request.tag === 'agentSessions.scan')?.payload).toEqual({})
    expect(engine.commands.filter(command => command.type === 'project.create')).toHaveLength(1)
    expect(engine.commands.some(command => command.type === 'thread.turn.start')).toBe(false)
  } finally { release(); await scenario.dispose(); await engine.close() }
})

}

test('minimum-width Projects header keeps its original controls and imports through Add project', async ({}, testInfo) => {
  const engine = await startEngine()
  const scenario = await seededScenario(testInfo, engine.origin)
  try {
    await scenario.writeSettings({ theme: 'strata-night', animatedBackground: false, panels: { explorerWidth: 160 } })
    const page = await scenario.launch()
    await page.getByRole('tab', { name: 'Projects', exact: true }).click()
    const header = page.locator('.projects-header')
    await expect(header.getByRole('button')).toHaveCount(1)
    const geometry = await header.evaluate(element => {
      const title = element.querySelector('h2')!
      const range = document.createRange(); range.selectNodeContents(title)
      const text = range.getBoundingClientRect()
      const sort = element.querySelector('select')!.getBoundingClientRect()
      const add = element.querySelector('button')!.getBoundingClientRect()
      return { titleRight: text.right, titleBottom: text.bottom, sortTop: sort.top, sortLeft: sort.left, sortRight: sort.right, addLeft: add.left, addBottom: add.bottom, addRight: add.right, right: element.getBoundingClientRect().right }
    })
    expect(geometry.titleRight).toBeLessThanOrEqual(geometry.addLeft)
    expect(geometry.titleBottom).toBeLessThanOrEqual(geometry.sortTop)
    expect(geometry.addBottom).toBeLessThanOrEqual(geometry.sortTop)
    expect(geometry.sortRight).toBeLessThanOrEqual(geometry.right)
    expect(geometry.addRight).toBeLessThanOrEqual(geometry.right)
    if (process.env.STRATA_IMPORT_EVIDENCE) {
      await mkdir(process.env.STRATA_IMPORT_EVIDENCE, { recursive: true })
      await page.screenshot({ path: `${process.env.STRATA_IMPORT_EVIDENCE}/minimum-projects-header.png`, animations: 'disabled' })
    }
    await header.getByRole('button', { name: 'Add project' }).click()
    await page.getByRole('button', { name: /Import existing work Copy recent/ }).click()
    await expect(page.getByRole('dialog', { name: 'Import existing work' })).toBeVisible()
  } finally { await scenario.dispose(); await engine.close() }
})
