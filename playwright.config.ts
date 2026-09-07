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
// another. Six ordinary workers on a Linux workstation is fixed; it is not a
// default to tune. Load timeouts mean another suite run is sharing the box or
// a test is defective, and the fix goes there (AGENTS.md). Public-repo CI
// runners have four cores and run two. A Mac has one desktop, one focus, and
// one clipboard, so it runs one worker in total. STRATAMD_E2E_WORKERS exists
// for the eight-worker stress pass and for measurements, never as a way down.
const macHost = process.platform === 'darwin'
export const ORDINARY_WORKERS = 6
function ordinaryWorkerCount(): number {
  if (macHost) return 1
  const override = process.env.STRATAMD_E2E_WORKERS
  if (override === undefined || override === '') return process.env.CI ? 2 : ORDINARY_WORKERS
  if (!/^[1-9]\d*$/.test(override)) {
    throw new Error(`STRATAMD_E2E_WORKERS must be a positive integer such as 8; got ${JSON.stringify(override)}`)
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
