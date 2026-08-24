/// <reference types="vitest/config" />
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

// Independent M13 export/backup adversarial contract suite (see README.md in this directory).
//
// Written implementation-blind against origin/main + the canonical M13 requirements
// (ROADMAP.md "M13 — Export and backup", PRODUCT_SPEC.md §4.12, DATA_MODEL.md, FINANCIAL_MODEL.md,
// SECURITY.md, TESTING.md, DECISIONS.md D-025/D-070) WITHOUT reading any concurrent
// implementation branch. Deliberately OUTSIDE vitest.db.config.ts's and vite.config.ts's include
// lists: nothing here runs in the repository's standard jobs until an integration session aims it
// at an implementation deliberately. Run it with:
//
//   pnpm test:m13-adversarial
//
// Environment: same SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY variables that
// `pnpm test:db` uses (CI's ephemeral stack or a local stack). Without them the database-backed
// suites skip with explicit reasons; every pure-oracle suite still runs. This package must never
// be pointed at a hosted project.
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
