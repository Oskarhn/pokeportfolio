/// <reference types="vitest/config" />
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

// Independent M16 (Openings) adversarial contract suite — see README.md in this directory.
//
// Written implementation-blind against origin/main + the canonical documents
// (FINANCIAL_MODEL §4/§5/§8, DATA_MODEL §5.6–§5.8/§8/§9, DECISIONS D-002/D-021/D-060/D-084,
// SECURITY, TESTING, PRODUCT_SPEC §4.7, UX_FLOWS F5) WITHOUT reading any concurrent
// implementation branch. Deliberately OUTSIDE vite.config.ts's and vitest.db.config.ts's
// include lists: nothing here runs in the repository's standard jobs until an integration
// session aims it at an implementation deliberately. Run it with:
//
//   pnpm exec vitest run --config tests/m16-independent/vitest.config.ts
//
// Environment: the same SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY variables
// that `pnpm test:db` uses. Without them every database-backed suite skips with an explicit
// reason and every pure-oracle suite still runs. This package must never be pointed at a
// hosted project.
const packageRoot = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  root: packageRoot,
  test: {
    environment: 'node',
    include: ['**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 180_000,
  },
})
