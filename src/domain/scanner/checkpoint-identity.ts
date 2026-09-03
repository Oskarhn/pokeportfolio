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
 *  function. Storage-facing only (checkpoint identity, `manifest.sourceProjectRef`) — never
 *  changed retroactively for an already-published generation, since it feeds the content-id hash.
 *  Runtime COMPARISONS should go through {@link canonicalizeProjectIdentity} instead (P94 N-13),
 *  which normalizes local aliases and strips the `.supabase.co` suffix so an already-committed
 *  manifest's raw host string still matches a canonicalized runtime expectation. */
export function deriveProjectIdentity(supabaseUrl: string): string {
  try {
    return new URL(supabaseUrl).host
  } catch {
    return supabaseUrl
  }
}

/** Canonical sentinel for "this is some local Supabase alias" — one value regardless of which of
 *  the equivalent local hostnames was used to reach it. */
export const LOCAL_PROJECT_IDENTITY_SENTINEL = 'local'

const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

/**
 * Canonicalizes a raw project identity string (as produced by {@link deriveProjectIdentity}, a
 * `host` — hostname[:port] — or a full URL) into a stable form for COMPARISON, not storage
 * (P94 N-13).
 *
 * WHY THIS EXISTS: `deriveProjectIdentity` returns the raw `URL.host`, so `127.0.0.1:54321` and
 * `localhost:54321` — both genuinely local Supabase stacks, interchangeable in practice — compare
 * unequal by exact string match. A developer whose `VITE_SUPABASE_URL` happens to say `localhost`
 * instead of the `127.0.0.1` this codebase's own `LOCAL_SUPABASE_URL` constant uses would have the
 * runtime source-project gate wrongly conclude "this is a real hosted deployment" and start
 * comparing against a project ref that was never configured — silently disabling the visual
 * channel on an ordinary local dev machine. Canonicalizing both sides of every such comparison
 * through this function fixes that without changing what gets STORED anywhere: an
 * already-published manifest's `sourceProjectRef` (e.g. the committed index's
 * `"nopmkroeygmlvndzjjqs.supabase.co"`) still canonicalizes to the same short ref
 * (`"nopmkroeygmlvndzjjqs"`) a freshly-derived hosted URL does, so the existing index keeps
 * verifying correctly — no silent brick, no need to regenerate it.
 *
 * Rules, in order:
 *   1. Accepts either a bare `host` string (`hostname[:port]`) or a full URL; a full URL is
 *      parsed for its hostname, a bare host string has its port stripped by hand (`new URL` would
 *      reject a schemeless string).
 *   2. A hostname that is a known local alias (`127.0.0.1`, `localhost`, `::1`) canonicalizes to
 *      {@link LOCAL_PROJECT_IDENTITY_SENTINEL} regardless of port — a differently-configured local
 *      Supabase CLI port must never be treated as "a different hosted project."
 *   3. A `<ref>.supabase.co` hostname canonicalizes to just `<ref>` — the actual stable project
 *      identity Supabase assigns, independent of the fixed `.supabase.co` suffix.
 *   4. Anything else (a future custom domain fronting Supabase) canonicalizes to its bare
 *      hostname, lowercased — the best available stable identity without an explicit override.
 */
export function canonicalizeProjectIdentity(raw: string): string {
  let hostname: string
  // Deliberately gated on the presence of "://": `new URL('localhost:54321')` does NOT throw —
  // "localhost" is valid URL *scheme* syntax (alpha, then alnum/+/-/.), so the WHATWG parser reads
  // it as an opaque non-special URL (scheme "localhost:", empty host) instead of failing, which
  // would silently produce the WRONG hostname ("") for exactly the bare `host` strings this
  // function most needs to handle correctly (`deriveProjectIdentity`'s own return shape).
  if (raw.includes('://')) {
    try {
      hostname = new URL(raw).hostname
    } catch {
      hostname = raw
    }
  } else {
    // A bare `host` string (hostname[:port]). Strip a trailing `:port` by hand; IPv6 literals
    // arrive bracketed (`[::1]:54321`).
    hostname = raw.startsWith('[') ? raw.slice(0, raw.indexOf(']') + 1) : (raw.split(':')[0] ?? raw)
  }
  const normalizedHostname = hostname.toLowerCase()
  if (LOCAL_HOSTNAMES.has(normalizedHostname)) return LOCAL_PROJECT_IDENTITY_SENTINEL
  if (normalizedHostname.endsWith('.supabase.co')) {
    return normalizedHostname.slice(0, -'.supabase.co'.length)
  }
  return normalizedHostname
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
