import { supabase } from './supabase-client'
import { parseMinorUnits } from './money'
import type { Database } from './database.types'
import type { CardCondition, GradingState, Grader, HoldingKind } from './collection'

/**
 * The Portfolio's sort/filter/keyset-paginated browsing surface (M7). Thin typed wrapper over the
 * `list_portfolio`/`portfolio_counts` RPCs (supabase/migrations/20260822120010_m7_portfolio_query.sql)
 * — see that file for why this is keyset, not offset, and why a raw-card "value" is honestly NULL
 * before M9. Components call these, never `supabase.rpc(...)` directly.
 */

export type PortfolioSortOrder = Database['public']['Enums']['portfolio_sort_order']

export const SORT_LABEL: Record<PortfolioSortOrder, string> = {
  value_desc: 'Value: high to low',
  value_asc: 'Value: low to high',
  set_asc: 'Set',
  name_asc: 'Name: A to Z',
  name_desc: 'Name: Z to A',
  quantity_desc: 'Quantity: high to low',
  acquired_newest: 'Acquired: newest first',
  acquired_oldest: 'Acquired: oldest first',
  added_newest: 'Newest added',
  added_oldest: 'Oldest added',
}

/** Order matches the visible "Sort by" menu (M7 prompt §31). `value_desc` first — the intended
 *  permanent default — then the rest grouped by what they sort on. */
export const SORT_OPTIONS: PortfolioSortOrder[] = [
  'value_desc',
  'value_asc',
  'set_asc',
  'name_asc',
  'name_desc',
  'quantity_desc',
  'acquired_newest',
  'acquired_oldest',
  'added_newest',
  'added_oldest',
]

export interface PortfolioTile {
  holdingId: string
  holdingKind: HoldingKind
  cardVariantId: string | null
  manualCardId: string | null
  condition: CardCondition | null
  gradingState: GradingState
  grader: Grader | null
  grade: number | null
  certNumber: string | null
  isFavorite: boolean
  notes: string | null
  createdAt: string
  quantity: number
  lotCount: number
  variantFinish: 'normal' | 'holo' | 'reverse' | 'other' | null
  variantStamp: string | null
  variantSubtype: string | null
  cardName: string | null
  cardLocalId: string | null
  cardImageBaseUrl: string | null
  cardLanguage: string | null
  cardSetId: string | null
  cardSetName: string | null
  manualName: string | null
  manualSetName: string | null
  manualCollectorNumber: string | null
  manualLanguage: string | null
  /** Known only for a graded holding with an active manual valuation (M6). NULL for every raw
   *  card until M9 — never a fabricated value, never the acquisition cost. */
  resolvedValueMinor: bigint | null
  acquiredOnMin: string | null
  acquiredOnMax: string | null
  hasMultipleStorageLocations: boolean
}

export function portfolioDisplayName(tile: PortfolioTile): string {
  return tile.cardName ?? tile.manualName ?? 'Unknown card'
}

export function portfolioSubtitle(tile: PortfolioTile): string {
  const setName = tile.cardSetName ?? tile.manualSetName
  const number = tile.cardLocalId ?? tile.manualCollectorNumber
  if (setName && number) return `${setName} · #${number}`
  return setName ?? (number ? `#${number}` : '')
}

/** The last row of the previous page, carried back verbatim as the next page's cursor — the
 *  fields the active sort actually needs are read server-side; the rest are ignored. */
export interface PortfolioCursor {
  holdingId: string
  name: string
  setName: string
  quantity: number
  acquiredOn: string | null
  addedAt: string
  valueMinor: bigint | null
  hasValue: boolean
}

export function cursorFromTile(tile: PortfolioTile): PortfolioCursor {
  return {
    holdingId: tile.holdingId,
    name: portfolioDisplayName(tile),
    setName: tile.cardSetName ?? tile.manualSetName ?? '',
    quantity: tile.quantity,
    acquiredOn: tile.acquiredOnMax ?? tile.acquiredOnMin,
    addedAt: tile.createdAt,
    valueMinor: tile.resolvedValueMinor,
    hasValue: tile.resolvedValueMinor !== null,
  }
}

export interface PortfolioFilters {
  query?: string
  setId?: string
  condition?: CardCondition
  graded?: boolean
  grader?: Grader
  favorite?: boolean
  language?: string
  manualOnly?: boolean
  customCollectionId?: string
  storageLocationId?: string
  tagId?: string
  lowValue?: boolean
  missingValue?: boolean
}

export interface PortfolioPage {
  results: PortfolioTile[]
  nextCursor: PortfolioCursor | null
}

