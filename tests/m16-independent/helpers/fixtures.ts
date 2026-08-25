/**
 * Fixture builders for the DB-backed M16 contract suites.
 *
 * Everything seeded here is synthetic (`.invalid` users, invented products).
 * Seeding uses ONLY surfaces that exist on CURRENT main (create_purchase,
 * purchase_spending_summary, direct service-role inserts where no RPC shape
 * exists) so the gated suites stay valid regardless of how M16's own write
 * surface evolves — the implementation under test is reached exclusively
 * through helpers/contract.ts's discovered bindings.
 */

import type { TestClient } from '../../db/setup'

export interface SpendSummary {
  gpoNokMinor: bigint
  csNokMinor: bigint
  hsNokMinor: bigint
  purchaseCount: number
}

/** Money leaves these RPCs as text (PostgREST bigint boundary) — parse exactly. */
export async function spendSummary(client: TestClient): Promise<SpendSummary> {
  const { data, error } = await client.rpc('purchase_spending_summary').single<{
    gpo_nok_minor: string
    cs_nok_minor: string
    hs_nok_minor: string
    purchase_count: number
  }>()
  if (error || !data) throw new Error(`purchase_spending_summary failed: ${error?.message}`)
  return {
    gpoNokMinor: BigInt(data.gpo_nok_minor),
    csNokMinor: BigInt(data.cs_nok_minor),
    hsNokMinor: BigInt(data.hs_nok_minor),
    purchaseCount: data.purchase_count,
  }
}

/** Stable M6 RPC — used to give sealed holdings a real manual valuation for timeline cases. */
export async function setManualValuation(
  client: TestClient,
  options: { holdingId: string; valueMinor: bigint; effectiveFrom: string; note?: string },
): Promise<void> {
  const { error } = await client.rpc('set_manual_valuation', {
    p_holding_id: options.holdingId,
    p_value_minor: options.valueMinor,
    p_note: options.note ?? null,
    p_effective_from: options.effectiveFrom,
  })
  if (error) throw new Error(`set_manual_valuation failed: ${error.message}`)
}

/** A user-created sealed product row (curated seed is shared; isolation needs own rows). */
export async function createIsolatedSealedProduct(
  service: TestClient,
  createdByUserId: string,
  label: string,
): Promise<string> {
  const { data, error } = await service
    .from('sealed_products')
    .insert({
      name: `m16adv-${label}-${crypto.randomUUID()}`,
      language: 'en',
      product_type: 'booster_pack',
      created_by_user_id: createdByUserId,
    })
    .select('id')
    .single<{ id: string }>()
  if (error || !data) throw new Error(`failed to create sealed product: ${error?.message}`)
  return data.id
}

export interface SealedPurchase {
  purchaseId: string
  lotId: string
  quantityRemaining: number
  unitCostBasisNokMinor: number | null
  residualNokMinor: number
}

interface LotRow {
  id: string
  quantity: number
  quantity_remaining: number
  unit_cost_basis_nok_minor: number | null
  residual_nok_minor: number
  cost_basis_state: string
  origin: string
  holding_id: string
}

/**
 * One sealed purchase line: quantity × unit_price, NOK, optional discount.
 * Returns the single acquisition lot the line produced.
 */
export async function createSealedPurchase(
  client: TestClient,
  service: TestClient,
  options: {
    productId: string
    quantity: number
    unitPriceMinor: number
    purchasedOn?: string
    discountMinor?: number
  },
): Promise<SealedPurchase> {
  const { data: purchase, error } = await client
    .rpc('create_purchase', {
      p_purchased_on: options.purchasedOn ?? new Date().toISOString().slice(0, 10),
      p_currency: 'NOK',
      p_discount_minor: options.discountMinor ?? 0,
      p_lines: [
        {
          line_type: 'sealed',
          sealed_product_id: options.productId,
          quantity: options.quantity,
          unit_price_minor: options.unitPriceMinor,
        },
      ],
    })
    .single<{ id: string }>()
  if (error || !purchase) throw new Error(`create_purchase failed: ${error?.message}`)

  const lines = await service
    .from('purchase_lines')
    .select('id')
    .eq('purchase_id', purchase.id)
    .single<{ id: string }>()
  if (lines.error || !lines.data) throw new Error(`purchase line missing: ${lines.error?.message}`)

  const { data: lot, error: lotError } = await service
    .from('acquisition_lots')
    .select(
      'id, quantity, quantity_remaining, unit_cost_basis_nok_minor, residual_nok_minor, cost_basis_state, origin, holding_id',
    )
    .eq('purchase_line_id', lines.data.id)
    .single<LotRow>()
  if (lotError || !lot) throw new Error(`lot missing: ${lotError?.message}`)

  return {
    purchaseId: purchase.id,
    lotId: lot.id,
    quantityRemaining: lot.quantity_remaining,
    unitCostBasisNokMinor: lot.unit_cost_basis_nok_minor,
    residualNokMinor: lot.residual_nok_minor,
  }
}

