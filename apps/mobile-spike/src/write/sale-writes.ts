import type { Json } from '@shared/data/database.types'
import type { LeasedWriteDb } from './leased-write-client'
import { optionalMoneyArg, serializeMinorUnits } from './money-wire'
import { parseMinorUnitsWire } from '../money/wire'

/**
 * The single write seam's sale-ledger RPC caller (P175), typed like the unreleased web
 * `src/data/sales.ts`. One or many lot lines in one sale (the RPC and the mission both allow it);
 * a lot with UNKNOWN cost basis is sold exactly the same way as a known one — the server alone
 * decides `realized_result_nok_minor` (null for unknown, a signed value for known), never the
 * client. `update_sale`/`void_sale` are NOT implemented here — see purchase-writes.ts's header for
 * why (P175 scope: create flows first).
 */

export type FxSource = 'norges_bank' | 'manual'

export interface SaleLineInput {
  lotId: string
  quantity: number
  /** Money the buyer paid for this line, per unit — never the seller's cost. */
  unitGrossMinor: bigint
}

export interface SaleWriteInput {
  soldOn: string
  currency: string
  marketplace?: string
  feesMinor?: bigint
  shippingCostMinor?: bigint
  shippingChargedMinor?: bigint
  fxRateToNok?: string
  fxRateDate?: string
  fxSource?: FxSource
  notes?: string
}

export interface Sale {
  id: string
  soldOn: string
  currency: string
  grossMinor: bigint
  feesMinor: bigint
  shippingCostMinor: bigint
  shippingChargedMinor: bigint
  netProceedsMinor: bigint
  netProceedsNokMinor: bigint
  /** Null exactly when every sold line's lot has an unknown cost basis (never a fabricated 0). */
  realizedResultNokMinor: bigint | null
  proceedsFromUncostedNokMinor: bigint
  notes: string | null
}

const SALE_COLUMNS =
  'id, sold_on, currency, gross_minor::text, fees_minor::text, shipping_cost_minor::text, ' +
  'shipping_charged_minor::text, net_proceeds_minor::text, net_proceeds_nok_minor::text, ' +
  'realized_result_nok_minor::text, proceeds_from_uncosted_nok_minor::text, notes'

interface SaleRow {
  id: string
  sold_on: string
  currency: string
  gross_minor: string
  fees_minor: string
  shipping_cost_minor: string
  shipping_charged_minor: string
  net_proceeds_minor: string
  net_proceeds_nok_minor: string
  realized_result_nok_minor: string | null
  proceeds_from_uncosted_nok_minor: string
  notes: string | null
}

function requiredMinor(value: string, field: string): bigint {
  const parsed = parseMinorUnitsWire(value, field)
  if (parsed === null) throw new Error(`${field} was unexpectedly null`)
  return parsed
}

function mapSale(row: SaleRow): Sale {
  return {
    id: row.id,
    soldOn: row.sold_on,
    currency: row.currency,
    grossMinor: requiredMinor(row.gross_minor, 'gross_minor'),
    feesMinor: requiredMinor(row.fees_minor, 'fees_minor'),
    shippingCostMinor: requiredMinor(row.shipping_cost_minor, 'shipping_cost_minor'),
    shippingChargedMinor: requiredMinor(row.shipping_charged_minor, 'shipping_charged_minor'),
    netProceedsMinor: requiredMinor(row.net_proceeds_minor, 'net_proceeds_minor'),
    netProceedsNokMinor: requiredMinor(row.net_proceeds_nok_minor, 'net_proceeds_nok_minor'),
    realizedResultNokMinor:
      row.realized_result_nok_minor === null
        ? null
        : parseMinorUnitsWire(row.realized_result_nok_minor, 'realized_result_nok_minor'),
    proceedsFromUncostedNokMinor: requiredMinor(
      row.proceeds_from_uncosted_nok_minor,
      'proceeds_from_uncosted_nok_minor',
    ),
    notes: row.notes,
  }
}

export async function createSale(
  lines: SaleLineInput[],
  input: SaleWriteInput,
  idempotencyKey: string,
  db: LeasedWriteDb,
): Promise<Sale> {
  const { data, error } = await db
    .rpc('create_sale', {
      p_sold_on: input.soldOn,
      p_currency: input.currency,
      p_lines: lines.map((line): Json => ({
        lot_id: line.lotId,
        quantity: line.quantity,
        unit_gross_minor: serializeMinorUnits(line.unitGrossMinor),
      })),
      p_idempotency_key: idempotencyKey,
      p_marketplace: input.marketplace,
      p_fees_minor: optionalMoneyArg(input.feesMinor),
      p_shipping_cost_minor: optionalMoneyArg(input.shippingCostMinor),
      p_shipping_charged_minor: optionalMoneyArg(input.shippingChargedMinor),
      p_fx_rate_to_nok: input.fxRateToNok,
      p_fx_rate_date: input.fxRateDate,
      p_fx_source: input.fxSource,
      p_notes: input.notes,
    })
    .select(SALE_COLUMNS)
    .single()
    .overrideTypes<SaleRow, { merge: false }>()
  if (error) throw new Error(error.message)
  return mapSale(data)
}
