/// <reference types="vitest/config" />
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

// Independent M12 adversarial contract suite (see README.md in this directory).
//
// Deliberately OUTSIDE vitest.db.config.ts's include list: this package does not run as part of
// the repository's standard db-tests job until someone deliberately aims it at an implementation.
// Run it with:
//   pnpm test:m12-adversarial
// Environment: the same SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY variables
// `pnpm test:db` uses (CI's ephemeral stack or a local stack). No network access beyond that
// Supabase origin; this package must never be pointed at a hosted project.
//
// The root is pinned to this directory so the glob can never reach into tests/ or src/ no matter
// where the runner is invoked from.
const packageRoot = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  root: packageRoot,
  test: {
    environment: 'node',
    include: ['**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
})
