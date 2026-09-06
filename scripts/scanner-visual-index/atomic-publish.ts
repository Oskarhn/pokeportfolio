/**
 * Atomic filesystem publish primitives for one visual-index generation (P87 F-24).
 *
 * Extracted out of build-index.ts's main() so the interruption-safety property — "if this process
 * is killed partway through, `current.json` still names the previous valid generation, never a
 * torn or half-written one" — is independently testable rather than only provable by reading the
 * inline script logic.
 *
 * THE PATTERN: write every file into a `.tmp-*` staging directory, run a caller-supplied
 * verification step against that staged content, and only rename (a single atomic filesystem
 * operation on POSIX and Windows alike, when source and destination share a volume) into the
 * final content-addressed directory once verification passes. `current.json` is published the
 * same way — write-temp, then rename — and only ever called AFTER the generation directory itself
 * is already safely in place, so a kill between the two leaves `current.json` pointing at
 * whatever it pointed at before (or absent, on a first-ever publish).
 */
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface GenerationFiles {
  readonly 'manifest.json': string
  readonly 'card-ids.json': string
  readonly 'embeddings.bin': Buffer
}

/**
 * Stages `files` into a temp directory under `generationsDir`, runs `verify` against the staged
 * directory, and only then renames it into `generationsDir/<contentId>`. On any failure (a write
 * error or `verify` throwing) the temp directory is removed and the error re-thrown — the final
 * directory is never created and nothing already published is touched.
 *
 * If `generationsDir/<contentId>` already exists (a byte-identical rebuild republishing the same
 * content), the redundant temp copy is discarded without renaming — idempotent, not an error.
 */
export async function publishGenerationAtomically(
  generationsDir: string,
  contentId: string,
  files: GenerationFiles,
  verify: (stagedDir: string) => Promise<void>,
): Promise<{ finalDir: string; reused: boolean }> {
  mkdirSync(generationsDir, { recursive: true })
  const finalDir = join(generationsDir, contentId)
  const tmpDir = join(
    generationsDir,
    `.tmp-${contentId}-${String(process.pid)}-${String(Date.now())}-${String(Math.random()).slice(2)}`,
  )
  mkdirSync(tmpDir, { recursive: true })
  try {
    await writeFile(join(tmpDir, 'embeddings.bin'), files['embeddings.bin'])
    await writeFile(join(tmpDir, 'card-ids.json'), files['card-ids.json'])
    await writeFile(join(tmpDir, 'manifest.json'), files['manifest.json'])
    await verify(tmpDir)

    if (existsSync(finalDir)) {
      rmSync(tmpDir, { recursive: true, force: true })
      return { finalDir, reused: true }
    }
    renameSync(tmpDir, finalDir)
    return { finalDir, reused: false }
  } catch (error) {
    rmSync(tmpDir, { recursive: true, force: true })
    throw error
  }
}

/**
 * Publishes `current.json` via write-temp-then-rename. Must only ever be called AFTER the
 * generation it points at is already safely published (see {@link publishGenerationAtomically}) —
 * this function has no knowledge of that ordering itself; the caller (build-index.ts) enforces it
 * by sequencing.
 */
export async function publishPointerAtomically(
  visualV1Dir: string,
  pointerContents: string,
): Promise<void> {
  const finalPath = join(visualV1Dir, 'current.json')
  const tmpPath = join(
    visualV1Dir,
    `.current.json.tmp-${String(process.pid)}-${String(Date.now())}-${String(Math.random()).slice(2)}`,
  )
  mkdirSync(visualV1Dir, { recursive: true })
  await writeFile(tmpPath, pointerContents)
  renameSync(tmpPath, finalPath)
}
