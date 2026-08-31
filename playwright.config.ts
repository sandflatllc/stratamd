import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './test/e2e',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  workers: 1,
  // Shared CI runners stall long enough to trip timing-sensitive specs that
  // are deterministic on real machines; retried passes report as flaky.
  retries: process.env.CI ? 2 : 0,
  // A systemic failure times out every attempt of every spec; the global cap
  // turns that into a failed step with a readable per-test log instead of a
  // job the runner kills with nothing persisted.
  globalTimeout: process.env.CI ? 40 * 60_000 : 0,
  reporter: 'list',
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  }
})
