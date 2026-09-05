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
 * P97 (D-106) addendum: `CHECKPOINT_SCHEMA_VERSION` bumped 2 -> 3 and `CheckpointIdentity` gained
 * `prototypesPerCard`/`prototypeStrategy`/`prototypeStrategyVersion`, for the identical reason the
 * original fields exist — a checkpoint built for the single-prototype (v1) format must never be
 * silently resumed into a dual-prototype build (it would have no auxiliary embeddings at all for
 * every "already done" card, which `checkpointMatchesIdentity` returning false here forces a full,
 * loud, from-scratch rebuild to fix) and, symmetrically, a checkpoint built under one auxiliary
 * strategy/version must never be resumed under a different one. The schema-version bump alone
 * already invalidates every pre-P97 checkpoint regardless of the new fields, matching this
 * module's own established pattern for a breaking identity-shape change.
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
 *
 * P110 addendum: `CHECKPOINT_SCHEMA_VERSION` bumped 3 -> 4 and `Checkpoint` gained
 * `permanentFailures`/`transientFailures` (prompt §8) — resume semantics need to distinguish a
 * card that will never succeed (its reference image genuinely 404s) from one that failed for a
 * reason that might resolve on its own (a timeout, a 5xx, a rate limit). A card in
 * `permanentFailures` is skipped on resume rather than re-fetched every single time the build is
 * resumed (mirroring §7's "do not repeatedly hammer 404" guidance across resumes, not just within
 * one run's own retry loop); a card in `transientFailures` is always retried on resume, exactly
 * like the pre-P110 behavior for every failure. Both are diagnostic-and-gating, overwritten fresh
 * each run (never accumulated across resumes), matching the established `auxFallback` pattern.
 * The schema-version bump alone already invalidates every pre-P110 checkpoint (neither new field
 * would be present), so no separate migration path is needed — a checkpoint from before this
 * change is discarded and rebuilt from scratch, same as every prior schema-shape change here.
 */

export const CHECKPOINT_SCHEMA_VERSION = 4

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
  /** P97 (D-106): how many reference prototypes per card this checkpoint is building towards, and
   *  which recipe/version produces the ones beyond the first (pristine). Required (not optional)
   *  so a pre-P97 checkpoint — which never set these fields at all — can never satisfy
   *  {@link checkpointMatchesIdentity} by accident. */
  readonly prototypesPerCard: number
  readonly prototypeStrategy: string
  readonly prototypeStrategyVersion: string
}

export interface Checkpoint {
  totalCanonicalCards: number
  cardsWithUsableImage: number
  /** Prototype 0 — the plain pristine reference embedding. Unchanged in shape/meaning from every
   *  prior single-prototype build. */
  readonly embeddings: Record<string, number[]>
  /** P97 (D-106): prototype 1 — the auxiliary (dual-prototype) embedding, present only for a card
   *  whose auxiliary computation actually succeeded. A card present in `embeddings` but absent
   *  here (and not marked in `auxFallback` either) simply hasn't had its auxiliary attempted yet
   *  by this resumed run — the same "not done yet" meaning `embeddings` itself already carries. */
  readonly auxEmbeddings: Record<string, number[]>
  /** P97 (D-106): ids whose auxiliary computation was attempted and FAILED (at least once, this
   *  build) — packed with the pristine embedding duplicated into the auxiliary prototype slot
   *  (prompt §13's safe fallback) rather than left unindexed. A card can appear here without ever
   *  appearing in `auxEmbeddings` (fallback stays permanent for that card, this run) or can appear
   *  in `auxEmbeddings` from an earlier successful attempt before a later resumption re-marks it
   *  fallback — the packer (`build-index.ts`) always prefers a real `auxEmbeddings` entry over a
   *  fallback marker when both exist for the same id. */
  readonly auxFallback: Record<string, true>
  /** P110 (prompt §8): ids whose PRISTINE fetch failed with a permanent cause (currently: HTTP 404
   *  — the reference image genuinely does not exist) THIS run. Skipped on the next resume rather
   *  than re-fetched — see this module's own P110 addendum above. Cleared for a card the moment
   *  its pristine fetch succeeds (never left stale once the underlying cause is fixed, e.g. the
   *  image is later published). */
  readonly permanentFailures: Record<string, { readonly reason: string; readonly failedAt: string }>
  /** P110 (prompt §8): ids whose PRISTINE fetch failed with a cause that might resolve on its own
   *  (timeout, network error, 429, 5xx, or a decode/embed error) THIS run — always retried on the
   *  next resume, exactly like every failure behaved before this field existed. Diagnostic only;
   *  never gates a skip. */
  readonly transientFailures: Record<string, { readonly reason: string; readonly failedAt: string }>
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
    checkpoint.quantization === expected.quantization &&
    checkpoint.prototypesPerCard === expected.prototypesPerCard &&
    checkpoint.prototypeStrategy === expected.prototypeStrategy &&
    checkpoint.prototypeStrategyVersion === expected.prototypeStrategyVersion
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
    auxEmbeddings: {},
    auxFallback: {},
    permanentFailures: {},
    transientFailures: {},
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
