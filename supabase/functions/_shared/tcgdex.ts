/**
 * TCGdex provider adapter (docs/ARCHITECTURE.md §5's `CardCatalogProvider` boundary).
 *
 * Everything in this file is the only place that is allowed to know TCGdex's response shape.
 * `sync-catalog/index.ts` calls `fetchSetDetail` / `fetchCardDetail` and gets back canonical
 * shapes it can upsert without ever reading a TCGdex field path directly.
 *
 * Real-payload findings this adapter encodes (docs/RESEARCH.md carries the dated probes):
 *
 * - `variants_detailed[]` is real and does carry per-variant finish/stamp/subtype/pricing, but it
 *   is sometimes absent or empty (very old or sparsely-catalogued cards); `mapVariants` falls back
 *   to the boolean `variants` flags so every card still gets at least one variant row.
 * - `variantId` is sometimes the literal string `"generated"` — TCGdex's own placeholder for "no
 *   real cross-reference", not a value that identifies anything. Mapped to `null`.
 * - `pricing.cardmarket.idProduct` / `pricing.tcgplayer.<finish>.productId` are informational only
 *   (DATA_MODEL.md §3.4's schema-correction note): the same id can legitimately be shared by
 *   sibling finishes of one card, so nothing here treats them as unique.
 * - `serie.id === 'tcgp'` identifies Pokémon TCG Pocket, TCGdex's digital-only product line.
 *   `isPocketSeries` is the single place that rule lives.
 */

import { fetchJsonWithPolicy, ProviderError, providerRuntime } from './provider-http.ts'

const BASE_URL = 'https://api.tcgdex.net/v2'

export type Language = 'en' | 'ja'

export interface ProviderSeries {
  tcgdexSeriesId: string
  name: string
}

export interface ProviderSetSummary {
  tcgdexSetId: string
  name: string
  series: ProviderSeries
  logoUrl: string | null
  symbolUrl: string | null
  releasedOn: string | null
  cardCountOfficial: number | null
  cardCountTotal: number | null
  cardIds: string[]
}

export type CardFinish = 'normal' | 'holo' | 'reverse' | 'other'

export interface ProviderVariant {
  finish: CardFinish
  /** Empty string, never null — see the M5 identity-constraint-fix migration for why. */
  stamp: string
  subtype: string
  size: 'standard' | 'oversized'
  tcgdexVariantId: string | null
  cardmarketProductId: string | null
  tcgplayerProductId: string | null
}

export interface ProviderCard {
  tcgdexCardId: string
  localId: string
  name: string
  category: string | null
  rarity: string | null
  illustrator: string | null
  imageBaseUrl: string | null
  variants: ProviderVariant[]
}

export class TcgdexNotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TcgdexNotFoundError'
  }
}

export class TcgdexShapeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TcgdexShapeError'
  }
}

/** Per-call options. `deadlineMs` is an absolute epoch-ms deadline a whole batch shares. */
export interface TcgdexCallOptions {
  deadlineMs?: number
}

/**
 * Every provider call goes through `fetchJsonWithPolicy` (timeout, bounded retry with backoff,
 * 429/5xx handling — see ./provider-http.ts). A 404 keeps its dedicated error class because callers
 * treat "the provider does not know this id" differently from "the provider is unwell".
 */
