import { supabase } from './supabase-client'

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

const PAGE_SIZE = 40

export async function searchCards(params: {
  query: string
  language: CatalogLanguage | null
  offset?: number
  limit?: number
}): Promise<CatalogSearchPage> {
  const { data, error } = await supabase.rpc('search_cards', {
    p_query: params.query,
    p_language: params.language ?? undefined,
    p_limit: params.limit ?? PAGE_SIZE,
    p_offset: params.offset ?? 0,
  })
  if (error) throw new Error(error.message)

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

export type ImageQuality = 'low' | 'high'

/** TCGdex asset CDN convention: `{imageBaseUrl}/{quality}.webp` (docs/API_SOURCES.md). */
export function cardImageUrl(imageBaseUrl: string | null, quality: ImageQuality): string | null {
  if (!imageBaseUrl) return null
  return `${imageBaseUrl}/${quality}.webp`
}
