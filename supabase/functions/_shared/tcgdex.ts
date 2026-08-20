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

export class TcgdexNotFoundError extends Error {}

class TcgdexShapeError extends Error {}

async function fetchJson(path: string): Promise<unknown> {
  const response = await fetch(`${BASE_URL}${path}`)
  if (response.status === 404) {
    throw new TcgdexNotFoundError(`not found: ${path}`)
  }
  if (!response.ok) {
    throw new Error(`TCGdex ${response.status} for ${path}`)
  }
  return response.json()
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
): Promise<ProviderSetSummary> {
  const raw = asRecord(await fetchJson(`/${language}/sets/${encodeURIComponent(tcgdexSetId)}`))
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

export async function fetchCardDetail(
  language: Language,
  tcgdexCardId: string,
): Promise<ProviderCard> {
  const raw = asRecord(await fetchJson(`/${language}/cards/${encodeURIComponent(tcgdexCardId)}`))
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