interface ListPortfolioRow {
  holding_id: string
  holding_kind: HoldingKind
  card_variant_id: string | null
  manual_card_id: string | null
  condition: CardCondition | null
  grading_state: GradingState
  grader: Grader | null
  grade: number | null
  cert_number: string | null
  is_favorite: boolean
  notes: string | null
  created_at: string
  quantity: number
  lot_count: number
  variant_finish: 'normal' | 'holo' | 'reverse' | 'other' | null
  variant_stamp: string | null
  variant_subtype: string | null
  card_name: string | null
  card_local_id: string | null
  card_image_base_url: string | null
  card_language: string | null
  card_set_id: string | null
  card_set_name: string | null
  manual_name: string | null
  manual_set_name: string | null
  manual_collector_number: string | null
  manual_language: string | null
  resolved_value_nok_minor: string | null
  acquired_on_min: string | null
  acquired_on_max: string | null
  has_multiple_storage_locations: boolean | null
}

function mapRow(row: ListPortfolioRow): PortfolioTile {
  return {
    holdingId: row.holding_id,
    holdingKind: row.holding_kind,
    cardVariantId: row.card_variant_id,
    manualCardId: row.manual_card_id,
    condition: row.condition,
    gradingState: row.grading_state,
    grader: row.grader,
    grade: row.grade,
    certNumber: row.cert_number,
    isFavorite: row.is_favorite,
    notes: row.notes,
    createdAt: row.created_at,
    quantity: row.quantity,
    lotCount: row.lot_count,
    variantFinish: row.variant_finish,
    variantStamp: row.variant_stamp,
    variantSubtype: row.variant_subtype,
    cardName: row.card_name,
    cardLocalId: row.card_local_id,
    cardImageBaseUrl: row.card_image_base_url,
    cardLanguage: row.card_language,
    cardSetId: row.card_set_id,
    cardSetName: row.card_set_name,
    manualName: row.manual_name,
    manualSetName: row.manual_set_name,
    manualCollectorNumber: row.manual_collector_number,
    manualLanguage: row.manual_language,
    resolvedValueMinor:
      row.resolved_value_nok_minor === null ? null : parseMinorUnits(row.resolved_value_nok_minor),
    acquiredOnMin: row.acquired_on_min,
    acquiredOnMax: row.acquired_on_max,
    hasMultipleStorageLocations: row.has_multiple_storage_locations ?? false,
  }
}

const PAGE_SIZE = 30

export async function listPortfolio(params: {
  sort: PortfolioSortOrder
  filters?: PortfolioFilters
  cursor?: PortfolioCursor | null
  limit?: number
}): Promise<PortfolioPage> {
  const limit = params.limit ?? PAGE_SIZE
  const f = params.filters ?? {}
  const cursor = params.cursor ?? null

  const { data, error } = await supabase
    .rpc('list_portfolio', {
      p_sort: params.sort,
      p_limit: limit,
      p_query: f.query || undefined,
      p_set_id: f.setId,
      p_condition: f.condition,
      p_graded: f.graded,
      p_grader: f.grader,
      p_favorite: f.favorite,
      p_language: f.language,
      p_manual_only: f.manualOnly,
      p_custom_collection_id: f.customCollectionId,
      p_storage_location_id: f.storageLocationId,
      p_tag_id: f.tagId,
      p_low_value: f.lowValue,
      p_missing_value: f.missingValue,
      p_cursor_holding_id: cursor?.holdingId,
      p_cursor_name: cursor?.name,
      p_cursor_set_name: cursor?.setName,
      p_cursor_quantity: cursor?.quantity,
      p_cursor_acquired_on: cursor?.acquiredOn ?? undefined,
      p_cursor_added_at: cursor?.addedAt,
      p_cursor_value_minor: cursor?.valueMinor === null ? undefined : Number(cursor?.valueMinor),
      p_cursor_has_value: cursor?.hasValue,
    })
    .overrideTypes<ListPortfolioRow[], { merge: false }>()
  if (error) throw new Error(error.message)

  const results = data.map(mapRow)
  const last = results.at(-1)
  const nextCursor = results.length === limit && last ? cursorFromTile(last) : null
  return { results, nextCursor }
}

export interface PortfolioCounts {
  physicalCardCount: number
  uniqueHoldingCount: number
  gradedCount: number
  manualCount: number
}

interface PortfolioCountsRow {
  physical_card_count: string
  unique_holding_count: string
  graded_count: string
  manual_count: string
}

export async function getPortfolioCounts(): Promise<PortfolioCounts> {
  const { data, error } = await supabase
    .rpc('portfolio_counts')
    .single()
    .overrideTypes<PortfolioCountsRow, { merge: false }>()
  if (error) throw new Error(error.message)
  return {
    physicalCardCount: Number(data.physical_card_count),
    uniqueHoldingCount: Number(data.unique_holding_count),
    gradedCount: Number(data.graded_count),
    manualCount: Number(data.manual_count),
  }
}
