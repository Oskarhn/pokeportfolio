/**
 * Derives the content-addressed identifier for one visual-index generation (P87 F-01).
 *
 * WHY THIS EXISTS: before P87, `manifest.json`/`card-ids.json`/`embeddings.bin` were served from
 * the fixed literal path `/scanner-assets/visual-v1/` under a `Cache-Control: immutable,
 * max-age=1y` rule, even though the DATA those three files hold has already been rebuilt multiple
 * times against the identical URL (P76/P77/P79 hosted rebuilds — see docs/DECISIONS.md D-097's
 * addenda). A browser or the Service Worker's own runtime cache that already fetched the OLD
 * generation had no way to ever learn a new one existed short of the immutable directive
 * expiring, up to a year later. The fix mirrors what Vite's own hashed JS/CSS chunks already do:
 * the URL itself changes when the content changes, so "immutable" becomes literally true instead
 * of merely asserted.
 *
 * `deriveIndexContentId` is pure and platform-neutral (Uint8Array/string in, string out) so both
 * the offline generator (Node, `node:crypto`) and the browser runtime (`crypto.subtle`, defense-
 * in-depth cross-check that a fetched generation's bytes actually match the content id named in
 * its own URL) can hash the IDENTICAL canonical payload with their own SHA-256 primitive — see
 * `buildIndexContentPayload` below.
 *
 * WHAT ENTERS THE HASH, deliberately and only:
 *   - the manifest's SEMANTIC fields (model identity/revision, embedding shape, quantization,
 *     card count, coverage numbers, source project identity) as a canonical (fixed-key-order)
 *     JSON string — EXCLUDING `generatedAt` (a rebuild of byte-identical content on a different
 *     day must not mint a new URL) and EXCLUDING `embeddingsSha256` (redundant: the raw embedding
 *     bytes are hashed directly below, which is the stronger, more direct proof)
 *   - the raw `card-ids.json` bytes, verbatim
 *   - the raw `embeddings.bin` bytes, verbatim
 * `cardCount` alone, `generatedAt` alone, or `modelRevision` alone are each explicitly
 * insufficient (prompt's own requirement) — two index generations covering the same card COUNT
 * but different actual cards, or the same generation minted on two different days, or two
 * genuinely different indexes sharing one model revision, must never collide on one content id.
 * Concatenating the full manifest+ids+embeddings payload before hashing rules all three out.
 */

export interface IndexContentIdManifestFields {
  readonly version: string
  readonly modelId: string
  readonly modelRevision: string
  readonly modelSha256: string
  readonly embeddingDim: number
  readonly quantization: string
  readonly cardCount: number
  readonly coverage: {
    readonly totalCanonicalCards: number
    readonly cardsWithUsableImage: number
    readonly cardsIndexed: number
    readonly failures: number
    readonly cardsWithAuxPrototype?: number
    readonly cardsAuxFallback?: number
  }
  readonly sourceProjectRef?: string
  readonly sourceEnglishActiveCount?: number
  /** P97/P100 (D-106/D-1xx): deliberately OMITTED from the canonical payload (not even as
   *  `?? null`) when undefined — see `buildIndexContentPayload`'s own note below for why: any
   *  already-published v1 (LEGACY_V1, single-prototype) manifest must keep hashing to EXACTLY the
   *  content id it already published under, so `JSON.stringify` dropping an `undefined`-valued key
   *  is load-bearing, not incidental. P100 adds `schemaVersion`/`payloadFormat` as the fail-closed
   *  discriminant (index-coverage-schema.ts) alongside the P97 prototype-shape fields — all five
   *  enter the hash together so a schema-version bump alone (even with byte-identical embeddings)
   *  still mints a new content id. */
  readonly schemaVersion?: number
  readonly payloadFormat?: string
  readonly prototypesPerCard?: number
  readonly prototypeStrategy?: string
  readonly prototypeStrategyVersion?: string
}

/** Number of leading hex characters kept from the full SHA-256 digest — long enough that an
 *  accidental collision between two genuinely different generations is not a practical concern
 *  (64 bits of a cryptographic digest), short enough to stay a reasonable URL path segment. */
