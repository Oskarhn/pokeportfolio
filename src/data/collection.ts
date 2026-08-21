import { supabase } from './supabase-client'
import { parseMinorUnits } from './money'
import type { Database } from './database.types'

/**
 * Thin typed query layer over the user's collection (ARCHITECTURE.md §2's `data/` layer) —
 * holdings, acquisition lots, manual cards, storage locations, tags and manual valuations.
 * Components call these, never `supabase.from(...)` directly. Every money column is cast to text
 * in the select list and parsed with `parseMinorUnits` (src/data/money.ts) — PostgREST serializes
 * `bigint` as a plain JSON number otherwise, which is inexact above 2^53.
 */

export type CardCondition = Database['public']['Enums']['card_condition']
export type Grader = Database['public']['Enums']['grader']
export type GradingState = Database['public']['Enums']['grading_state']
export type HoldingKind = Database['public']['Enums']['holding_kind']
export type LotOrigin = Database['public']['Enums']['lot_origin']
export type CostBasisState = Database['public']['Enums']['cost_basis_state']

export interface HoldingSummary {
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
  quantity: number
  lotCount: number
  variantFinish: 'normal' | 'holo' | 'reverse' | 'other' | null
  variantStamp: string | null
  variantSubtype: string | null
  cardName: string | null
  cardLocalId: string | null
  cardImageBaseUrl: string | null
  cardLanguage: string | null
  cardSetName: string | null
  manualName: string | null
  manualSetName: string | null
  manualCollectorNumber: string | null
  manualLanguage: string | null
}

/** Every generated view column is nullable — Postgres carries no NOT NULL metadata for a view —
 *  even though holding_id/holding_kind/grading_state can never actually be null here: the view
 *  selects them straight from holdings' own NOT NULL columns (20260821120060). A thrown error on
 *  a genuinely malformed row is preferable to a silent non-null assertion. */
function required<T>(value: T | null, column: string): T {
  if (value === null) {
    throw new Error(`holding_summaries.${column} was unexpectedly null`)
  }
  return value
}

function mapHoldingSummary(
  row: Database['public']['Views']['holding_summaries']['Row'],
): HoldingSummary {
  return {
    holdingId: required(row.holding_id, 'holding_id'),
    holdingKind: required(row.holding_kind, 'holding_kind'),
    cardVariantId: row.card_variant_id,
    manualCardId: row.manual_card_id,
    condition: row.condition,
    gradingState: required(row.grading_state, 'grading_state'),
    grader: row.grader,
    grade: row.grade,
    certNumber: row.cert_number,
    isFavorite: row.is_favorite ?? false,
    notes: row.notes,
    quantity: row.quantity ?? 0,
    lotCount: row.lot_count ?? 0,
    variantFinish: row.variant_finish,
    variantStamp: row.variant_stamp,
    variantSubtype: row.variant_subtype,
    cardName: row.card_name,
    cardLocalId: row.card_local_id,
    cardImageBaseUrl: row.card_image_base_url,
    cardLanguage: row.card_language,
    cardSetName: row.card_set_name,
    manualName: row.manual_name,
    manualSetName: row.manual_set_name,
    manualCollectorNumber: row.manual_collector_number,
    manualLanguage: row.manual_language,
  }
}

export async function getHoldingSummary(holdingId: string): Promise<HoldingSummary | null> {
  const { data, error } = await supabase
    .from('holding_summaries')
    .select('*')
    .eq('holding_id', holdingId)
    .maybeSingle()
  if (error) throw new Error(error.message)
  return data ? mapHoldingSummary(data) : null
}

export interface AcquisitionLot {
  id: string
  origin: LotOrigin
  costBasisState: CostBasisState
  acquiredOn: string
  quantity: number
  quantityRemaining: number
  unitCostBasisMinor: bigint | null
  costBasisCurrency: string | null
  storageLocationId: string | null
  storageLocationName: string | null
  notes: string | null
  voidedAt: string | null
  createdAt: string
}