async function fetchJson(path: string, options: TcgdexCallOptions = {}): Promise<unknown> {
  try {
    return await fetchJsonWithPolicy(`${BASE_URL}${path}`, path, { deadlineMs: options.deadlineMs })
  } catch (error) {
    if (error instanceof ProviderError && error.kind === 'not_found') {
      throw new TcgdexNotFoundError(error.message)
    }
    throw error
  }
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

/** Pokémon TCG Pocket is a separate, digital-only product line (M5 prompt §8). */
export function isPocketSeries(tcgdexSeriesId: string): boolean {
  return tcgdexSeriesId === 'tcgp'
}

export async function fetchSetDetail(
  language: Language,
  tcgdexSetId: string,
  options: TcgdexCallOptions = {},
): Promise<ProviderSetSummary> {
  const raw = asRecord(
    await fetchJson(`/${language}/sets/${encodeURIComponent(tcgdexSetId)}`, options),
  )
  if (!raw) throw new TcgdexShapeError('set detail was not an object')

  const id = asString(raw.id)
  const name = asString(raw.name)
  const serie = asRecord(raw.serie)
  const serieId = serie ? asString(serie.id) : null
  const serieName = serie ? asString(serie.name) : null
  const cards = Array.isArray(raw.cards) ? raw.cards : null
  if (!id || !name || !serieId || !serieName || !cards) {
    throw new TcgdexShapeError(`set detail missing required fields for ${tcgdexSetId}`)
  }

  const cardCount = asRecord(raw.cardCount)
  const cardIds = cards
    .map((c) => (asRecord(c) ? asString(asRecord(c)!.id) : null))
    .filter((v): v is string => v !== null)

  return {
    tcgdexSetId: id,
    name,
    series: { tcgdexSeriesId: serieId, name: serieName },
    logoUrl: asString(raw.logo),
    symbolUrl: asString(raw.symbol),
    releasedOn: asString(raw.releaseDate),
    cardCountOfficial:
      cardCount && typeof cardCount.official === 'number' ? cardCount.official : null,
    cardCountTotal: cardCount && typeof cardCount.total === 'number' ? cardCount.total : null,
    cardIds,
  }
}

function mapFinish(type: string): CardFinish {
  if (type === 'normal' || type === 'holo' || type === 'reverse') return type
  return 'other'
}

function mapSize(size: string | null): 'standard' | 'oversized' {
  if (size && /oversiz|jumbo/i.test(size)) return 'oversized'
  return 'standard'
}

/** Best-effort only, post schema-correction — see the file header. Never treated as unique. */
function extractTcgplayerProductId(tcgplayer: unknown): string | null {
  const record = asRecord(tcgplayer)
  if (!record) return null
  for (const value of Object.values(record)) {
    const entry = asRecord(value)
    const productId = entry?.productId
    if (typeof productId === 'number' || typeof productId === 'string') return String(productId)
  }
  return null
}

function mapVariantsDetailed(detailed: unknown[]): ProviderVariant[] {
  const out: ProviderVariant[] = []
  for (const entry of detailed) {
    const record = asRecord(entry)
    const type = record ? asString(record.type) : null
    if (!record || !type) continue

    const stampArray = Array.isArray(record.stamp)
      ? record.stamp.filter((s): s is string => typeof s === 'string')
      : []
    const pricing = asRecord(record.pricing)
    const cardmarket = pricing ? asRecord(pricing.cardmarket) : null
    const cardmarketId = cardmarket?.idProduct
    const rawVariantId = asString(record.variantId)

    out.push({
      finish: mapFinish(type),
      stamp: stampArray.length > 0 ? stampArray.join('+') : '',
      subtype: asString(record.subtype) ?? '',
      size: mapSize(asString(record.size)),
      // "generated" is TCGdex's own sentinel for "no real cross-reference" — see file header.
      tcgdexVariantId: rawVariantId && rawVariantId !== 'generated' ? rawVariantId : null,
      cardmarketProductId:
        typeof cardmarketId === 'number' || typeof cardmarketId === 'string'
          ? String(cardmarketId)
          : null,
      tcgplayerProductId: pricing ? extractTcgplayerProductId(pricing.tcgplayer) : null,
    })
  }
  return out
}

/** Fallback for cards with no (or an empty) `variants_detailed` — the boolean flags only. */
function mapVariantsFromFlags(flags: Record<string, unknown>): ProviderVariant[] {
  const finishes: CardFinish[] = []
  if (flags.holo === true) finishes.push('holo')
  if (flags.normal === true) finishes.push('normal')
  if (flags.reverse === true) finishes.push('reverse')
  if (finishes.length === 0) finishes.push('other')

  const stamp = flags.firstEdition === true ? '1st-edition' : flags.wPromo === true ? 'w-promo' : ''

  return finishes.map((finish) => ({
    finish,
    stamp,
    subtype: '',
    size: 'standard' as const,
    tcgdexVariantId: null,
    cardmarketProductId: null,
    tcgplayerProductId: null,
  }))
}

// ── Pricing (M9) ──────────────────────────────────────────────────────────────────────────────
//
// Real-payload findings this section encodes (docs/RESEARCH.md carries the dated probes,
// 2026-08-21, re-verified against the live API at M9 implementation time):
//
// - Two distinct pricing shapes coexist. Some `variants_detailed[]` entries carry their own
//   embedded `pricing` object (own idProduct, own numbers) — TCGdex's own explicit assignment of
//   a price to that exact variant. This is the least-ambiguous evidence available and is always
//   preferred when present and non-null. Seen on real payloads for both a card with only one
//   priced variant among several declared ones (base1-4, Charizard) and a card where *every*
//   declared variant carries its own distinct embedded price, including two "reverse, no stamp"
//   siblings with genuinely different `idProduct`s (sve-001, Grass Energy) — proof that
//   `cardmarket_product_id` uniqueness would have been a false assumption even before D-034
//   established it from the catalog-ingest side.
// - Many ordinary modern cards (a plain normal/reverse common — swsh1-2, sv01-001, sv01-030ish, all
//   real payloads) carry NO embedded per-variant pricing at all — every `variants_detailed[]` entry
//   either has no `pricing` key or has one with both providers `null`. For these, the card-level
//   top-level `pricing` object is the only source, and mapping it to a specific variant needs care:
//   - TCGplayer's top-level `pricing.tcgplayer` is keyed by finish-bucket name directly (`normal`,
//     `reverse-holofoil`, `holofoil`, …) — unambiguous *only* when exactly one of the card's
//     declared variants has the matching finish (no stamp/subtype split within that finish).
//   - Cardmarket's top-level `pricing.cardmarket` has only two "slots": the base fields
//     (avg/low/trend/avg7/avg30) and the `-holo` suffixed fields. The base slot represents the
//     card's "normal" finish; the `-holo` slot represents whichever *one* non-normal finish variant
//     exists. If a card has more than one non-normal-finish variant (e.g. both a true holo and a
//     reverse), the `-holo` slot cannot be safely attributed to either — real payload evidence
//     (base1-4) shows the `-holo` figures can belong to a Cardmarket product not represented by any
//     declared variant at all, which is exactly the ambiguity prompt §15 requires treating as
//     "no price" rather than guessing.
// - `variantId` is still routinely the literal `"generated"` sentinel even on cards with real,
//   distinctly-priced variants (swsh1-2) — never used as identity here either, consistent with the
//   existing catalog-ingest adapter above.
// - A provider can be entirely absent for a card that has the other (sve-001's `tcgplayer: null`
//   at the card level while `cardmarket` is present) — a real "missing provider" case, not a bug.
// - A genuine zero/near-zero observation (`trend: 0`) is a real value, not an absent one; this
//   module never treats `0` as `null`. Some numeric fields can be individually `null` within an
//   otherwise-present pricing object (`avg: null, low: 0.02, trend: 0`, sve-001) — the price-kind
//   fallback chain (below) skips a `null` field and tries the next, exactly like a missing snapshot.
//
// Ambiguous cases are never guessed at: `cardmarket`/`tcgplayer` on a `ProviderVariantPricing` is
// `null` whenever the evidence does not unambiguously identify one Cardmarket/TCGplayer product for
// that exact variant. A caller (the ingest Edge Function, or the on-demand Search pricing endpoint)
// simply has no candidate for that variant/provider — never a wrong one.

export type PriceProvider = 'tcgdex_cardmarket' | 'tcgdex_tcgplayer'
export type PriceKind = 'cm_trend' | 'cm_avg30' | 'cm_avg7' | 'cm_avg' | 'tp_market'

export interface PriceCandidate {
  readonly provider: PriceProvider
  readonly priceKind: PriceKind
  /** ISO 4217, always 'EUR' for tcgdex_cardmarket and 'USD' for tcgdex_tcgplayer. */
  readonly sourceCurrency: string
  /** Exact minor units — see `toMinorUnits` below for why converting a JSON float here is safe. */
  readonly valueMinor: bigint
  readonly providerUpdatedAt: string | null
}

export interface ProviderVariantPricing {
  readonly finish: CardFinish
  readonly stamp: string
  readonly subtype: string
  readonly size: 'standard' | 'oversized'
  readonly cardmarket: PriceCandidate | null
  readonly tcgplayer: PriceCandidate | null
}

export interface ProviderCardPricing {
  readonly tcgdexCardId: string
  readonly variants: ProviderVariantPricing[]
}

/**
 * Converts a Cardmarket/TCGplayer price (a JSON number, always 2 fractional digits in every
 * payload observed) to exact integer minor units. This is the one deliberate, narrow crossing
 * point where a JS float is unavoidable — TCGdex's wire format is JSON, which has no decimal
 * type — and `Math.round` at this exact boundary is what makes every value downstream of it an
 * exact bigint, consistent with FINANCIAL_MODEL.md §1's "never float" rule applying to *our*
 * arithmetic and storage, not to how a third-party API happens to serialize a number over HTTP.
 */
function toMinorUnits(value: number): bigint {
  return BigInt(Math.round(value * 100))
}

/**
 * A provider price this pipeline can convert EXACTLY: finite, and whose minor-unit integer is a
 * safe integer. The two edge functions that carry `valueMinor` on (`ingest-prices` writes it to
 * `price_snapshots.value_minor`, `search-prices` returns it) do so as a JavaScript number, which is
 * only exact up to 2^53 - 1 (P146 / D-137). An absurd price above that is treated as absent — an
 * honest "no price" — rather than rounded into a wrong one.
 */
function asFiniteNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  // A negative price is not a price: `price_snapshots.value_minor` is CHECK (>= 0), so one negative
  // value would not just be wrong — it would make the database reject the whole upsert chunk it
  // travels in, taking up to 499 unrelated, valid observations down with it.
  if (value < 0) return null
  return Math.abs(Math.round(value * 100)) <= Number.MAX_SAFE_INTEGER ? value : null
}