export const INDEX_CONTENT_ID_HEX_LENGTH = 16

/** Builds the exact byte payload `deriveIndexContentId` hashes — exported so a caller with its
 *  own SHA-256 implementation (Node's `createHash`, the browser's `crypto.subtle.digest`) can
 *  hash it without this module needing to depend on either. */
export function buildIndexContentPayload(
  manifestFields: IndexContentIdManifestFields,
  cardIdsBytes: Uint8Array,
  embeddingsBytes: Uint8Array,
): Uint8Array<ArrayBuffer> {
  // Fixed key order — never `JSON.stringify` on the manifest object directly, whose own key
  // order is an implementation detail of however it was constructed, not a stable hash input.
  //
  // P97 (D-106): the three prototype-* fields below are assigned WITHOUT `?? null` — deliberately,
  // unlike `sourceProjectRef`/`sourceEnglishActiveCount` above them. `JSON.stringify` drops an
  // object key whose value is `undefined`, so on any manifest that predates this field (every
  // already-published v1/single-prototype generation, including the real committed 19,501-card
  // index) the serialized payload is BYTE-IDENTICAL to what this function produced before these
  // fields existed — the existing content id never shifts and `verify-index.ts` keeps passing
  // against the unmodified committed generation. A genuine dual-prototype manifest supplies real
  // values for all three, which DOES change the payload (and therefore the content id), exactly as
  // required: two generations covering the same cards under two different prototype strategies (or
  // strategy versions) must never collide.
  const canonical = {
    version: manifestFields.version,
    modelId: manifestFields.modelId,
    modelRevision: manifestFields.modelRevision,
    modelSha256: manifestFields.modelSha256,
    embeddingDim: manifestFields.embeddingDim,
    quantization: manifestFields.quantization,
    cardCount: manifestFields.cardCount,
    coverage: {
      totalCanonicalCards: manifestFields.coverage.totalCanonicalCards,
      cardsWithUsableImage: manifestFields.coverage.cardsWithUsableImage,
      cardsIndexed: manifestFields.coverage.cardsIndexed,
      failures: manifestFields.coverage.failures,
      cardsWithAuxPrototype: manifestFields.coverage.cardsWithAuxPrototype,
      cardsAuxFallback: manifestFields.coverage.cardsAuxFallback,
    },
    sourceProjectRef: manifestFields.sourceProjectRef ?? null,
    sourceEnglishActiveCount: manifestFields.sourceEnglishActiveCount ?? null,
    schemaVersion: manifestFields.schemaVersion,
    payloadFormat: manifestFields.payloadFormat,
    prototypesPerCard: manifestFields.prototypesPerCard,
    prototypeStrategy: manifestFields.prototypeStrategy,
    prototypeStrategyVersion: manifestFields.prototypeStrategyVersion,
  }
  const fieldsBytes = new TextEncoder().encode(JSON.stringify(canonical))
  const payload = new Uint8Array(fieldsBytes.length + cardIdsBytes.length + embeddingsBytes.length)
  payload.set(fieldsBytes, 0)
  payload.set(cardIdsBytes, fieldsBytes.length)
  payload.set(embeddingsBytes, fieldsBytes.length + cardIdsBytes.length)
  return payload
}

/** Truncates a full hex digest to the content id's fixed length. Exported so both hashing sides
 *  apply the identical truncation rule. */
export function truncateDigestHex(fullHexDigest: string): string {
  return fullHexDigest.slice(0, INDEX_CONTENT_ID_HEX_LENGTH)
}

/** A syntactically valid content id: exactly `INDEX_CONTENT_ID_HEX_LENGTH` lowercase hex chars.
 *  Used to validate a pointer file's `contentId` before it is ever interpolated into a fetch URL. */
export function isWellFormedContentId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    new RegExp(`^[0-9a-f]{${String(INDEX_CONTENT_ID_HEX_LENGTH)}}$`).test(value)
  )
}
