#!/usr/bin/env node
/**
 * Copies the COMMITTED, versioned visual index (scripts/scanner-visual-index/generated/visual-v1)
 * into public/scanner-assets/visual-v1/index/ so the build ships it same-origin (prompt §18/§21).
 * This is a file copy — the index itself is generated offline by build-index.ts (a separate,
 * deliberately manual step, since it needs a database connection this build step must not have).
 *
 * P87 F-01: the source layout is now content-addressed — `current.json` (the pointer) plus
 * `generations/<contentId>/{manifest.json,card-ids.json,embeddings.bin}` — mirrored verbatim
 * into public/ under `.../visual-v1/index/`, distinct from the model/engine files
 * (prepare-scanner-visual-assets.mjs stages those separately under `.../visual-v1/model` and
 * `.../visual-v1/ort`, which stay content-STABLE per pinned model revision, never
 * content-addressed).
 *
 * P87 F-23 (load-bearing, not optional): before copying anything, this step now VERIFIES the
 * generation `current.json` points at — the exact checks verify-index.ts runs (checksum, model
 * id/revision/dim, coverage invariants, content-id self-consistency, quantization range) — and
 * fails the build loudly on any violation. Previously this file was a plain, unverified
 * `copyFileSync` and verify-index.ts's own checks ran ONLY when a developer remembered to invoke
 * `pnpm scanner:index:verify` by hand; a corrupted or truncated index could reach `public/`,
 * `pnpm build`, and CI with every gate green. This runs as part of `prebuild` (invoked via `tsx`,
 * not plain `node` — this file imports verify-index.ts's TypeScript directly), so `pnpm build`
 * (both locally and in CI's `build-and-test` job) now gates on it automatically.
 *
 * `SCANNER_INDEX_EXPECTED_SOURCE_REF`, when set, additionally hard-gates the index's declared
 * source project (P87 F-22). Left unset (the default, including CI's `build-and-test` job, which
 * builds against a placeholder Supabase URL on purpose) the check stays a warning, exactly as it
 * already was before this session — see verify-index.ts's own header for why this is not derived
 * from `VITE_SUPABASE_URL` automatically.
 *
 * Runs as part of `prebuild`. If no generated index has been committed yet (a fresh clone before
 * anyone has run `pnpm scanner:index:build`), this step logs a warning and skips: the browser
 * runtime treats a missing index as "visual recognition unavailable this session" and falls back
 * to OCR + manual search (prompt §36) — it must never crash the build.
 */
import { existsSync, mkdirSync, cpSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyCurrentGeneration } from './verify-index.ts'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const sourceDir = join(repoRoot, 'scripts', 'scanner-visual-index', 'generated', 'visual-v1')
const outDir = join(repoRoot, 'public', 'scanner-assets', 'visual-v1', 'index')

if (!existsSync(join(sourceDir, 'current.json'))) {
  console.warn(
    'stage-index-assets: no generated index found at ' +
      `${sourceDir} — skipping. Run \`pnpm scanner:index:build\` first, or the shipped scanner ` +
      'will fall back to OCR + manual search only (no crash, no missing-asset error).',
  )
  process.exit(0)
}

console.log('stage-index-assets: verifying the current generation before staging anything...')
const expectedSourceProjectRef = process.env.SCANNER_INDEX_EXPECTED_SOURCE_REF
try {
  await verifyCurrentGeneration(sourceDir, {
    expectedSourceProjectRef:
      expectedSourceProjectRef !== undefined && expectedSourceProjectRef !== ''
        ? expectedSourceProjectRef
        : undefined,
  })
} catch (error) {
  console.error('stage-index-assets: index verification FAILED — refusing to stage it.')
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
}

mkdirSync(outDir, { recursive: true })
cpSync(join(sourceDir, 'current.json'), join(outDir, 'current.json'))
cpSync(join(sourceDir, 'generations'), join(outDir, 'generations'), { recursive: true })
console.log(`stage-index-assets: verified index staged in public/scanner-assets/visual-v1/index`)
