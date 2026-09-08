import { expect, test as base } from './test'
import { withManagedScenario } from './managed-test'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setSource } from './harness'
import { copyRuntimeDirectory } from '../../src/platform/runtime-copy'

const test = withManagedScenario(base)

test('restoring through This computer keeps newer document text and restores matching account preferences @managed', async ({ managedScenario }) => {
  test.skip(!process.env.STRATAMD_ENGINE_BUNDLE, 'Requires the stock runtime')
  const scenario = await managedScenario('# Before update\n')
  const bundle = join(scenario.root, 'bundle')
  await copyRuntimeDirectory(process.env.STRATAMD_ENGINE_BUNDLE!, bundle)
  const manifest = JSON.parse(await readFile(join(bundle, 'runtime.json'), 'utf8')); delete manifest.integrity
  scenario.env.STRATAMD_ENGINE_BUNDLE = bundle
  await writeFile(join(bundle, 'runtime.json'), JSON.stringify({ ...manifest, version: manifest.version + '-ui-old' }))
  const page = await scenario.launch()
  await expect.poll(async () => (await page.evaluate(() => window.strata.getState()).catch(() => null))?.engine.managed?.state, { timeout: 20000 }).toBe('running')
  await page.evaluate(() => window.strata.parkAccount('codex', true))
  await writeFile(join(bundle, 'runtime.json'), JSON.stringify({ ...manifest, version: manifest.version + '-ui-new' }))
  await page.evaluate(() => window.strata.engineRecovery!({ action: 'update' }))
  await expect.poll(async () => (await page.evaluate(() => window.strata.getState()).catch(() => null))?.engine.managed?.version, { timeout: 30000 }).toContain('ui-new')
  // A stopped state during the transition can open the recovery dialog.
  const openDialog = page.getByRole('dialog', { name: 'Connections', exact: true })
  if (await openDialog.isVisible()) await openDialog.getByRole('button', { name: 'Close', exact: true }).click()
  await page.evaluate(() => window.strata.parkAccount('codex', false))
  await setSource(page, '# Newer editor text stays\n')
  await page.evaluate(() => localStorage.setItem('bundled-recovery-draft-proof', 'newer unsent text'))
  await page.getByRole('button', { name: 'Engine status' }).click()
  const dialog = page.getByRole('dialog', { name: 'Connections', exact: true })
  await dialog.getByText('Advanced engine details', { exact: true }).click()
  await dialog.getByText('Engine updates and recovery', { exact: true }).click()
  const backups = await page.evaluate(() => window.strata.engineRecovery!({ action: 'status' }))
  const backup = backups.backups.find(row => row.kind === 'upgrade')!
  await dialog.getByLabel('Engine backup', { exact: true }).selectOption(backup.id)
  await expect(dialog.getByRole('button', { name: 'Restore engine backup', exact: true })).toBeDisabled()
  await dialog.getByLabel('Keep newer work in a backup and restore this engine history').check()
  await dialog.getByRole('button', { name: 'Restore engine backup', exact: true }).click()
  await expect.poll(async () => (await page.evaluate(() => window.strata.getState()).catch(() => null))?.engine.managed?.version, { timeout: 20000 }).toContain('ui-old')
  await expect.poll(async () => (await page.evaluate(() => window.strata.getState())).engine.accounts.find(row => row.instanceId === 'codex')?.parked).toBe(true)
  expect(await page.evaluate(() => localStorage.getItem('bundled-recovery-draft-proof'))).toBe('newer unsent text')
  await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(page.getByRole('textbox', { name: /source editor/i })).toHaveValue('# Newer editor text stays\n')
})
