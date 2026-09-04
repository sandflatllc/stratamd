import { defineConfig } from '@playwright/test'

// Every Electron app on the display shares one operating-system clipboard, so
// tests that read or write it carry this tag and run one at a time in their
// own project. The `@` matters: Playwright greps the full title path, project
// name included, so a bare /clipboard/ would match every test in that project.
// test/unit/e2e-clipboard-tags.test.ts fails when a clipboard test lacks the tag.
const clipboardTag = /@clipboard/

// Electron pointer and hover tests share one Xvfb display, so ordinary tests
// run in one worker. The independent clipboard project may overlap it.
function ordinaryWorkerCount(): number {
  const override = process.env.STRATAMD_E2E_WORKERS
  if (override === undefined || override === '') return 1
  if (!/^[1-9]\d*$/.test(override)) {
    throw new Error(`STRATAMD_E2E_WORKERS must be a positive integer such as 4; got ${JSON.stringify(override)}`)
  }
  return Number(override)
}
const ordinaryWorkers = ordinaryWorkerCount()

export default defineConfig({
  testDir: './test/e2e',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  // One slot more than the ordinary project may use, so the clipboard project
  // makes progress beside it. `--workers 1` on the command line caps this
  // total and restores the old serial run.
  workers: ordinaryWorkers + 1,
  // Shared CI runners stall long enough to trip timing-sensitive specs that
  // are deterministic on real machines; retried passes report as flaky.
  retries: process.env.CI ? 2 : 0,
  // A systemic failure times out every attempt of every spec; the global cap
  // turns that into a failed step with a readable per-test log instead of a
  // job the runner kills with nothing persisted.
  globalTimeout: process.env.CI ? 40 * 60_000 : 0,
  reporter: 'list',
  // Playwright's default template adds the project name to every screenshot
  // baseline; this keeps the existing `<name>-linux.png` files.
  snapshotPathTemplate: '{snapshotDir}/{testFileDir}/{testFileName}-snapshots/{arg}{-snapshotSuffix}{ext}',
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  },
  projects: [
    {
      name: 'ordinary',
      grepInvert: clipboardTag,
      fullyParallel: true,
      workers: ordinaryWorkers
    },
    {
      name: 'clipboard',
      grep: clipboardTag,
      fullyParallel: false,
      workers: 1
    }
  ]
})
