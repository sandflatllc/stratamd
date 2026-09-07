import { test as base, type TestInfo } from '@playwright/test'
import { rm } from 'node:fs/promises'
export * from '@playwright/test'

interface ScenarioEvidence {
  captureEvidence(): Promise<void>
  rawTraces: string
  traces: string[]
  screenshots: string[]
}
const evidence = new Map<TestInfo, Set<ScenarioEvidence>>()
export function scenarioEvidence(info: TestInfo): Set<ScenarioEvidence> {
  let scenarios = evidence.get(info)
  if (!scenarios) { scenarios = new Set(); evidence.set(info, scenarios) }
  return scenarios
}

// Imported hooks register on only the first spec loaded by a worker. An auto
// fixture belongs to every test, and runs after each spec's own teardown.
export const test = base.extend<{ strataEvidence: void }>({
  strataEvidence: [async ({}, use, info) => {
    try { await use() } finally {
      const scenarios = evidence.get(info)
      try {
        for (const scenario of scenarios ?? []) {
          await scenario.captureEvidence()
          if (info.status === info.expectedStatus) await rm(scenario.rawTraces, { recursive: true, force: true })
          for (const path of [...scenario.traces, ...scenario.screenshots]) {
            if (info.status === info.expectedStatus) await rm(path, { force: true })
            else await info.attach(path.endsWith('.zip') ? 'electron-trace' : 'electron-screenshot', { path, contentType: path.endsWith('.zip') ? 'application/zip' : 'image/png' })
          }
        }
      } finally { evidence.delete(info) }
    }
  }, { auto: true }],
})