const ISO_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/
/** A provider timestamp further ahead than this is a malformed value, not "observed just now". */
const MAX_FUTURE_SKEW_MS = 24 * 60 * 60 * 1000

/**
 * A provider-supplied observation time this pipeline may write, or null.
 *
 * The string is later sliced to its date part and sent to Postgres as `snapshot_date` and
 * `provider_updated_at`, where an unparseable or non-existent date ("2026-02-31", which
 * `Date.parse` silently rolls over to March) fails the entire batched upsert, and a far-future one
 * wins `ORDER BY snapshot_date DESC` forever and pins the variant as permanently "fresh". Anything
 * that is not a real calendar instant within a day of now is treated as unknown (null) — the caller
 * then falls back to the retrieval date, exactly as for a payload that carries no timestamp at all.
 */
export function normalizeProviderInstant(value: unknown, nowMs: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  const match = ISO_INSTANT.exec(trimmed)
  if (!match) return null
  const [, y, m, d] = match
  const probe = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)))
  if (
    probe.getUTCFullYear() !== Number(y) ||
    probe.getUTCMonth() !== Number(m) - 1 ||
    probe.getUTCDate() !== Number(d)
  ) {
    return null
  }
  const ms = Date.parse(trimmed)
  if (Number.isNaN(ms)) return null
  if (ms - nowMs > MAX_FUTURE_SKEW_MS) return null
  return trimmed
}

