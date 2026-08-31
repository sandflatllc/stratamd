import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/unit/**/*.test.ts', 'test/integration/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/core/**/*.ts', 'src/main/**/*.ts', 'src/cli/**/*.ts']
    }
  }
})
