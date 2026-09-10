import { expect, test as base } from './test'
import { withManagedScenario } from './managed-test'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setSource, type Scenario } from './harness'
import { stageRuntime } from '../../src/main/engine/managed-runtime'
import { copyRuntimeDirectory } from '../../src/platform/runtime-copy'

// Each preparation phase has its own 30-second bound. The test starts from
// an installed update and checks the owner-facing restoration workflow.
const prepared = withManagedScenario(base).extend<{ bundleScenario: Scenario; stagedScenario: Scenario; recoveryScenario: Scenario }>({
  bundleScenario: [async ({ managedScenario }, use) => {
    if (!process.env.STRATAMD_ENGINE_BUNDLE) { base.skip(); return }
    const scenario = await managedScenario('# Before update\n')
    const bundle = join(scenario.root, 'bundle')
    await copyRuntimeDirectory(process.env.STRATAMD_ENGINE_BUNDLE, bundle)
    const manifest = JSON.parse(await readFile(join(bundle, 'runtime.json'), 'utf8')); delete manifest.integrity
    scenario.env.STRATAMD_ENGINE_BUNDLE = bundle
    await writeFile(join(bundle, 'runtime.json'), JSON.stringify({ ...manifest, version: manifest.version + '-ui-old' }))
    await use(scenario)
  }, { timeout: 30000 }],
  stagedScenario: [async ({ bundleScenario: scenario }, use) => {
    const bundle = scenario.env.STRATAMD_ENGINE_BUNDLE!
    await stageRuntime(bundle, join(scenario.env.XDG_DATA_HOME!, 'stratamd/engine'))
    await use(scenario)
  }, { timeout: 30000 }],
  recoveryScenario: [async ({ stagedScenario: scenario }, use) => {
    const page = await scenario.launch()
    await expect.poll(async () => (await page.evaluate(() => window.strata.getState()).catch(() => null))?.engine.managed?.state, { timeout: 20000 }).toBe('running')
    await page.evaluate(() => window.strata.parkAccount('codex', true))
    await use(scenario)
  }, { timeout: 30000 }],
})

const test = prepared.extend<{ updateRuntimeScenario: Scenario; updatedScenario: Scenario }>({
  updateRuntimeScenario: [async ({ recoveryScenario: scenario }, use) => {
    const bundle = scenario.env.STRATAMD_ENGINE_BUNDLE!
    const manifest = JSON.parse(await readFile(join(bundle, 'runtime.json'), 'utf8'))
    await writeFile(join(bundle, 'runtime.json'), JSON.stringify({ ...manifest, version: manifest.version.replace(/-ui-old$/, '-ui-new') }))
    await stageRuntime(bundle, join(scenario.env.XDG_DATA_HOME!, 'stratamd/engine'))
    await use(scenario)
  }, { timeout: 30000 }],
  updatedScenario: [async ({ updateRuntimeScenario: scenario }, use) => {
    const page = scenario.page!
    await page.evaluate(() => window.strata.engineRecovery!({ action: 'update' }))
    await expect.poll(async () => (await page.evaluate(() => window.strata.getState()).catch(() => null))?.engine.managed?.version, { timeout: 30000 }).toContain('ui-new')
    await use(scenario)
  }, { timeout: 30000 }],
})

test('restoring through This computer keeps newer document text and restores matching account preferences @managed', async ({ updatedScenario: scenario }) => {
  const page = scenario.page!
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
