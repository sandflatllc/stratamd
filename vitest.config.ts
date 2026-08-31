import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['test/setup-tmpdir.ts'],
    // Shared CI runners stall long enough to trip timing-sensitive
    // integration tests that are deterministic on real machines.
    retry: process.env.CI ? 1 : 0,
    include: ['test/unit/**/*.test.ts', 'test/integration/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/core/**/*.ts', 'src/main/**/*.ts', 'src/cli/**/*.ts']
    }
  }
})
