import { expect, test } from '@playwright/test'
import { seededScenario, startEngine } from './cockpit-engine-harness'
import { parityCapture } from './captures'

test('working copies leave current checkout refs read-only and bootstrap a new worktree on first send', async ({}, testInfo) => {
  const engine = await startEngine({ previousWorktree: true })
  const scenario = await seededScenario(testInfo, engine.origin)
  try {
    await scenario.writeSettings({ theme: 'strata-night', animatedBackground: false })
    const page = await scenario.launch()
    await scenario.app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1440, 1000))
    await page.getByRole('tab', { name: 'Projects', exact: true }).click()
    await page.getByRole('button', { name: 'New thread in Cockpit project' }).click()
    await expect(page.getByRole('button', { name: 'Workspace branch' })).toContainText('master')
    const capture = (step: string) => parityCapture(page, `workspace-${step}`)
    await capture('start')
    await page.getByRole('button', { name: 'Workspace branch' }).click()
    const refs = page.getByRole('region', { name: 'Workspace refs' })
    await expect(refs).toContainText('This checkout stays on its current branch.')
    await expect(refs.getByRole('button')).toHaveCount(0)
    await capture('local-refs')
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Workspace', exact: true }).click()
    await capture('choices')
    await page.getByRole('button', { name: /^New worktree Use/ }).click()
    await page.getByRole('button', { name: 'Workspace branch' }).click()
    await page.getByRole('searchbox', { name: 'Search refs' }).fill('develop')
    await expect(refs.getByRole('button', { name: 'develop', exact: true })).toBeVisible()
    await page.getByRole('switch', { name: 'Start from origin' }).click()
    await capture('base')
    await refs.getByRole('button', { name: 'develop', exact: true }).click()
    await page.getByLabel('Message conversation').fill('Build in an isolated working copy.')
    await capture('new')
    await page.getByLabel('Message conversation').press('Enter')
    await expect.poll(() => engine.commands.some(command => command.type === 'thread.turn.start')).toBe(true)
    const command = engine.commands.find(command => command.type === 'thread.turn.start')!
    expect(command).toMatchObject({ bootstrap: { prepareWorktree: { projectCwd: '/tmp/cockpit', baseBranch: 'develop', branch: expect.stringMatching(/^t3\/[a-f0-9]{8}$/), startFromOrigin: false }, runSetupScript: true } })
    expect(engine.commands.find(command => command.type === 'thread.create')).toMatchObject({ branch: null, worktreePath: null })
    expect(engine.rpcRequests.some(request => request.tag === 'orchestration.dispatchCommand')).toBe(true)
    expect(engine.rpcRequests.some(request => /checkout|switchBranch/.test(request.tag))).toBe(false)
  } finally { await scenario.dispose(); await engine.close() }
})

test('previous worktree is reused without a bootstrap command', async ({}, testInfo) => {
  const engine = await startEngine({ previousWorktree: true })
  const scenario = await seededScenario(testInfo, engine.origin)
  try {
    const page = await scenario.launch()
    await page.getByRole('tab', { name: 'Projects', exact: true }).click()
    await page.getByRole('button', { name: 'New thread in Cockpit project' }).click()
    await page.getByRole('button', { name: 'Workspace', exact: true }).click()
    await page.getByRole('button', { name: /^Previous worktree/ }).click()
    await page.getByLabel('Message conversation').fill('Reuse this working copy.')
    await page.getByLabel('Message conversation').press('Enter')
    await expect.poll(() => engine.commands.some(command => command.type === 'thread.turn.start')).toBe(true)
    expect(engine.commands.find(command => command.type === 'thread.create')).toMatchObject({ branch: 'master', worktreePath: '/worktrees/previous' })
    expect(engine.commands.find(command => command.type === 'thread.turn.start')).not.toHaveProperty('bootstrap')
    await expect(page.locator('.chat-workspace')).toContainText('Worktree')
    await expect(page.locator('.chat-workspace')).toContainText('/worktrees/previous')
  } finally { await scenario.dispose(); await engine.close() }
})

test('a document-started conversation carries the first-turn worktree bootstrap', async ({}, testInfo) => {
  const engine = await startEngine()
  const scenario = await seededScenario(testInfo, engine.origin)
  try {
    const page = await scenario.launch()
    await page.getByRole('button', { name: 'Start thread', exact: true }).click()
    await expect(page.getByRole('region', { name: 'New conversation' })).toBeVisible()
    await page.getByRole('button', { name: 'Workspace', exact: true }).click()
    await page.getByRole('button', { name: /^New worktree Use/ }).click()
    await page.getByLabel('Message conversation').fill('Review this document in a worktree.')
    await page.getByLabel('Message conversation').press('Enter')
    await expect.poll(() => engine.commands.filter(command => command.type === 'thread.turn.start').length).toBe(1)
    expect(engine.commands.find(command => command.type === 'thread.turn.start')).toMatchObject({ bootstrap: { prepareWorktree: { projectCwd: '/tmp/cockpit', baseBranch: 'master', startFromOrigin: true }, runSetupScript: true } })
  } finally { await scenario.dispose(); await engine.close() }
})
