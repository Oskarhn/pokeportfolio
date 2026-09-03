/**
 * Bounded generation retention for the content-addressed visual index (P87 F-01 made publishing
 * content-addressed; P94 N-06 closes the gap it deliberately left open — nothing ever removed an
 * old generation, so `generations/` grows by ~8MB every time the index is rebuilt with even one
 * changed embedding, forever, and `stage-index-assets.mjs` copies every one of them into the
 * shipped build (`cpSync(..., { recursive: true })` over the whole `generations/` directory).
 *
 * POLICY (recommended by the prompt, kept simple deliberately): retain the CURRENT generation
 * (whatever `current.json` names after this publish) plus the generation that was current
 * immediately BEFORE this publish — two generations total. The previous generation stays around
 * for one publish cycle so a client that fetched `current.json` a moment before it changed (and
 * is mid-way through fetching `card-ids.json`/`embeddings.bin` from the OLD generation path) does
 * not hit a 404 mid-load. Anything older than that is safe to remove: no client fetches a
 * generation by content id without first reading a `current.json` that named it, and once
 * `current.json` has moved on twice, nothing can still be pointing at a generation from three
 * publishes ago.
 *
 * This does NOT need a persisted history log of every past publish: capturing whatever
 * `current.json` named right before this run overwrites it is enough to know the "previous"
 * generation, and pruning still scans the actual `generations/` directory on disk (not just the
 * two known ids) so it also cleans up any orphaned generations left over from BEFORE this
 * retention policy existed, or from a run that built a new generation but was killed before
 * pruning ran.
 *
 * SAFETY (P94 §3): this module's `pruneOldGenerations` must only ever be called AFTER
 * `current.json` has been successfully republished to point at the new generation (see
 * build-index.ts's call site). A build that fails before publishing the pointer must prune
 * nothing — the previous, still-valid generation must never be at risk because a NEW one failed
 * to complete. Pruning only ever deletes a directory whose name is a well-formed content id; a
 * `.tmp-*` staging directory (owned by `publishGenerationAtomically`, possibly a concurrent
 * in-progress publish) is never touched here.
 *
 * REPOSITORY SIZE (P94 §4): pruning a generation directory from the working tree does NOT remove
 * it from Git history — every commit that ever added those files is still in the repository's
 * object database and can still be checked out via `git show`/`git checkout <old-sha>`. This
 * module bounds the CURRENT CHECKOUT / DEPLOYED ARTIFACT size (what `stage-index-assets.mjs`
 * copies into `public/` and what a fresh clone's working tree contains at HEAD), not the
 * repository's historical pack size, which only `git gc`/history-rewriting tools (not attempted
 * here — this project never rewrites published history) can affect.
 */
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { isWellFormedContentId } from '../../src/domain/scanner/index-content-id'

/** Current generation + one immediately-previous generation (P94 recommended default). */
export const GENERATION_RETENTION_COUNT = 2

export interface PruneResult {
  readonly retained: readonly string[]
  readonly pruned: readonly string[]
}

/**
 * Reads `current.json` under `visualV1Dir` (if it exists) and returns the content id it names, or
 * `null` if there is no prior pointer (a first-ever publish) or the file is unreadable/malformed.
 * Must be called BEFORE `publishPointerAtomically` overwrites it — this is how the caller learns
 * what the "previous" generation was.
 */
export function readPreviousContentId(visualV1Dir: string): string | null {
  const pointerPath = join(visualV1Dir, 'current.json')
  if (!existsSync(pointerPath)) return null
  try {
    const raw = JSON.parse(readFileSync(pointerPath, 'utf-8')) as { contentId?: unknown }
    return typeof raw.contentId === 'string' && isWellFormedContentId(raw.contentId)
      ? raw.contentId
      : null
  } catch {
    return null
  }
}

/**
 * Deletes every generation directory under `generationsDir` whose name is a well-formed content
 * id and is NOT in `retain`. Directories that don't look like a published generation (a `.tmp-*`
 * staging directory, or anything else unexpected) are left alone unconditionally. Idempotent and
 * safe to call with an already-pruned or empty `generationsDir`.
 */
export function pruneOldGenerations(
  generationsDir: string,
  retain: ReadonlySet<string>,
): PruneResult {
  if (!existsSync(generationsDir)) return { retained: [], pruned: [] }
  const retained: string[] = []
  const pruned: string[] = []
  for (const entry of readdirSync(generationsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !isWellFormedContentId(entry.name)) continue
    if (retain.has(entry.name)) {
      retained.push(entry.name)
      continue
    }
    rmSync(join(generationsDir, entry.name), { recursive: true, force: true })
    pruned.push(entry.name)
  }
  return { retained, pruned }
}