/** Reads `<record>.updated` through `normalizeProviderInstant` against the runtime clock. */
function observedAt(record: Record<string, unknown>): string | null {
  return normalizeProviderInstant(record.updated, providerRuntime.clock.now())
}

/**
 * Cardmarket prices are EUR and TCGplayer prices are USD, and the snapshot constraint hard-codes
 * that pairing. A record that names a different unit is a different currency's number: it is not
 * relabelled, it is absent. A record that names no unit is accepted as before.
 */
function unitMatches(record: Record<string, unknown>, expected: 'EUR' | 'USD'): boolean {
  const unit = record.unit
  if (unit === undefined || unit === null) return true
  return typeof unit === 'string' && unit.trim().toUpperCase() === expected
}

/** Cardmarket's own price-selection fallback, FINANCIAL_MODEL.md §6: trend → avg30 → avg7 → avg. */
const CARDMARKET_FALLBACK: { field: string; kind: PriceKind }[] = [
  { field: 'trend', kind: 'cm_trend' },
  { field: 'avg30', kind: 'cm_avg30' },
  { field: 'avg7', kind: 'cm_avg7' },
  { field: 'avg', kind: 'cm_avg' },
]

/** Reads the first non-null field in Cardmarket's fallback chain from a flat field-name map. */
function pickCardmarketCandidate(
  fields: Record<string, unknown>,
  updated: string | null,
): PriceCandidate | null {
  for (const { field, kind } of CARDMARKET_FALLBACK) {
    const raw = asFiniteNumber(fields[field])
    if (raw !== null) {
      return {
        provider: 'tcgdex_cardmarket',
        priceKind: kind,
        sourceCurrency: 'EUR',
        valueMinor: toMinorUnits(raw),
        providerUpdatedAt: updated,
      }
    }
  }
  return null
}

