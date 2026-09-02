/**
 * Binds the offline visual-index generator's resumable checkpoint (P77, D-097 addendum) to the
 * exact source it was built against: schema shape, source project, model identity/revision,
 * embedding dimension and quantization contract.
 *
 * WHY THIS EXISTS: P76's first hosted regeneration reused a checkpoint written against the LOCAL
 * demo catalog. Local and hosted `cards.id` values are both random UUIDs with no structural way
 * to tell them apart, so the packer silently combined 1000 hosted embeddings with 224 leftover
 * local ones — 1224 embeddings packed for a 1000-card hosted catalog (122.4% "coverage"). A
 * checkpoint must never be trusted across a project/model/shape boundary; see also
 * index-coverage.ts's independent defense-in-depth check on the packed output.
 *
 * The identity NEVER contains the service-role key or any other secret — only a project host
 * string derived from the (non-secret) `SUPABASE_URL`.
 *
 * P78 addendum: `Checkpoint` used to carry a persisted `failures` counter, incremented every time
 * a card's image fetch/decode failed and never reset or deduplicated across a resumed run — a
 * card that fails on every attempt (e.g. a permanently-404 image) inflated this count once per
 * resumption, which is exactly why the owner's build (§18) logged "404: 6" for the run it just
 * watched while the shipped manifest's `coverage.failures` read 7 (one earlier resumption's
 * repeat of the same failing card, carried over). The field is gone; `build-index.ts` now derives
 * `coverage.failures` as `cardsWithUsableImage - cardsIndexed` at pack time — inherently
 * current-build/current-card based, self-correcting or self-consistent across a resume, never
 * cumulative across historical attempts.
 */

export const CHECKPOINT_SCHEMA_VERSION = 2

/** The well-known local/CI-placeholder Supabase URL (build-index.ts's own `LOCAL_DEFAULTS.url`,
 *  and CI's `build-and-test` job's `VITE_SUPABASE_URL`, are both exactly this value) — shared here
 *  so the RUNTIME source-project gate (visual-worker.ts, P87 F-22) can recognize "this deployment
 *  itself has no real hosted project configured" and treat that as nothing-to-gate-against rather
 *  than a hard rejection, using the identical constant the generator already treats as local. */
export const LOCAL_SUPABASE_URL = 'http://127.0.0.1:54321'

export interface CheckpointIdentity {
  readonly schemaVersion: number
  /** Derived from SUPABASE_URL's host — e.g. "127.0.0.1:54321" or "nopmkroeygmlvndzjjqs.supabase.co". */
  readonly sourceProjectIdentity: string
  readonly modelId: string
  readonly modelRevision: string
  readonly embeddingDim: number
  readonly quantization: string
}

export interface Checkpoint {
  totalCanonicalCards: number
  cardsWithUsableImage: number
  readonly embeddings: Record<string, number[]>
}

/** Never returns or logs the URL's credentials — Supabase project URLs carry none, but this
 *  stays defensive: only `.host` (or the raw string on a malformed URL) ever leaves this
 *  function. */
export function deriveProjectIdentity(supabaseUrl: string): string {
  try {
    return new URL(supabaseUrl).host
  } catch {
    return supabaseUrl
  }
}

/** True only when every identity field matches exactly — a checkpoint from a different project,
 *  model, revision, dimension or quantization contract (or one written before this binding
 *  existed at all) must never be reused. */
export function checkpointMatchesIdentity(
  checkpoint: Partial<CheckpointIdentity>,
  expected: CheckpointIdentity,
): boolean {
  return (
    checkpoint.schemaVersion === expected.schemaVersion &&
    checkpoint.sourceProjectIdentity === expected.sourceProjectIdentity &&
    checkpoint.modelId === expected.modelId &&
    checkpoint.modelRevision === expected.modelRevision &&
    checkpoint.embeddingDim === expected.embeddingDim &&
    checkpoint.quantization === expected.quantization
  )
}

/** A blank checkpoint stamped with the CURRENT run's identity — what a mismatched or missing
 *  checkpoint is replaced with (automatic invalidation, loudly logged by the caller; never a
 *  silent partial reuse). */
export function freshCheckpoint(identity: CheckpointIdentity): Checkpoint & CheckpointIdentity {
  return {
    ...identity,
    totalCanonicalCards: 0,
    cardsWithUsableImage: 0,
    embeddings: {},
  }
}

/**
 * The index-membership defense-in-depth (prompt §7): even a correctly-identity-bound checkpoint
 * may hold embeddings for ids no longer in the CURRENT canonical fetch (a card deactivated, or
 * one whose image disappeared, since the checkpoint was written). Packing must only ever include
 * ids present in `currentCardIdsInOrder` — order preserved, so the packed index inherits the same
 * deterministic id-ascending order pagination already fetched in.
 */
export function packCurrentCardIds(
  currentCardIdsInOrder: readonly string[],
  embeddings: Readonly<Record<string, unknown>>,
): string[] {
  return currentCardIdsInOrder.filter((id) => Object.hasOwn(embeddings, id))
}
