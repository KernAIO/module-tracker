import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: { passWithNoTests: true,
    include: ['src/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
})
