import { expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { startEngine, seededScenario } from './cockpit-engine-harness'
import { Scenario } from './harness'

test.describe('managed engine @managed', () => {
  test.skip(!process.env.STRATAMD_ENGINE_BUNDLE, 'Set STRATAMD_ENGINE_BUNDLE to the staged stock runtime')
  test('opens documents immediately, connects locally, restarts after a crash and retains identity', async ({}, testInfo) => {
    const scenario = await Scenario.create(testInfo, '# Available during engine startup\n')
    scenario.env.STRATAMD_ENGINE_MODE = 'managed'
    try {
      const page = await scenario.launch()
      await expect(page.getByRole('button', { name: 'Engine status' })).toContainText('Connected', { timeout: 20000 })
      await expect(async () => { expect((await page.evaluate(() => window.strata.getState())).engine.managed?.state).toBe('running') }).toPass({ timeout: 20000 })
      const initial = await page.evaluate(() => window.strata.getState())
      expect(initial.engine.identity).toBeTruthy()
      const path = join(scenario.env.XDG_DATA_HOME!, 'stratamd/engine/runtime.json')
      const record = JSON.parse(await readFile(path, 'utf8'))
      expect(record.baseDirectory.startsWith(scenario.root)).toBe(true)
      process.kill(record.pid, 'SIGKILL')
      await expect.poll(async () => JSON.parse(await readFile(path, 'utf8')).pid, { timeout: 20000 }).not.toBe(record.pid)
      await expect.poll(async () => (await page.evaluate(() => window.strata.getState())).engine.managed?.state).toBe('running')
      expect((await page.evaluate(() => window.strata.getState())).engine.identity).toBe(initial.engine.identity)
      await expect(page.getByRole('dialog', { name: 'This computer' })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Restart engine' })).toBeVisible()
    } catch (error) {
      const state = await scenario.page?.evaluate(() => window.strata.getState()).catch(() => null)
      await testInfo.attach('managed-state', { body: JSON.stringify(state?.engine), contentType: 'application/json' })
      throw error
    } finally { await scenario.stop(); await scenario.dispose() }
  })
})

test('external connection switches to the managed engine with separate drafts and a retained credential @managed', async ({}, testInfo) => {
  test.skip(!process.env.STRATAMD_ENGINE_BUNDLE, 'Requires the stock runtime')
  const external = await startEngine()
  external.complete()
  const scenario = await seededScenario(testInfo, external.origin)
  try {
    const page = await scenario.launch()
    await expect(page.getByRole('button', { name: 'Engine status' })).toContainText('Connected')
    const identity = (await page.evaluate(() => window.strata.getState())).engine.identity!
    await page.evaluate(() => localStorage.setItem('stratamd.conversation-draft.v1:thread:t1', JSON.stringify({ text: 'External only' })))
    await page.getByRole('button', { name: 'Engine status' }).click()
    await page.getByText('Use this computer', { exact: true }).click()
    await page.getByRole('button', { name: 'Switch to this computer' }).click()
    await expect(async () => { expect((await page.evaluate(() => window.strata.getState())).engine.managed?.state).toBe('running') }).toPass({ timeout: 20000 })
    const state = await page.evaluate(() => window.strata.getState())
    expect(state.engine.identity).not.toBe(identity)
    expect(state.engine.projects).toEqual([])
    const credential = JSON.parse(await readFile(join(scenario.env.XDG_DATA_HOME!, 'stratamd/engine-connections', identity, 'engine-credential.json'), 'utf8'))
    expect(credential.server).toBe(external.origin)
    expect(await page.evaluate(() => localStorage.getItem('stratamd.conversation-draft.v1:thread:t1'))).toContain('External only')
    expect(external.commands).toEqual([])
  } finally { await scenario.stop(); await scenario.dispose(); await external.close() }
})

test('an app crash adopts only its surviving authenticated engine @managed', async ({}, testInfo) => {
  test.skip(!process.env.STRATAMD_ENGINE_BUNDLE, 'Requires the stock runtime')
  const scenario = await Scenario.create(testInfo, '# Survives an app crash\n')
  scenario.env.STRATAMD_ENGINE_MODE = 'managed'
  const path = join(scenario.env.XDG_DATA_HOME!, 'stratamd/engine/runtime.json')
  try {
    let page = await scenario.launch()
    await expect(async () => { expect((await page.evaluate(() => window.strata.getState())).engine.managed?.state).toBe('running') }).toPass({ timeout: 20000 })
    const first = JSON.parse(await readFile(path, 'utf8'))
    await scenario.stop(true)
    page = await scenario.launch()
    await expect.poll(async () => (await page.evaluate(() => window.strata.getState())).engine.managed?.state).toBe('running')
    expect(JSON.parse(await readFile(path, 'utf8')).pid).toBe(first.pid)
    await expect(page.getByRole('button', { name: 'Engine status' })).toContainText('Connected')
  } finally { await scenario.stop(); await scenario.dispose() }
})