interface AcquisitionLotRow {
  id: string
  origin: LotOrigin
  cost_basis_state: CostBasisState
  acquired_on: string
  quantity: number
  quantity_remaining: number
  unit_cost_basis_minor: string | null
  cost_basis_currency: string | null
  storage_location_id: string | null
  notes: string | null
  voided_at: string | null
  created_at: string
  storage_locations: { name: string } | null
}

export async function getHoldingLots(holdingId: string): Promise<AcquisitionLot[]> {
  const { data, error } = await supabase
    .from('acquisition_lots')
    .select(
      'id, origin, cost_basis_state, acquired_on, quantity, quantity_remaining, unit_cost_basis_minor::text, cost_basis_currency, storage_location_id, notes, voided_at, created_at, storage_locations(name)',
    )
    .eq('holding_id', holdingId)
    .order('acquired_on', { ascending: false })
    .overrideTypes<AcquisitionLotRow[], { merge: false }>()
  if (error) throw new Error(error.message)

  return data.map((row) => ({
    id: row.id,
    origin: row.origin,
    costBasisState: row.cost_basis_state,
    acquiredOn: row.acquired_on,
    quantity: row.quantity,
    quantityRemaining: row.quantity_remaining,
    unitCostBasisMinor:
      row.unit_cost_basis_minor === null ? null : parseMinorUnits(row.unit_cost_basis_minor),
    costBasisCurrency: row.cost_basis_currency,
    storageLocationId: row.storage_location_id,
    storageLocationName: row.storage_locations?.name ?? null,
    notes: row.notes,
    voidedAt: row.voided_at,
    createdAt: row.created_at,
  }))
}

export interface ManualValuation {
  id: string
  valueMinor: bigint
  effectiveFrom: string
  note: string | null
}

interface ManualValuationRow {
  id: string
  value_minor: string
  effective_from: string
  note: string | null
}

export async function getActiveManualValuation(holdingId: string): Promise<ManualValuation | null> {
  const { data, error } = await supabase
    .from('manual_valuations')
    .select('id, value_minor::text, effective_from, note')
    .eq('holding_id', holdingId)
    .is('superseded_at', null)
    .maybeSingle()
    .overrideTypes<ManualValuationRow | null, { merge: false }>()
  if (error) throw new Error(error.message)
  if (!data) return null
  return {
    id: data.id,
    valueMinor: parseMinorUnits(data.value_minor),
    effectiveFrom: data.effective_from,
    note: data.note,
  }
}

export async function setManualValuation(params: {
  holdingId: string
  valueMinor: bigint
  note?: string
  effectiveFrom?: string
}): Promise<void> {
  const { error } = await supabase.rpc('set_manual_valuation', {
    p_holding_id: params.holdingId,
    p_value_minor: Number(params.valueMinor),
    p_note: params.note,
    p_effective_from: params.effectiveFrom,
  })
  if (error) throw new Error(error.message)
}

/** Returns a holding to its automatic resolved value (M9 prompt §37) — supersedes the active
 *  manual valuation without inserting a replacement. History is preserved, never deleted. */
export async function clearManualValuation(holdingId: string): Promise<void> {
  const { error } = await supabase.rpc('clear_manual_valuation', { p_holding_id: holdingId })
  if (error) throw new Error(error.message)
}

export type PriceState = 'manual' | 'fresh' | 'stale' | 'missing'

export interface HoldingValueProvenance {
  priceState: PriceState
  unitValueMinor: bigint | null
  quantity: number
  holdingValueMinor: bigint | null
  provider: 'tcgdex_cardmarket' | 'tcgdex_tcgplayer' | null
  priceKind: string | null
  sourceCurrency: string | null
  sourceValueMinor: bigint | null
  fxRate: number | null
  snapshotDate: string | null
  providerUpdatedAt: string | null
}

