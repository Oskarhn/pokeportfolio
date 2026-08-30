#!/usr/bin/env node
/**
 * Copies the COMMITTED, versioned visual index (scripts/scanner-visual-index/generated/visual-v1)
 * into public/scanner-assets/visual-v1/ so the build ships it same-origin (prompt §18/§21). This
 * is a plain file copy — the index itself is generated offline by build-index.ts (a separate,
 * deliberately manual step, since it needs a database connection this build step must not have).
 *
 * Runs as part of `prebuild`. If no generated index has been committed yet (a fresh clone before
 * anyone has run `pnpm scanner:index:build`), this step logs a warning and skips: the browser
 * runtime treats a missing index as "visual recognition unavailable this session" and falls back
 * to OCR + manual search (prompt §36) — it must never crash the build.
 */
import { existsSync, mkdirSync, copyFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const sourceDir = join(repoRoot, 'scripts', 'scanner-visual-index', 'generated', 'visual-v1')
const outDir = join(repoRoot, 'public', 'scanner-assets', 'visual-v1')

const FILES = ['manifest.json', 'card-ids.json', 'embeddings.bin']

if (!existsSync(join(sourceDir, 'manifest.json'))) {
  console.warn(
    'stage-index-assets: no generated index found at ' +
      `${sourceDir} — skipping. Run \`pnpm scanner:index:build\` first, or the shipped scanner ` +
      'will fall back to OCR + manual search only (no crash, no missing-asset error).',
  )
  process.exit(0)
}

mkdirSync(outDir, { recursive: true })
for (const file of FILES) {
  copyFileSync(join(sourceDir, file), join(outDir, file))
}
console.log(`stage-index-assets: ${FILES.length} files staged in public/scanner-assets/visual-v1`)