/** TCGplayer's own single candidate, FINANCIAL_MODEL.md §6/prompt §18: marketPrice, no fallback. */
function pickTcgplayerCandidate(
  bucket: Record<string, unknown>,
  updated: string | null,
): PriceCandidate | null {
  const raw = asFiniteNumber(bucket.marketPrice)
  if (raw === null) return null
  return {
    provider: 'tcgdex_tcgplayer',
    priceKind: 'tp_market',
    sourceCurrency: 'USD',
    valueMinor: toMinorUnits(raw),
    providerUpdatedAt: updated,
  }
}

/**
 * Classifies a TCGplayer finish-bucket key ("normal", "reverse-holofoil", "1st-edition-holofoil",
 * "unlimited", …) into the finish it prices AND whether it is the first-edition product.
 *
 * The edition matters as much as the finish: a `1st-edition-holofoil` bucket is a different,
 * usually far more expensive, product than `holofoil`. Treating both as just "holo" let a first-edition
 * price be attributed to a variant without the first-edition stamp whenever it was the only holo
 * bucket present, and let an embedded object with two holo buckets silently take whichever came
 * first. A key this function does not recognise is not a bucket at all.
 */
interface BucketClass {
  finish: CardFinish
  firstEdition: boolean
}

function classifyBucketKey(key: string): BucketClass | null {
  if (key === 'updated' || key === 'unit') return null
  const firstEdition = key.startsWith('1st-edition')
  const rest = key.replace(/^(1st-edition|unlimited)-?/, '')
  if (rest === '' || rest === 'normal') return { finish: 'normal', firstEdition }
  if (rest.includes('reverse')) return { finish: 'reverse', firstEdition }
  if (rest.includes('holofoil')) return { finish: 'holo', firstEdition }
  return null
}

/** True for a variant whose stamp marks it as the first-edition print. */
function isFirstEditionVariant(variant: Pick<VariantKey, 'stamp'>): boolean {
  return /(^|\+)1st/i.test(variant.stamp)
}

/** The bucket keys of one TCGplayer record that price exactly this variant's finish and edition. */
function matchingBucketKeys(tcgplayer: Record<string, unknown>, variant: VariantKey): string[] {
  const firstEdition = isFirstEditionVariant(variant)
  return Object.keys(tcgplayer).filter((key) => {
    const bucket = classifyBucketKey(key)
    return (
      bucket !== null &&
      asRecord(tcgplayer[key]) !== null &&
      bucket.finish === variant.finish &&
      bucket.firstEdition === firstEdition
    )
  })
}

interface VariantKey {
  finish: CardFinish
  stamp: string
  subtype: string
  size: 'standard' | 'oversized'
}

