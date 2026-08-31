import { defineConfig } from '@playwright/test'

/** Lab config for the memory-attribution investigation (docs/plans/open/performance-plan.md item 6). */
const spec = process.env.STRATAMD_MEMORY_SPEC ?? 'memory-attribution.spec.ts'

export default defineConfig({
  testDir: './test/performance',
  testMatch: spec,
  timeout: 60 * 60_000,
  expect: { timeout: 60_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  outputDir: 'test-results/performance/memory-run',
  reporter: 'list',
  use: { trace: 'off', screenshot: 'off' },
})
