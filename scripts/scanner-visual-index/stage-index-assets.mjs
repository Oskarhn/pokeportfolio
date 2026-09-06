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
 * Runs as part of `prebuild`. Missing-index policy is now mode-aware (P90 §15) — a missing index
 * used to skip-with-warning unconditionally, which is the right call for local development and
 * CI's `build-and-test` job (neither ships anything real), but genuinely wrong for a build
 * Cloudflare Pages will actually deploy: shipping a scanner with NO visual index, silently and
 * with every other gate green, is a real production regression waiting to happen the moment
 * someone edits vite.config.ts/package.json's index-staging wiring without noticing the index
 * itself never got committed.
 *
 *   - LOCAL/CI (no `CF_PAGES_COMMIT_SHA` — Cloudflare Pages sets this for every real Pages build,
 *     the same signal vite.config.ts's own `resolveBuildSha` already uses to distinguish a hosted
 *     build): missing index -> warn and skip, exactly as before. The browser runtime treats a
 *     missing index as "visual recognition unavailable this session" and falls back to OCR +
 *     manual search (prompt §36) — it must never crash a LOCAL build.
 *   - HOSTED (`CF_PAGES_COMMIT_SHA` set): missing index -> HARD FAILURE. A deployed build must
 *     never silently ship without its visual index while every other check stays green.
 */
import { existsSync, mkdirSync, cpSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyCurrentGeneration } from './verify-index.ts'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const sourceDir = join(repoRoot, 'scripts', 'scanner-visual-index', 'generated', 'visual-v1')
const outDir = join(repoRoot, 'public', 'scanner-assets', 'visual-v1', 'index')

const isHostedBuild = process.env.CF_PAGES_COMMIT_SHA !== undefined

if (!existsSync(join(sourceDir, 'current.json'))) {
  if (isHostedBuild) {
    console.error(
      'stage-index-assets: HOSTED build (CF_PAGES_COMMIT_SHA is set) but no generated index ' +
        `exists at ${sourceDir} — refusing to ship a deployed scanner with no visual index. Run ` +
        '`pnpm scanner:index:build --target=hosted` and commit the result before deploying.',
    )
    process.exit(1)
  }
  console.warn(
    'stage-index-assets: no generated index found at ' +
      `${sourceDir} — skipping (LOCAL/CI build, CF_PAGES_COMMIT_SHA unset). Run ` +
      '`pnpm scanner:index:build` first, or the shipped scanner will fall back to OCR + manual ' +
      'search only (no crash, no missing-asset error).',
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

// P106 build-isolation hardening: this was a plain additive cpSync, which never removes a stale
// generation folder left in outDir from an earlier build in this same working directory (e.g. a
// prior checkout whose committed index had a different content id). current.json always points
// at the right one, so an orphaned folder was never actually served — but a directory that can
// silently accumulate unrelated generations across builds is exactly the class of build-isolation
// hazard this session's differential investigation was run to rule out. Wiping outDir first makes
// every build's staged index deterministic: exactly the current generation, nothing left over.
rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })
cpSync(join(sourceDir, 'current.json'), join(outDir, 'current.json'))
cpSync(join(sourceDir, 'generations'), join(outDir, 'generations'), { recursive: true })
console.log(`stage-index-assets: verified index staged in public/scanner-assets/visual-v1/index`)
