import { supabase } from './supabase-client'
import { withAuthRetry } from './auth-retry'

/**
 * Thin typed query layer over the shared catalog (ARCHITECTURE.md §2's `data/` layer). Components
 * call these, never `supabase.from('cards')` directly — keeps the RPC name and column list in one
 * place if `search_cards` ever changes shape.
 */

export type CatalogLanguage = 'en' | 'ja'

export interface CatalogSearchResult {
  cardId: string
  name: string
  localId: string
  rarity: string | null
  category: string | null
  illustrator: string | null
  imageBaseUrl: string | null
  language: CatalogLanguage
  setId: string
  setName: string
  variantCount: number
}

export interface CatalogSearchPage {
  results: CatalogSearchResult[]
  totalCount: number
}

export interface CatalogVariant {
  id: string
  finish: 'normal' | 'holo' | 'reverse' | 'other'
  stamp: string
  subtype: string
  size: 'standard' | 'oversized'
  isActive: boolean
}

export interface CatalogCard {
  id: string
  name: string
  localId: string
  rarity: string | null
  category: string | null
  illustrator: string | null
  imageBaseUrl: string | null
  language: CatalogLanguage
  setId: string
  setName: string
}

/**
 * Thrown by the auth-retry-wrapped catalog reads when PostgREST reports an error. Extends Error
 * with the same `.message` callers have always seen, while preserving the structured PostgREST
 * `code` that `throw new Error(error.message)` used to discard — the retry classifier in
 * auth-retry.ts needs it to tell a rejected session token (PGRST301) apart from RLS denials,
 * config failures and outages without re-parsing message text. Only the wrapped reads throw
 * this; the unwrapped Card Detail reads keep plain Errors.
 */
export class CatalogQueryError extends Error {
  readonly code: string | null

  constructor(postgrestError: { message: string; code?: string | null }) {
    super(postgrestError.message)
    this.name = 'CatalogQueryError'
    this.code = postgrestError.code ?? null
  }
}

const PAGE_SIZE = 40

export async function searchCards(params: {
  query: string
  language: CatalogLanguage | null
  offset?: number
  limit?: number
}): Promise<CatalogSearchPage> {
  const data = await withAuthRetry(async () => {
    const { data, error } = await supabase.rpc('search_cards', {
      p_query: params.query,
      p_language: params.language ?? undefined,
      p_limit: params.limit ?? PAGE_SIZE,
      p_offset: params.offset ?? 0,
    })
    if (error) throw new CatalogQueryError(error)
    return data
  })

  return {
    results: data.map((row) => ({
      cardId: row.card_id,
      name: row.name,
      localId: row.local_id,
      rarity: row.rarity,
      category: row.category,
      illustrator: row.illustrator,
      imageBaseUrl: row.image_base_url,
      language: row.language as CatalogLanguage,
      setId: row.set_id,
      setName: row.set_name,
      variantCount: row.variant_count,
    })),
    totalCount: data[0]?.total_count ?? 0,
  }
}

export async function getCard(cardId: string): Promise<CatalogCard | null> {
  const { data, error } = await supabase
    .from('cards')
    .select(
      'id, name, local_id, rarity, category, illustrator, image_base_url, language, set_id, card_sets(name)',
    )
    .eq('id', cardId)
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!data) return null

  return {
    id: data.id,
    name: data.name,
    localId: data.local_id,
    rarity: data.rarity,
    category: data.category,
    illustrator: data.illustrator,
    imageBaseUrl: data.image_base_url,
    language: data.language as CatalogLanguage,
    setId: data.set_id,
    setName: data.card_sets.name,
  }
}

export async function getCardVariants(cardId: string): Promise<CatalogVariant[]> {
  const { data, error } = await supabase
    .from('card_variants')
    .select('id, finish, stamp, subtype, size, is_active')
    .eq('card_id', cardId)
    .order('finish')
  if (error) throw new Error(error.message)

  return data.map((row) => ({
    id: row.id,
    finish: row.finish,
    stamp: row.stamp,
    subtype: row.subtype,
    size: row.size,
    isActive: row.is_active,
  }))
}

