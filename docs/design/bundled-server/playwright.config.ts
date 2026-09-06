import { defineConfig } from '@playwright/test'

// A one-file capture run, serial on the inherited display. Run it under
// `xvfb-run -a` from the repository root; it is not part of the test gate.
export default defineConfig({
  testDir: '.',
  testMatch: 'capture.spec.ts',
  timeout: 240_000,
  expect: { timeout: 5_000 },
  workers: 1,
  retries: 0,
  reporter: 'list',
  outputDir: '/tmp/stratamd-bundled-server-capture',
  use: { trace: 'off', screenshot: 'off' },
})