interface HoldingValueProvenanceRow {
  price_state: PriceState
  unit_value_nok_minor: string | null
  quantity: string
  holding_value_nok_minor: string | null
  provider: 'tcgdex_cardmarket' | 'tcgdex_tcgplayer' | null
  price_kind: string | null
  source_currency: string | null
  source_value_minor: string | null
  fx_rate: number | null
  snapshot_date: string | null
  provider_updated_at: string | null
}

/** Full FINANCIAL_MODEL.md §6 provenance for one holding — the Holding Detail page's "where did
 *  this number come from" section (prompt §34/§47). Never fabricated: `missing` fields stay null. */
export async function getHoldingValueProvenance(
  holdingId: string,
): Promise<HoldingValueProvenance> {
  const { data, error } = await supabase
    .rpc('get_holding_value_provenance', { p_holding_id: holdingId })
    .single()
    .overrideTypes<HoldingValueProvenanceRow, { merge: false }>()
  if (error) throw new Error(error.message)
  return {
    priceState: data.price_state,
    unitValueMinor:
      data.unit_value_nok_minor === null ? null : parseMinorUnits(data.unit_value_nok_minor),
    quantity: Number(data.quantity),
    holdingValueMinor:
      data.holding_value_nok_minor === null ? null : parseMinorUnits(data.holding_value_nok_minor),
    provider: data.provider,
    priceKind: data.price_kind,
    sourceCurrency: data.source_currency,
    sourceValueMinor:
      data.source_value_minor === null ? null : parseMinorUnits(data.source_value_minor),
    fxRate: data.fx_rate,
    snapshotDate: data.snapshot_date,
    providerUpdatedAt: data.provider_updated_at,
  }
}

export interface ManualCardDefinition {
  id: string
  name: string
  setName: string | null
  collectorNumber: string | null
  language: string | null
  finish: string | null
  stamp: string | null
  subtype: string | null
  notes: string | null
}

export async function getManualCard(id: string): Promise<ManualCardDefinition | null> {
  const { data, error } = await supabase
    .from('manual_card_definitions')
    .select('id, name, set_name, collector_number, language, finish, stamp, subtype, notes')
    .eq('id', id)
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!data) return null
  return {
    id: data.id,
    name: data.name,
    setName: data.set_name,
    collectorNumber: data.collector_number,
    language: data.language,
    finish: data.finish,
    stamp: data.stamp,
    subtype: data.subtype,
    notes: data.notes,
  }
}

export async function createManualCard(input: {
  name: string
  setName?: string
  collectorNumber?: string
  language?: string
  finish?: string
  stamp?: string
  subtype?: string
  notes?: string
}): Promise<ManualCardDefinition> {
  const { data, error } = await supabase
    .from('manual_card_definitions')
    .insert({
      name: input.name,
      set_name: input.setName ?? null,
      collector_number: input.collectorNumber ?? null,
      language: input.language ?? null,
      finish: input.finish ?? null,
      stamp: input.stamp ?? null,
      subtype: input.subtype ?? null,
      notes: input.notes ?? null,
    })
    .select('id, name, set_name, collector_number, language, finish, stamp, subtype, notes')
    .single()
  if (error) throw new Error(error.message)

  return {
    id: data.id,
    name: data.name,
    setName: data.set_name,
    collectorNumber: data.collector_number,
    language: data.language,
    finish: data.finish,
    stamp: data.stamp,
    subtype: data.subtype,
    notes: data.notes,
  }
}

export interface StorageLocation {
  id: string
  name: string
  kind: Database['public']['Enums']['storage_location_kind']
}

export async function listStorageLocations(): Promise<StorageLocation[]> {
  const { data, error } = await supabase
    .from('storage_locations')
    .select('id, name, kind')
    .order('sort_order')
    .order('name')
  if (error) throw new Error(error.message)
  return data
}

