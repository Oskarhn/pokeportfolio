import type { LeasedWriteDb } from './leased-write-client'
import { optionalMoneyArg } from './money-wire'
import { parseMinorUnitsWire } from '../money/wire'

/**
 * The single write seam's opening RPC caller (P175), MINIMAL scope by the mission's own allowance
 * ("if integrating this would materially broaden scope, implement the domain/data adapter and a
 * minimal functional form, not a polished wizard"):
 *
 *   - only `create_opening` (opening an ALREADY-OWNED sealed lot) is implemented. It takes no cost
 *     argument at all — the RPC's own doc comment states "Creates no spend" — so the mission's
 *     critical invariant ("opening a sealed item consumes/depletes sealed inventory but is NOT a
 *     second spend") holds by construction, not by anything this file has to enforce.
 *   - `create_opening_from_provisional` (buy-and-open in one RPC call, which ALSO creates a
 *     purchase) is NOT implemented: it would duplicate the whole purchase-flow surface inside the
 *     opening form. Recorded as a scope boundary, not a silent gap (see output_175.txt BLOCKERS).
 *   - pulled-card tracking (`pulls`) is NOT wired: the minimal form always opens with
 *     `trackingCompleteness: 'unknown'`, which needs no catalog-search sub-flow. A caller may still
 *     pass `bulkRemainderEstimateNokMinor`/`bulkRemainderCount` for the untracked-value estimate.
 */

export interface CreateOpeningInput {
  sourceLotId: string
  quantity: number
  openedOn: string
  bulkRemainderEstimateNokMinor?: bigint
  bulkRemainderCount?: number
  notes?: string
  /** Same per-form-instance idempotency contract as `createPurchase`/`createSale`. */
  idempotencyKey?: string
}

export interface Opening {
  id: string
  openedOn: string
  sourceLotId: string
  quantityOpened: number
  /** Null exactly when the source lot's own cost basis was unknown. */
  costNokMinor: bigint | null
  bulkRemainderEstimateNokMinor: bigint | null
  notes: string | null
}

const OPENING_COLUMNS =
  'id, opened_on, source_lot_id, quantity_opened, cost_nok_minor::text, ' +
  'bulk_remainder_estimate_nok_minor::text, notes'

interface OpeningRow {
  id: string
  opened_on: string
  source_lot_id: string
  quantity_opened: number
  cost_nok_minor: string | null
  bulk_remainder_estimate_nok_minor: string | null
  notes: string | null
}

function mapOpening(row: OpeningRow): Opening {
  return {
    id: row.id,
    openedOn: row.opened_on,
    sourceLotId: row.source_lot_id,
    quantityOpened: row.quantity_opened,
    costNokMinor:
      row.cost_nok_minor === null
        ? null
        : parseMinorUnitsWire(row.cost_nok_minor, 'cost_nok_minor'),
    bulkRemainderEstimateNokMinor:
      row.bulk_remainder_estimate_nok_minor === null
        ? null
        : parseMinorUnitsWire(
            row.bulk_remainder_estimate_nok_minor,
            'bulk_remainder_estimate_nok_minor',
          ),
    notes: row.notes,
  }
}

export async function createOpening(
  input: CreateOpeningInput,
  db: LeasedWriteDb,
): Promise<Opening> {
  const { data, error } = await db
    .rpc('create_opening', {
      p_source_lot_id: input.sourceLotId,
      p_quantity: input.quantity,
      p_opened_on: input.openedOn,
      p_tracking_completeness: 'unknown',
      p_pulls: undefined,
      p_bulk_remainder_estimate_nok_minor: optionalMoneyArg(input.bulkRemainderEstimateNokMinor),
      p_bulk_remainder_count: input.bulkRemainderCount,
      p_notes: input.notes,
      p_idempotency_key: input.idempotencyKey,
    })
    .select(OPENING_COLUMNS)
    .single()
    .overrideTypes<OpeningRow, { merge: false }>()
  if (error) throw new Error(error.message)
  return mapOpening(data)
}
