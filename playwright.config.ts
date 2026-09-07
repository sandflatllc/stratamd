import { defineConfig } from '@playwright/test'

// Every Electron app on the display shares one operating-system clipboard, so
// tests that read or write it carry this tag and run one at a time in their
// own project. The `@` matters: Playwright greps the full title path, project
// name included, so a bare /clipboard/ would match every test in that project.
// test/unit/e2e-clipboard-tags.test.ts fails when a clipboard test lacks the tag.
const clipboardTag = /@clipboard/
const managedTag = /@managed/

// Ordinary tests run in parallel at the test level, each worker on its own X
// display (test/e2e/display.ts), so windows never steal focus from one
// another. On the 16-core workstation six workers ran the suite in 1:45
// against 2:06 at four with no test slower than 16 s (three runs each,
// 2026-09-05); eight had pushed tests past their 30-second timeout on a
// shared display in 2026-09-02. Public-repo CI runners have four cores. A Mac
// has one desktop, one focus, and one clipboard, so it runs one worker in
// total and the override does not apply. Concurrent full runs in separate
// worktrees reproduced load timeouts on 2026-09-05, so the default became four;
// the required eight-worker stress check remains an explicit override.
// The stock-engine recovery check performs three runtime transitions. Four
// concurrent UI workers pushed it past its 30-second budget in two full runs
// on September 6; it finished in about 18 seconds after those workers ended.
// Keep three ordinary workers beside the managed/clipboard slot.
const macHost = process.platform === 'darwin'
function ordinaryWorkerCount(): number {
  if (macHost) return 1
  const override = process.env.STRATAMD_E2E_WORKERS
  if (override === undefined || override === '') return process.env.CI ? 2 : 3
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
  // total and gives a true serial run; STRATAMD_E2E_WORKERS=1 does not, it
  // only sets the ordinary count. A Mac stays at one in total.
  workers: macHost ? 1 : ordinaryWorkers + 1,
  // Starts one Xvfb per worker slot on Linux and fails the run, naming the
  // serial command, if it cannot.
  globalSetup: './test/e2e/display.ts',
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
      grepInvert: /@clipboard|@managed/,
      fullyParallel: true,
      workers: ordinaryWorkers
    },
    { name: 'managed', grep: managedTag, fullyParallel: false, workers: 1 },
    {
      name: 'clipboard',
      grep: clipboardTag,
      fullyParallel: false,
      workers: 1
    }
  ]
})