function sameVariant(a: VariantKey, b: VariantKey): boolean {
  return (
    a.finish === b.finish && a.stamp === b.stamp && a.subtype === b.subtype && a.size === b.size
  )
}

/**
 * Maps one card's raw TCGdex pricing payload to a candidate Cardmarket/TCGplayer price per
 * declared variant, using only unambiguous evidence — see the file-section header for the full
 * real-payload reasoning. `declaredVariants` must be the same list `mapVariantsDetailed`/
 * `mapVariantsFromFlags` produced for this card, so "exactly one variant of this finish" can be
 * decided from the same identity the catalog itself uses (D-033).
 */
function mapCardPricing(
  raw: Record<string, unknown>,
  declaredVariants: VariantKey[],
): ProviderVariantPricing[] {
  const detailedRaw = Array.isArray(raw.variants_detailed) ? raw.variants_detailed : []
  const topPricing = asRecord(raw.pricing)
  const topCardmarket = topPricing ? asRecord(topPricing.cardmarket) : null
  const topTcgplayer = topPricing ? asRecord(topPricing.tcgplayer) : null

  // How many declared variants share each finish — drives the card-level fallback's ambiguity
  // check (prompt §15: more than one candidate for a slot means skip, never guess).
  const finishCounts = new Map<CardFinish, number>()
  for (const v of declaredVariants)
    finishCounts.set(v.finish, (finishCounts.get(v.finish) ?? 0) + 1)
  const nonNormalFinishes = new Set(
    declaredVariants.filter((v) => v.finish !== 'normal').map((v) => v.finish),
  )
  // The TCGplayer buckets are keyed by finish AND edition, so ambiguity is counted the same way.
  const editionKey = (v: VariantKey) =>
    `${v.finish}:${isFirstEditionVariant(v) ? 'first' : 'regular'}`
  const editionCounts = new Map<string, number>()
  for (const v of declaredVariants)
    editionCounts.set(editionKey(v), (editionCounts.get(editionKey(v)) ?? 0) + 1)

  return declaredVariants.map((variant) => {
    // 1. Embedded per-variant pricing, matched by the exact structural key TCGdex itself declared
    //    this variant with — never variantId/product-id (D-034). Preferred whenever present.
    const detailedEntry = detailedRaw.find((entry) => {
      const record = asRecord(entry)
      if (!record) return false
      const type = asString(record.type)
      if (!type) return false
      const stampArray = Array.isArray(record.stamp)
        ? record.stamp.filter((s): s is string => typeof s === 'string')
        : []
      const key: VariantKey = {
        finish: mapFinish(type),
        stamp: stampArray.length > 0 ? stampArray.join('+') : '',
        subtype: asString(record.subtype) ?? '',
        size: mapSize(asString(record.size)),
      }
      return sameVariant(key, variant)
    })
    const embeddedPricing = detailedEntry ? asRecord(asRecord(detailedEntry)!.pricing) : null

    if (embeddedPricing) {
      const cm = asRecord(embeddedPricing.cardmarket)
      const tp = asRecord(embeddedPricing.tcgplayer)
      const cardmarket =
        cm && unitMatches(cm, 'EUR') ? pickCardmarketCandidate(cm, observedAt(cm)) : null
      let tcgplayer: PriceCandidate | null = null
      if (tp && unitMatches(tp, 'USD')) {
        // Embedded tcgplayer pricing is itself keyed by finish bucket (mirrors the top-level
        // shape) — take the bucket matching this variant's own finish and edition. More than one
        // matching bucket is ambiguous (two holo products on one variant): no price, never the
        // first one by object order.
        const matching = matchingBucketKeys(tp, variant)
        if (matching.length === 1) {
          tcgplayer = pickTcgplayerCandidate(asRecord(tp[matching[0]!])!, observedAt(tp))
        }
      }
      if (cardmarket || tcgplayer) {
        return { ...variant, cardmarket, tcgplayer }
      }
      // Embedded object present but every provider null on it — still don't fall through to the
      // card-level slots for *this* variant: TCGdex already gave an explicit (empty) answer.
      return { ...variant, cardmarket: null, tcgplayer: null }
    }

    // 2. Card-level fallback — only when unambiguous.
    let cardmarket: PriceCandidate | null = null
    if (topCardmarket && unitMatches(topCardmarket, 'EUR')) {
      const updated = observedAt(topCardmarket)
      if (variant.finish === 'normal' && (finishCounts.get('normal') ?? 0) === 1) {
        cardmarket = pickCardmarketCandidate(topCardmarket, updated)
      } else if (
        variant.finish !== 'normal' &&
        nonNormalFinishes.size === 1 &&
        (finishCounts.get(variant.finish) ?? 0) === 1
      ) {
        const holoFields: Record<string, unknown> = {
          trend: topCardmarket['trend-holo'],
          avg30: topCardmarket['avg30-holo'],
          avg7: topCardmarket['avg7-holo'],
          avg: topCardmarket['avg-holo'],
        }
        cardmarket = pickCardmarketCandidate(holoFields, updated)
      }
    }

    let tcgplayer: PriceCandidate | null = null
    if (topTcgplayer && unitMatches(topTcgplayer, 'USD')) {
      const matchingKeys = matchingBucketKeys(topTcgplayer, variant)
      if (matchingKeys.length === 1 && (editionCounts.get(editionKey(variant)) ?? 0) === 1) {
        tcgplayer = pickTcgplayerCandidate(
          asRecord(topTcgplayer[matchingKeys[0]!])!,
          observedAt(topTcgplayer),
        )
      }
    }

    return { ...variant, cardmarket, tcgplayer }
  })
}

