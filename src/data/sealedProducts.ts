import { supabase } from './supabase-client'
import { parseMinorUnits } from './money'
import type { Database } from './database.types'

/**
 * The sealed-product catalog surface (M11) — search/browse, product detail, and the "Add custom
 * sealed product" fallback. Curated rows (created_by_user_id null) and the caller's own custom rows
 * only; RLS (sealed_products_read, 20260817120020_create_catalog_tables.sql) already restricts
 * every query here without any extra predicate — a user can never see another user's custom
 * product through this module (prompt §11/§69).
 */

export type SealedProductType = Database['public']['Enums']['sealed_product_type']

export const SEALED_PRODUCT_TYPE_LABEL: Record<SealedProductType, string> = {
  booster_pack: 'Booster Pack',
  booster_bundle: 'Booster Bundle',
  booster_box: 'Booster Box',
  elite_trainer_box: 'Elite Trainer Box',
  collection_box: 'Collection Box',
  tin: 'Tin',
  blister: 'Blister',
  ultra_premium_collection: 'Ultra-Premium Collection',
  other: 'Other',
}

export const SEALED_PRODUCT_TYPES: SealedProductType[] = [
  'booster_pack',
  'booster_bundle',
  'booster_box',
  'elite_trainer_box',
  'collection_box',
  'tin',
  'blister',
  'ultra_premium_collection',
  'other',
]

export interface SealedProductSummary {
  id: string
  productType: SealedProductType
  name: string
  language: string
  packCount: number | null
  imageUrl: string | null
  setId: string | null
  setName: string | null
  /** True for a user-created catalog entry — never true for a curated row (prompt §12). */
  isCustom: boolean
}

interface SealedProductRow {
  id: string
  product_type: SealedProductType
  name: string
  language: string
  pack_count: number | null
  image_url: string | null
  created_by_user_id: string | null
  card_sets: { id: string; name: string } | null
}

const SELECT_COLUMNS =
  'id, product_type, name, language, pack_count, image_url, created_by_user_id, card_sets(id, name)'

function mapRow(row: SealedProductRow): SealedProductSummary {
  return {
    id: row.id,
    productType: row.product_type,
    name: row.name,
    language: row.language,
    packCount: row.pack_count,
    imageUrl: row.image_url,
    setId: row.card_sets?.id ?? null,
    setName: row.card_sets?.name ?? null,
    isCustom: row.created_by_user_id !== null,
  }
}

const SEARCH_PAGE_SIZE = 30

/** Search's Sealed tab (prompt §50-52). Offset-paginated, not keyset — a sealed catalog is expected
 *  to stay small (prompt §76) unlike the card catalog, so this is intentionally the simpler shape. */
export async function searchSealedProducts(params: {
  query?: string
  productType?: SealedProductType
  setId?: string
  limit?: number
  offset?: number
}): Promise<SealedProductSummary[]> {
  const offset = params.offset ?? 0
  const limit = params.limit ?? SEARCH_PAGE_SIZE

  let query = supabase
    .from('sealed_products')
    .select(SELECT_COLUMNS)
    .order('name')
    .range(offset, offset + limit - 1)

  const trimmed = params.query?.trim()
  if (trimmed) query = query.ilike('name', `%${trimmed}%`)
  if (params.productType) query = query.eq('product_type', params.productType)
  if (params.setId) query = query.eq('set_id', params.setId)

  const { data, error } = await query.overrideTypes<SealedProductRow[], { merge: false }>()
  if (error) throw new Error(error.message)
  return data.map(mapRow)
}

export async function getSealedProduct(id: string): Promise<SealedProductSummary | null> {
  const { data, error } = await supabase
    .from('sealed_products')
    .select(SELECT_COLUMNS)
    .eq('id', id)
    .maybeSingle()
    .overrideTypes<SealedProductRow | null, { merge: false }>()
  if (error) throw new Error(error.message)
  return data ? mapRow(data) : null
}

export interface OwnedSealedSummary {
  holdingId: string
  quantity: number
  unitValueMinor: bigint | null
}

/** "Owned quantity" / "current value where owned" for the sealed product detail page (prompt §53)
 *  — reuses holding_summaries (M6) the same way Holding Detail itself does, joined here to the one
 *  active manual valuation. Null when the caller owns none — never a fabricated zero. */
export async function getOwnedSealedSummary(
  sealedProductId: string,
): Promise<OwnedSealedSummary | null> {
  const { data, error } = await supabase
    .from('holding_summaries')
    .select('holding_id, quantity')
    .eq('sealed_product_id', sealedProductId)
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!data?.holding_id) return null

  const { data: valuation, error: valuationError } = await supabase
    .from('manual_valuations')
    .select('value_minor::text')
    .eq('holding_id', data.holding_id)
    .is('superseded_at', null)
    .maybeSingle()
    .overrideTypes<{ value_minor: string } | null, { merge: false }>()
  if (valuationError) throw new Error(valuationError.message)

  return {
    holdingId: data.holding_id,
    quantity: data.quantity ?? 0,
    unitValueMinor: valuation ? parseMinorUnits(valuation.value_minor) : null,
  }
}

export interface CreateCustomSealedProductInput {
  name: string
  language: string
  productType: SealedProductType
  setId?: string
  packCount?: number
}

/** "Add custom sealed product" (prompt §12-13) — a private catalog gap-filler, visible only to its
 *  creator (sealed_products_read RLS). No image field by design (prompt §13) — the UI shows a
 *  generic per-type placeholder instead; real image upload is a later Images milestone. */
export async function createCustomSealedProduct(
  input: CreateCustomSealedProductInput,
): Promise<SealedProductSummary> {
  const { data: userData, error: userError } = await supabase.auth.getUser()
  if (userError) throw new Error(userError.message)
  const userId = userData.user.id
  if (!userId) throw new Error('not authenticated')

  const { data, error } = await supabase
    .from('sealed_products')
    .insert({
      name: input.name,
      language: input.language,
      product_type: input.productType,
      set_id: input.setId ?? null,
      pack_count: input.packCount ?? null,
      created_by_user_id: userId,
    })
    .select(SELECT_COLUMNS)
    .single()
    .overrideTypes<SealedProductRow, { merge: false }>()
  if (error) throw new Error(error.message)
  return mapRow(data)
}