export async function lotById(service: TestClient, lotId: string): Promise<LotRow> {
  const { data, error } = await service
    .from('acquisition_lots')
    .select(
      'id, quantity, quantity_remaining, unit_cost_basis_nok_minor, residual_nok_minor, cost_basis_state, origin, holding_id',
    )
    .eq('id', lotId)
    .single<LotRow>()
  if (error || !data) throw new Error(`failed to read lot: ${error?.message}`)
  return data
}

/**
 * A gifted (not_paid) sealed lot, built directly against the CURRENT schema:
 * holdings + acquisition_lots with origin='gift' / cost_basis_state='not_paid'.
 * The origin↔state consistency constraint enforces the NULL basis; no purchase
 * row exists, which is precisely the point for §7's unknown-cost oracle.
 */
export async function createGiftedSealedLot(
  service: TestClient,
  ownerId: string,
  productId: string,
  quantity: number,
): Promise<{ holdingId: string; lotId: string }> {
  const { data: holding, error: holdingError } = await service
    .from('holdings')
    .insert({
      user_id: ownerId,
      holding_kind: 'sealed',
      sealed_product_id: productId,
      grading_state: 'raw',
    })
    .select('id')
    .single<{ id: string }>()
  if (holdingError || !holding) {
    throw new Error(`failed to create gifted sealed holding: ${holdingError?.message}`)
  }

  const { data: lot, error: lotError } = await service
    .from('acquisition_lots')
    .insert({
      user_id: ownerId,
      holding_id: holding.id,
      origin: 'gift',
      cost_basis_state: 'not_paid',
      acquired_on: new Date().toISOString().slice(0, 10),
      quantity,
      quantity_remaining: quantity,
    })
    .select('id')
    .single<{ id: string }>()
  if (lotError || !lot) throw new Error(`failed to create gifted sealed lot: ${lotError?.message}`)

  return { holdingId: holding.id, lotId: lot.id }
}

export interface DisposalRow {
  id: string
  lot_id: string
  kind: string
  quantity: number
  disposed_on: string
  opening_id: string | null
  cost_basis_at_disposal_nok_minor: number | null
  voided_at: string | null
}

export async function disposalsForLot(client: TestClient, lotId: string): Promise<DisposalRow[]> {
  const { data, error } = await client
    .from('lot_disposals')
    .select(
      'id, lot_id, kind, quantity, disposed_on, opening_id, cost_basis_at_disposal_nok_minor, voided_at',
    )
    .eq('lot_id', lotId)
    .order('created_at')
  if (error) throw new Error(`failed to read disposals: ${error.message}`)
  return data as DisposalRow[]
}

export interface PullLotRow {
  id: string
  holding_id: string
  origin: string
  cost_basis_state: string
  unit_cost_basis_minor: number | null
  unit_cost_basis_nok_minor: number | null
  opening_id: string | null
  quantity: number
  quantity_remaining: number
  acquired_on: string
  voided_at: string | null
}

const PULL_COLUMNS =
  'id, holding_id, origin, cost_basis_state, unit_cost_basis_minor, unit_cost_basis_nok_minor, opening_id, quantity, quantity_remaining, acquired_on, voided_at'

export async function pullLotsForOpening(
  client: TestClient,
  openingId: string,
): Promise<PullLotRow[]> {
  const { data, error } = await client
    .from('acquisition_lots')
    .select(PULL_COLUMNS)
    .eq('opening_id', openingId)
    .order('created_at')
  if (error) throw new Error(`failed to read pull lots: ${error.message}`)
  return data as PullLotRow[]
}

export async function countRows(
  client: TestClient,
  table: string,
  column: string,
  equals: string,
): Promise<number> {
  const { count, error } = await client
    .from(table)
    .select('*', { count: 'exact', head: true })
    .eq(column, equals)
  if (error) throw new Error(`count failed on ${table}: ${error.message}`)
  return count ?? 0
}

// ---------------------------------------------------------------------------
// Generic row inspection for implementation-owned shapes (openings rows etc.)
//
// The openings table's column spellings belong to the implementation; these
// helpers read a row as an untyped record and locate contract slots by name
// pattern. Money may arrive as text or number — both parse exactly here.
// ---------------------------------------------------------------------------

export type RowLike = Record<string, unknown>

export function findKey(row: RowLike, pattern: RegExp): string | null {
  const hit = Object.keys(row).find((key) => pattern.test(key))
  return hit ?? null
}

/** Locates a money-ish value by key pattern and returns it as exact bigint (null preserved). */
export function findMoney(row: RowLike, patterns: readonly RegExp[]): bigint | null {
  for (const pattern of patterns) {
    const key = findKey(row, pattern)
    if (!key) continue
    const raw = row[key]
    if (raw === null || raw === undefined) return null
    if (typeof raw === 'number') return BigInt(Math.trunc(raw))
    if (typeof raw === 'string') return BigInt(raw)
  }
  throw new Error(`no money-like key matching ${patterns.map(String).join(' | ')} in row`)
}