export async function fetchCardPricing(
  language: Language,
  tcgdexCardId: string,
  options: TcgdexCallOptions = {},
): Promise<ProviderCardPricing> {
  const raw = asRecord(
    await fetchJson(`/${language}/cards/${encodeURIComponent(tcgdexCardId)}`, options),
  )
  if (!raw) throw new TcgdexShapeError('card detail was not an object')
  const id = asString(raw.id)
  if (!id) throw new TcgdexShapeError(`card detail missing id for ${tcgdexCardId}`)

  const detailedRaw = Array.isArray(raw.variants_detailed) ? raw.variants_detailed : []
  const declaredVariants: VariantKey[] =
    detailedRaw.length > 0
      ? mapVariantsDetailed(detailedRaw).map((v) => ({
          finish: v.finish,
          stamp: v.stamp,
          subtype: v.subtype,
          size: v.size,
        }))
      : mapVariantsFromFlags(asRecord(raw.variants) ?? {}).map((v) => ({
          finish: v.finish,
          stamp: v.stamp,
          subtype: v.subtype,
          size: v.size,
        }))

  return { tcgdexCardId: id, variants: mapCardPricing(raw, declaredVariants) }
}

export async function fetchCardDetail(
  language: Language,
  tcgdexCardId: string,
  options: TcgdexCallOptions = {},
): Promise<ProviderCard> {
  const raw = asRecord(
    await fetchJson(`/${language}/cards/${encodeURIComponent(tcgdexCardId)}`, options),
  )
  if (!raw) throw new TcgdexShapeError('card detail was not an object')

  const id = asString(raw.id)
  const localId = asString(raw.localId)
  const name = asString(raw.name)
  if (!id || !localId || !name) {
    throw new TcgdexShapeError(`card detail missing required fields for ${tcgdexCardId}`)
  }

  const detailedRaw = Array.isArray(raw.variants_detailed) ? raw.variants_detailed : []
  const variants =
    detailedRaw.length > 0
      ? mapVariantsDetailed(detailedRaw)
      : mapVariantsFromFlags(asRecord(raw.variants) ?? {})

  return {
    tcgdexCardId: id,
    localId,
    name,
    category: asString(raw.category),
    rarity: asString(raw.rarity),
    illustrator: asString(raw.illustrator),
    imageBaseUrl: asString(raw.image),
    variants,
  }
}
