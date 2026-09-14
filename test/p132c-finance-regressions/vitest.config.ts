/// <reference types="vitest/config" />
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

// Independent P130-01 / P130-03 finance regression package (see README.md in this directory).
// Deliberately outside every standard include list. Needs Docker; boots its own disposable,
// network-less Postgres from this checkout's migrations. Run:
//
//   pnpm exec vitest run --config test/p132c-finance-regressions/vitest.config.ts
const packageRoot = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  root: packageRoot,
  test: {
    environment: 'node',
    include: ['**/*.test.ts'],
    globalSetup: ['./harness/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 600_000,
  },
})
