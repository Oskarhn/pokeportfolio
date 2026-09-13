/**
 * Atomic, corruption-safe filesystem I/O for the offline visual-index generator's resumable
 * checkpoint (P110, prompt §2-3 — P107's DUAL_BUILD_RISK_VERDICT §19).
 *
 * WHY THIS EXISTS. `build-index.ts` used to `writeFile` the checkpoint directly, and load it with
 * an unguarded `JSON.parse`. A checkpoint is rewritten in full every 25 cards across a run that
 * can take multiple hours — a Ctrl+C, a killed process, or a machine sleep during that window can
 * land squarely inside the write, leaving a truncated/partial JSON file on disk. The NEXT resume
 * attempt then hit `JSON.parse` on that truncated file and crashed with a raw parse-error stack —
 * losing every embedding cached so far and forcing a full restart of a run that may have already
 * run for hours. This module fixes both halves: writes go through the same stage-then-rename
 * pattern `atomic-publish.ts` already established for the published index itself (a rename is a
 * single atomic filesystem operation on POSIX and Windows alike, when source and destination share
 * a volume — the checkpoint file never exists half-written), and reads never crash on a corrupt
 * file — they warn loudly, quarantine the evidence, and hand back `null` so the caller starts a
 * fresh checkpoint rather than inventing embeddings or guessing at a partial one.
 *
 * A quarantined file is deliberately NOT deleted — this is diagnostic evidence of a real
 * interruption (or a real bug), and destroying it on the same run that discovers it would be
 * "silently delete evidence," which the fix explicitly must not do. It sits alongside the fresh
 * checkpoint under the same `.visual-index-cache/` directory, timestamped, until a human looks at
 * or removes it by hand.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export type CheckpointLoadOutcome =
  | { readonly status: 'absent' }
  | { readonly status: 'loaded'; readonly checkpoint: unknown }
  | { readonly status: 'corrupt'; readonly quarantinePath: string; readonly reason: string }

/**
 * Loads a checkpoint file written by {@link saveCheckpointAtomically}. Never throws on a
 * malformed file: a JSON parse failure or a non-object top-level value is reported as `corrupt`,
 * with the bad file moved aside (quarantined) rather than deleted or left in place to be
 * re-read (and re-fail) by a later resume. The caller decides what "corrupt" means for identity
 * validation — this module only concerns itself with "is this even parseable JSON."
 */
export function loadCheckpointFile(path: string): CheckpointLoadOutcome {
  if (!existsSync(path)) return { status: 'absent' }
  let raw: string
  try {
    raw = readFileSync(path, 'utf-8')
  } catch (error) {
    return quarantine(path, `unreadable checkpoint file: ${(error as Error).message}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch (error) {
    return quarantine(path, `checkpoint file is not valid JSON: ${(error as Error).message}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const shape = parsed === null ? 'null' : Array.isArray(parsed) ? 'an array' : typeof parsed
    return quarantine(path, `checkpoint file did not contain a JSON object (got ${shape})`)
  }
  return { status: 'loaded', checkpoint: parsed }
}

function quarantine(path: string, reason: string): CheckpointLoadOutcome {
  const quarantinePath = `${path}.corrupt-${String(Date.now())}`
  try {
    renameSync(path, quarantinePath)
  } catch {
    // The file may already be gone or unmoveable (permissions, held open elsewhere) — the load
    // still reports 'corrupt' either way, so the caller starts a safe fresh checkpoint regardless
    // of whether quarantining itself succeeded.
    return { status: 'corrupt', quarantinePath: path, reason }
  }
  console.warn(
    `[checkpoint] WARNING: ${reason}. This checkpoint cannot be trusted — quarantined the ` +
      `original file to ${quarantinePath} (not deleted, kept as evidence) and starting from a ` +
      'fresh checkpoint. Already-embedded cards from this corrupted file will be re-embedded; no ' +
      'partial/guessed data is ever reused.',
  )
  return { status: 'corrupt', quarantinePath, reason }
}

/**
 * Writes `checkpoint` to `path` via stage-then-rename: the full JSON is written to a sibling
 * `.tmp-*` file first, then renamed into place. A kill at any point before the rename leaves the
 * PREVIOUS checkpoint (or none, on the very first save) fully intact — never a torn/half-written
 * file — mirroring {@link import('./atomic-publish').publishPointerAtomically}'s exact pattern.
 */
export async function saveCheckpointAtomically(path: string, checkpoint: unknown): Promise<void> {
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true })
  const tmpPath = join(
    dir,
    `.tmp-checkpoint-${String(process.pid)}-${String(Date.now())}-${String(Math.random()).slice(2)}`,
  )
  await writeFile(tmpPath, JSON.stringify(checkpoint))
  renameSync(tmpPath, path)
}

/** Synchronous variant, for call sites (none currently) that cannot await — kept only so a future
 *  signal-handler-driven "flush on exit" path has a synchronous option available; the generator's
 *  own hot path uses the async version above. */
export function saveCheckpointAtomicallySync(path: string, checkpoint: unknown): void {
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true })
  const tmpPath = join(
    dir,
    `.tmp-checkpoint-${String(process.pid)}-${String(Date.now())}-${String(Math.random()).slice(2)}`,
  )
  writeFileSync(tmpPath, JSON.stringify(checkpoint))
  renameSync(tmpPath, path)
}

// Re-exported only for tests that want to read a raw checkpoint file's file-based directory
// listing without duplicating path logic.
export async function readCheckpointRaw(path: string): Promise<string> {
  return readFile(path, 'utf-8')
}
