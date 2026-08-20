/// <reference types="vitest/config" />
import { defineConfig } from 'vite'

// Database and authorization suites (docs/TESTING.md §4-5). Needs a live Supabase stack —
// SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY must be set in the environment.
// Locally: `pnpm db:start` then export the values printed by `pnpm exec supabase status -o env`.
// In CI: supplied by .github/workflows/ci.yml from the ephemeral local stack it starts.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/db/**/*.test.ts', 'tests/authorization/**/*.test.ts'],
    // These suites share one Postgres instance and create/delete real auth.users rows —
    // running them in parallel across files risks cross-test interference.
    fileParallelism: false,
    testTimeout: 20_000,
  },
})