export interface CatalogVariantWithCard extends CatalogVariant {
  cardId: string
  cardName: string
  localId: string
  imageBaseUrl: string | null
  language: CatalogLanguage
  setName: string
}

/** The single fetch the Add-to-Collection flow needs when it arrives with only a variant id
 *  (e.g. a deep link, or after a page reload) — one request rather than the two CardDetailPage
 *  needs when it already has the card id in the route. */
export async function getCardVariantWithCard(
  variantId: string,
): Promise<CatalogVariantWithCard | null> {
  const { data, error } = await supabase
    .from('card_variants')
    .select(
      'id, finish, stamp, subtype, size, is_active, card_id, cards(name, local_id, image_base_url, language, card_sets(name))',
    )
    .eq('id', variantId)
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!data?.cards) return null

  return {
    id: data.id,
    finish: data.finish,
    stamp: data.stamp,
    subtype: data.subtype,
    size: data.size,
    isActive: data.is_active,
    cardId: data.card_id,
    cardName: data.cards.name,
    localId: data.cards.local_id,
    imageBaseUrl: data.cards.image_base_url,
    language: data.cards.language as CatalogLanguage,
    setName: data.cards.card_sets.name,
  }
}

export interface CatalogSet {
  id: string
  name: string
  language: CatalogLanguage
  releasedOn: string | null
  cardCountOfficial: number | null
  cardCountTotal: number | null
  logoUrl: string | null
  symbolUrl: string | null
}

/** Set search is a plain table read, not an RPC (M7 prompt §14) — `card_sets` already grants
 *  `SELECT` to `authenticated` as ordinary shared-catalog data, so a trigram-backed `ilike` here
 *  needs no new browser-reachable surface. */
export async function searchSets(params: {
  query: string
  language: CatalogLanguage | null
  limit?: number
}): Promise<CatalogSet[]> {
  const data = await withAuthRetry(async () => {
    let query = supabase
      .from('card_sets')
      .select(
        'id, name, language, released_on, card_count_official, card_count_total, logo_url, symbol_url',
      )
      .ilike('name', `%${params.query}%`)
      .order('released_on', { ascending: false, nullsFirst: false })
      .limit(params.limit ?? 40)
    if (params.language) query = query.eq('language', params.language)
    const { data, error } = await query
    if (error) throw new CatalogQueryError(error)
    return data
  })

  return data.map((row) => ({
    id: row.id,
    name: row.name,
    language: row.language as CatalogLanguage,
    releasedOn: row.released_on,
    cardCountOfficial: row.card_count_official,
    cardCountTotal: row.card_count_total,
    logoUrl: setImageUrl(row.logo_url),
    symbolUrl: setImageUrl(row.symbol_url),
  }))
}

/** The Search set showcase (P27: vertical English-only grid, replacing M7.1's carousel): newest
 *  sets first, filtered by language at the source — `card_sets.language` is structured catalog
 *  identity written from the TCGdex endpoint's own language path, never title matching. Pokémon
 *  TCG Pocket is already excluded at ingest time (M5, `serie.id === 'tcgp'`), so nothing here
 *  needs to filter it again. */
export async function listRecentSets(params: {
  language: CatalogLanguage | null
  limit?: number
}): Promise<CatalogSet[]> {
  const data = await withAuthRetry(async () => {
    let query = supabase
      .from('card_sets')
      .select(
        'id, name, language, released_on, card_count_official, card_count_total, logo_url, symbol_url',
      )
      .order('released_on', { ascending: false, nullsFirst: false })
      .limit(params.limit ?? 20)
    if (params.language) query = query.eq('language', params.language)
    const { data, error } = await query
    if (error) throw new CatalogQueryError(error)
    return data
  })

  return data.map((row) => ({
    id: row.id,
    name: row.name,
    language: row.language as CatalogLanguage,
    releasedOn: row.released_on,
    cardCountOfficial: row.card_count_official,
    cardCountTotal: row.card_count_total,
    logoUrl: setImageUrl(row.logo_url),
    symbolUrl: setImageUrl(row.symbol_url),
  }))
}

