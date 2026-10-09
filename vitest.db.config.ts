/// <reference types="vitest/config" />
import { defineConfig } from 'vite'

// Database and authorization suites (docs/TESTING.md §4-5). Needs a live Supabase stack —
// SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY must be set in the environment.
// Locally: `pnpm db:start` then export the values printed by `pnpm exec supabase status -o env`.
// In CI: supplied by .github/workflows/ci.yml from the ephemeral local stack it starts.
export default defineConfig({
  test: {
    environment: 'node',
    // P189: the erasure registry sink the delete-account function records to (tests/db/global-setup.ts).
    // P203: the first entry refuses a non-loopback SUPABASE_URL/DB_URL/key before any fixture can
    // create a user (tests/support/local-target.ts).
    globalSetup: ['tests/support/local-target-global-setup.ts', 'tests/db/global-setup.ts'],
    include: ['tests/db/**/*.test.ts', 'tests/authorization/**/*.test.ts'],
    // These suites share one Postgres instance and create/delete real auth.users rows —
    // running them in parallel across files risks cross-test interference.
    fileParallelism: false,
    testTimeout: 20_000,
  },
})
