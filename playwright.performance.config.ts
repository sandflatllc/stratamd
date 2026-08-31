import { defineConfig } from '@playwright/test'

const profile = process.env.STRATAMD_PERF_PROFILE ?? 'smoke'
const runId = process.env.STRATAMD_PERF_RUN_ID ?? 'latest'

const SPEC_BY_PROFILE: Record<string, string> = {
  idle: 'idle.spec.ts',
  tabs: 'tabs.spec.ts',
  keystroke: 'keystroke-trace.spec.ts',
  scroll: 'scroll-trace.spec.ts',
  'tab-switch': 'tab-switch-trace.spec.ts',
  ambient: 'ambient-trace.spec.ts',
  'ambient-sweep': 'ambient-sweep.spec.ts',
  'ambient-shots': 'ambient-shots.spec.ts',
  'theme-shots': 'theme-shots.spec.ts',
}

export default defineConfig({
  testDir: './test/performance',
  testMatch: SPEC_BY_PROFILE[profile] ?? 'stress.spec.ts',
  timeout: 30 * 60_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  outputDir: `test-results/performance/${profile}/${runId}`,
  reporter: 'list',
  use: {
    trace: process.env.STRATAMD_PERF_TRACE === 'all'
      ? 'on'
      : process.env.STRATAMD_PERF_TRACE === '1'
        ? 'retain-on-failure'
        : 'off',
    screenshot: 'only-on-failure',
  },
})
