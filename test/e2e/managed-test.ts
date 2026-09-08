import type { test as sharedTest } from './test'
import { Scenario } from './harness'

type ManagedScenarioFactory = (content: string | Buffer, name?: string) => Promise<Scenario>

export function withManagedScenario(base: typeof sharedTest) {
  return base.extend<{ managedScenario: ManagedScenarioFactory }>({
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
          try { await scenario.stop() } catch (error) { failures.push(error) }
          try { await scenario.dispose() } catch (error) { failures.push(error) }
        }
        if (failures.length > 0) throw new AggregateError(failures, 'Managed Scenario teardown failed')
      }
    },
  })
}