export async function createStorageLocation(name: string): Promise<StorageLocation> {
  const { data, error } = await supabase
    .from('storage_locations')
    .insert({ name })
    .select('id, name, kind')
    .single()
  if (error) throw new Error(error.message)
  return data
}

export interface Tag {
  id: string
  name: string
}

export async function listTags(): Promise<Tag[]> {
  const { data, error } = await supabase.from('tags').select('id, name').order('name')
  if (error) throw new Error(error.message)
  return data
}

export async function createTag(name: string): Promise<Tag> {
  const { data, error } = await supabase.from('tags').insert({ name }).select('id, name').single()
  if (error) throw new Error(error.message)
  return data
}

export async function getHoldingTagIds(holdingId: string): Promise<string[]> {
  const { data, error } = await supabase
    .from('holding_tags')
    .select('tag_id')
    .eq('holding_id', holdingId)
  if (error) throw new Error(error.message)
  return data.map((row) => row.tag_id)
}

/** Replaces a holding's tag set. Not atomic across the two statements — acceptable for a purely
 *  organisational join table with no financial consequence (DATA_MODEL.md §5.2.1's C1 reasoning
 *  applies here too: membership changes touch nothing else). */
export async function setHoldingTags(holdingId: string, tagIds: string[]): Promise<void> {
  const { error: deleteError } = await supabase
    .from('holding_tags')
    .delete()
    .eq('holding_id', holdingId)
  if (deleteError) throw new Error(deleteError.message)

  if (tagIds.length === 0) return

  const { error: insertError } = await supabase
    .from('holding_tags')
    .insert(tagIds.map((tagId) => ({ holding_id: holdingId, tag_id: tagId })))
  if (insertError) throw new Error(insertError.message)
}

export async function toggleFavorite(holdingId: string, isFavorite: boolean): Promise<void> {
  const { error } = await supabase
    .from('holdings')
    .update({ is_favorite: isFavorite })
    .eq('id', holdingId)
  if (error) throw new Error(error.message)
}

/** Search's favourite filter (M7.1 prompt §25): "catalog cards corresponding to holdings the user
 *  has marked Favourite" — a direct read of existing favourite state, not a second wishlist
 *  system. Returns the distinct catalog `card_id`s so Search can filter its already-fetched
 *  results client-side; a raw-card holding is the only kind with a `card_variant_id` to trace back
 *  to a catalog card, so graded/manual/sealed favourites are outside what Search can filter on
 *  (Portfolio's own favourite star already covers those directly). */
export async function getFavoritedCardIds(): Promise<Set<string>> {
  const { data, error } = await supabase
    .from('holdings')
    .select('card_variants(card_id)')
    .eq('is_favorite', true)
    .not('card_variant_id', 'is', null)
    .overrideTypes<{ card_variants: { card_id: string } | null }[], { merge: false }>()
  if (error) throw new Error(error.message)
  return new Set(data.flatMap((row) => (row.card_variants ? [row.card_variants.card_id] : [])))
}

/** Bulk favourite/unfavourite for Portfolio select mode (M7.1 prompt §43). One statement, not a
 *  loop — `is_favorite` carries no financial consequence, so a plain `IN (...)` update under RLS
 *  is the correct shape (same reasoning as custom-collection membership, C1). */
export async function bulkSetFavorite(holdingIds: string[], isFavorite: boolean): Promise<void> {
  if (holdingIds.length === 0) return
  const { error } = await supabase
    .from('holdings')
    .update({ is_favorite: isFavorite })
    .in('id', holdingIds)
  if (error) throw new Error(error.message)
}

export async function updateHoldingNotes(holdingId: string, notes: string | null): Promise<void> {
  const { error } = await supabase.from('holdings').update({ notes }).eq('id', holdingId)
  if (error) throw new Error(error.message)
}

