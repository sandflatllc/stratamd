import { expect, test } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { seededScenario, startEngine } from './cockpit-engine-harness'

for (const source of ['local', 'new-folder', 'url', 'github'] as const) {
  test(`add project from ${source} selects the project after the shell update`, async ({}, testInfo) => {
    const engine = await startEngine()
    const scenario = await seededScenario(testInfo, engine.origin)
    try {
      await scenario.writeSettings({ theme: 'strata-night', animatedBackground: false })
      await scenario.writeSettings({ theme: 'strata-night', animatedBackground: false })
    const page = await scenario.launch()
      await scenario.app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1440, 1000))
      await page.getByRole('tab', { name: 'Projects', exact: true }).click()
      await page.getByRole('button', { name: 'New thread in Cockpit project' }).click()
      await page.locator('.new-conversation').getByRole('button', { name: 'Add project' }).click()
      await mkdir('docs/design/t3-parity/captures', { recursive: true })
      const capture = (step: string) => page.screenshot({ animations: 'disabled', path: `docs/design/t3-parity/captures/project-${step}.png` })
      await capture('sources')
      if (source === 'local' || source === 'new-folder') {
        await page.getByRole('button', { name: /Local folder Browse/ }).click()
        await expect(page.getByRole('button', { name: 'Add folder', exact: true })).toBeEnabled()
        await capture('local')
        if (source === 'new-folder') {
          await page.getByRole('button', { name: 'New folder', exact: true }).click()
          await page.getByLabel('Folder name').fill('New app')
          await capture('new-folder')
          await page.getByRole('button', { name: 'Create & add' }).click()
        } else {
          await page.getByRole('button', { name: /Example app Open/ }).click()
          await expect(page.getByRole('textbox', { name: 'Folder path', exact: true })).toHaveValue('/home/owner/Projects/Example app')
          await page.getByRole('button', { name: 'Add folder', exact: true }).click()
        }
      } else {
        await page.getByRole('button', { name: source === 'url' ? /Git URL Clone/ : /GitHub repository Look/ }).click()
        await page.getByLabel(source === 'url' ? 'Repository URL' : 'GitHub repository', { exact: true }).fill(source === 'url' ? 'git@github.com:owner/repo.git' : 'owner/repo')
        await capture(source)
        await page.getByRole('button', { name: source === 'url' ? 'Continue' : 'Look up repository', exact: true }).click()
        await expect(page.getByLabel('Clone destination')).toHaveValue('/home/owner/Projects/repo')
        await capture('destination')
        await page.getByRole('button', { name: 'Browse…', exact: true }).click()
        await expect(page.getByRole('button', { name: 'Use this folder' })).toBeEnabled()
        await capture('browse-destination')
        await page.getByRole('button', { name: 'Use this folder' }).click()
        await page.getByRole('button', { name: 'Create & clone' }).click()
        await expect.poll(() => engine.rpcRequests.some(request => request.tag === 'sourceControl.cloneRepository')).toBe(true)
      }
      await expect(page.getByRole('dialog')).toBeHidden()
      const command = engine.commands.find(command => command.type === 'project.create')!
      expect(command).toBeTruthy()
      if (source === 'new-folder') expect(command.createWorkspaceRootIfMissing).toBe(true)
      await expect(page.getByLabel('Conversation project')).toHaveValue(String(command.projectId))
    } finally { await scenario.dispose(); await engine.close() }
  })
}