export async function getSet(setId: string): Promise<CatalogSet | null> {
  const data = await withAuthRetry(async () => {
    const { data, error } = await supabase
      .from('card_sets')
      .select(
        'id, name, language, released_on, card_count_official, card_count_total, logo_url, symbol_url',
      )
      .eq('id', setId)
      .maybeSingle()
    if (error) throw new CatalogQueryError(error)
    return data
  })
  if (!data) return null
  return {
    id: data.id,
    name: data.name,
    language: data.language as CatalogLanguage,
    releasedOn: data.released_on,
    cardCountOfficial: data.card_count_official,
    cardCountTotal: data.card_count_total,
    logoUrl: setImageUrl(data.logo_url),
    symbolUrl: setImageUrl(data.symbol_url),
  }
}

/** Browsing a set's cards (M7 prompt §14: "selecting a set should allow browsing/searching cards
 *  from that set"). Plain table read over `cards`, same privilege shape as `getCard`. */
export async function listCardsInSet(setId: string): Promise<CatalogSearchResult[]> {
  const data = await withAuthRetry(async () => {
    const { data, error } = await supabase
      .from('cards')
      .select(
        'id, name, local_id, rarity, category, illustrator, image_base_url, language, set_id, card_sets(name)',
      )
      .eq('set_id', setId)
      .order('local_id')
    if (error) throw new CatalogQueryError(error)
    return data
  })

  return data.map((row) => ({
    cardId: row.id,
    name: row.name,
    localId: row.local_id,
    rarity: row.rarity,
    category: row.category,
    illustrator: row.illustrator,
    imageBaseUrl: row.image_base_url,
    language: row.language as CatalogLanguage,
    setId: row.set_id,
    setName: row.card_sets.name,
    variantCount: 0,
  }))
}

export type ImageQuality = 'low' | 'high'

/** TCGdex asset CDN convention: `{imageBaseUrl}/{quality}.webp` (docs/API_SOURCES.md). */
export function cardImageUrl(imageBaseUrl: string | null, quality: ImageQuality): string | null {
  if (!imageBaseUrl) return null
  return `${imageBaseUrl}/${quality}.webp`
}

const IMAGE_EXTENSION = /\.(png|webp|jpe?g|gif|avif)$/i

/**
 * Set logo/symbol assets arrive from TCGdex as extension-less CDN paths (`…/logo`, `…/symbol`,
 * symbols under `…/univ/…`), and the asset CDN answers a verbatim request with **404** — probed
 * 2026-08-24: `https://assets.tcgdex.net/en/base/base1/logo` → 404, the same path plus `.png`
 * or `.webp` → 200. That verbatim rendering is exactly why every set tile in the deployed app
 * showed a broken-image frame (P27 owner report). Card images never hit this because
 * `cardImageUrl()` appends the quality segment itself.
 *
 * Appends `.webp` unless a URL already carries an image extension — same CDN behaviour the card
 * path has long relied on, and consistently the smallest variant served. The extension test runs
 * on the path segment only: a query string or fragment stays after the appended suffix
 * (`…/logo?v=2` → `…/logo.webp?v=2`, never `…/logo?v=2.webp`) and cannot defeat the check
 * (`…/logo.png?v=2` stays verbatim). Normalizing at this data boundary rather than only at
 * ingest time also repairs the already-synced catalog rows without re-running the operator-only
 * catalog sync.
 */
export function setImageUrl(url: string | null | undefined): string | null {
  if (!url) return null
  const markerIndex = /[?#]/.exec(url)?.index ?? url.length
  const path = url.slice(0, markerIndex)
  const suffix = url.slice(markerIndex)
  return IMAGE_EXTENSION.test(path) ? url : `${path}.webp${suffix}`
}