export async function updateLotStorageLocation(
  lotId: string,
  storageLocationId: string | null,
): Promise<void> {
  const { error } = await supabase
    .from('acquisition_lots')
    .update({ storage_location_id: storageLocationId })
    .eq('id', lotId)
  if (error) throw new Error(error.message)
}

export async function updateLotAcquiredOn(lotId: string, acquiredOn: string): Promise<void> {
  const { error } = await supabase
    .from('acquisition_lots')
    .update({ acquired_on: acquiredOn })
    .eq('id', lotId)
  if (error) throw new Error(error.message)
}

export async function voidAcquisitionLot(lotId: string, reason?: string): Promise<void> {
  const { error } = await supabase.rpc('void_acquisition_lot', {
    p_lot_id: lotId,
    p_reason: reason,
  })
  if (error) throw new Error(error.message)
}

export interface RemoveHoldingsResult {
  holdingId: string
  blocked: boolean
  blockedReason: string | null
  physicalCount: number
}

interface RemoveHoldingsRow {
  holding_id: string
  blocked: boolean
  blocked_reason: string | null
  physical_count: number
}

/** Portfolio select mode's "Remove from Portfolio" (M8.1). Atomic and all-or-nothing: if any
 *  selected holding is blocked, nothing is voided and every row reports why — see
 *  remove_holdings_from_portfolio (20260825120000_m81_void_acquisition_lot_fix.sql) and
 *  DECISIONS.md D-051. */
export async function removeHoldingsFromPortfolio(
  holdingIds: string[],
): Promise<RemoveHoldingsResult[]> {
  if (holdingIds.length === 0) return []
  const { data, error } = await supabase
    .rpc('remove_holdings_from_portfolio', { p_holding_ids: holdingIds })
    .overrideTypes<RemoveHoldingsRow[], { merge: false }>()
  if (error) throw new Error(error.message)
  return data.map((row) => ({
    holdingId: row.holding_id,
    blocked: row.blocked,
    blockedReason: row.blocked_reason,
    physicalCount: row.physical_count,
  }))
}

export interface AddCardAcquisitionInput {
  cardVariantId?: string
  manualCardId?: string
  gradingState: GradingState
  condition?: CardCondition
  grader?: Grader
  grade?: number
  certNumber?: string
  isFavorite?: boolean
  holdingNotes?: string
  origin: LotOrigin
  costBasisState: CostBasisState
  /** Per-unit cost in minor units (øre), NOK only — see 20260821120050_m6_add_card_acquisition.sql. */
  unitCostBasisMinor?: bigint
  quantity: number
  acquiredOn: string
  storageLocationId?: string
  lotNotes?: string
  manualValueMinor?: bigint
}

export interface AddCardAcquisitionResult {
  holdingId: string
  lotId: string
}

export async function addCardAcquisition(
  input: AddCardAcquisitionInput,
): Promise<AddCardAcquisitionResult> {
  const { data, error } = await supabase
    .rpc('add_card_acquisition', {
      p_card_variant_id: input.cardVariantId,
      p_manual_card_id: input.manualCardId,
      p_grading_state: input.gradingState,
      p_condition: input.condition,
      p_grader: input.grader,
      p_grade: input.grade,
      p_cert_number: input.certNumber,
      p_is_favorite: input.isFavorite,
      p_holding_notes: input.holdingNotes,
      p_origin: input.origin,
      p_cost_basis_state: input.costBasisState,
      p_unit_cost_basis_minor:
        input.unitCostBasisMinor === undefined ? undefined : Number(input.unitCostBasisMinor),
      p_quantity: input.quantity,
      p_acquired_on: input.acquiredOn,
      p_storage_location_id: input.storageLocationId,
      p_lot_notes: input.lotNotes,
      p_manual_value_minor:
        input.manualValueMinor === undefined ? undefined : Number(input.manualValueMinor),
    })
    .single()
  if (error) throw new Error(error.message)
  return { holdingId: data.holding_id, lotId: data.lot_id }
}
