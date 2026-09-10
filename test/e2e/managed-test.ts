import type { test as sharedTest } from './test'
import { Scenario } from './harness'
import { stageRuntime } from '../../src/main/engine/managed-runtime'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { expect, type Page } from './test'

type ManagedScenarioFactory = (content: string | Buffer, name?: string) => Promise<Scenario>

export async function waitForManagedEngine(page: Page): Promise<void> {
  // Learning the engine identity reloads the renderer during startup.
  await expect(async () => {
    expect((await page.evaluate(() => window.strata.getState())).engine.managed?.state).toBe('running')
  }).toPass({ timeout: 20000 })
}

export function withManagedScenario(base: typeof sharedTest) {
  return base.extend<{ managedScenario: ManagedScenarioFactory; installedScenario: Scenario; runningScenario: Scenario }>({
    installedScenario: [async ({ managedScenario }, use, testInfo) => {
      if (!process.env.STRATAMD_ENGINE_BUNDLE) { base.skip(); return }
      const scenario = await managedScenario('# Managed engine document\n')
      const started = performance.now()
      await stageRuntime(process.env.STRATAMD_ENGINE_BUNDLE, join(scenario.env.XDG_DATA_HOME!, 'stratamd/engine'))
      await testInfo.attach('runtime-installation', { body: `${Math.round(performance.now() - started)} ms`, contentType: 'text/plain' })
      await use(scenario)
    }, { timeout: 30000 }],
    runningScenario: [async ({ installedScenario: scenario }, use) => {
      await waitForManagedEngine(await scenario.launch())
      await use(scenario)
    }, { timeout: 30000 }],
    managedScenario: async ({}, use, testInfo) => {
      const scenarios: Scenario[] = []
      try {
        await use(async (content, name) => {
          const scenario = await Scenario.create(testInfo, content, name)
          scenario.env.STRATAMD_ENGINE_MODE = 'managed'
          scenarios.push(scenario)
          return scenario
        })
      } finally {
        const failures: unknown[] = []
        for (const scenario of scenarios.reverse()) {
          // Preserve startup timings before the isolated profile is removed.
          const log = await readFile(join(scenario.env.XDG_DATA_HOME!, 'stratamd/logs/stratamd.log'), 'utf8').catch(() => '')
          if (log) await testInfo.attach('managed-startup-log', { body: log, contentType: 'text/plain' })
          try { await scenario.stop() } catch (error) { failures.push(error) }
          try { await scenario.dispose() } catch (error) { failures.push(error) }
        }
        if (failures.length > 0) throw new AggregateError(failures, 'Managed Scenario teardown failed')
      }
    },
  })
}
