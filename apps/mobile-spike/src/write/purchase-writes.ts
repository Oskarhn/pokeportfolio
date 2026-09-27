import type { Json } from '@shared/data/database.types'
import type { CardCondition, GradingState, Grader, SealedIntent } from '@shared/data/collection'
import type { LeasedWriteDb } from './leased-write-client'
import { optionalMoneyArg, serializeMinorUnits } from './money-wire'
import { parseMinorUnitsWire } from '../money/wire'

/**
 * The single write seam's purchase-ledger RPC callers (P175), typed like the unreleased web
 * `src/data/purchases.ts`. `create_purchase` accepts one or many lines in a single receipt — the
 * mission's "one or multiple lines if the domain supports it cleanly" is this: the RPC and the
 * pure allocator (`@shared/domain/allocation`) already support N lines, so this file does not
 * special-case a single line.
 *
 * `update_purchase` and `void_purchase` are NOT implemented here (P175 scope: create flows first;
 * edit/void deferred — see output_175.txt BLOCKERS). Reading a purchase back is not needed by any
 * P175 screen and is therefore also not ported.
 */

export type LineType = 'card' | 'sealed' | 'accessory' | 'shipping' | 'customs' | 'other'
export type SpendClass = 'collectible' | 'hobby'
export type FxSource = 'norges_bank' | 'manual'

export interface PurchaseLineInput {
  lineType: LineType
  description?: string
  cardVariantId?: string
  manualCardId?: string
  sealedProductId?: string
  sealedIntent?: SealedIntent
  condition?: CardCondition
  gradingState?: GradingState
  grader?: Grader
  grade?: number
  certNumber?: string
  quantity: number
  /** Known unit price in minor units. Required per line — a purchase line's price can never be
   *  unknown (unlike a card's acquisition cost, which can be). */
  unitPriceMinor: bigint
  spendClass?: SpendClass
  storageLocationId?: string
  isFavorite?: boolean
  lotNotes?: string
  manualValueMinor?: bigint
}

function serializeLine(line: PurchaseLineInput): Json {
  return {
    line_type: line.lineType,
    description: line.description,
    card_variant_id: line.cardVariantId,
    manual_card_id: line.manualCardId,
    sealed_product_id: line.sealedProductId,
    sealed_intent: line.sealedIntent,
    condition: line.condition,
    grading_state: line.gradingState,
    grader: line.grader,
    grade: line.grade,
    cert_number: line.certNumber,
    quantity: line.quantity,
    unit_price_minor: serializeMinorUnits(line.unitPriceMinor),
    spend_class: line.spendClass,
    storage_location_id: line.storageLocationId,
    is_favorite: line.isFavorite,
    lot_notes: line.lotNotes,
    manual_value_minor:
      line.manualValueMinor === undefined ? undefined : serializeMinorUnits(line.manualValueMinor),
  }
}

export interface PurchaseWriteInput {
  purchasedOn: string
  currency: string
  lines: PurchaseLineInput[]
  retailerId?: string
  shippingMinor?: bigint
  customsMinor?: bigint
  discountMinor?: bigint
  /** Decimal string, e.g. "11.54000000" — numeric(18,8), never a float. Omit for NOK. */
  fxRateToNok?: string
  fxRateDate?: string
  fxSource?: FxSource
  notes?: string
}

export interface Purchase {
  id: string
  purchasedOn: string
  currency: string
  subtotalMinor: bigint
  shippingMinor: bigint
  customsMinor: bigint
  discountMinor: bigint
  totalMinor: bigint
  totalNokMinor: bigint
  notes: string | null
}

const PURCHASE_COLUMNS =
  'id, purchased_on, currency, subtotal_minor::text, shipping_minor::text, customs_minor::text, ' +
  'discount_minor::text, total_minor::text, total_nok_minor::text, notes'

interface PurchaseRow {
  id: string
  purchased_on: string
  currency: string
  subtotal_minor: string
  shipping_minor: string
  customs_minor: string
  discount_minor: string
  total_minor: string
  total_nok_minor: string
  notes: string | null
}

/** These columns are NOT NULL in the schema; a null here would mean the row shape itself is
 *  broken, which must fail loudly rather than silently becoming a fabricated value. */
function requiredMinor(value: string, field: string): bigint {
  const parsed = parseMinorUnitsWire(value, field)
  if (parsed === null) throw new Error(`${field} was unexpectedly null`)
  return parsed
}

function mapPurchase(row: PurchaseRow): Purchase {
  return {
    id: row.id,
    purchasedOn: row.purchased_on,
    currency: row.currency,
    subtotalMinor: requiredMinor(row.subtotal_minor, 'subtotal_minor'),
    shippingMinor: requiredMinor(row.shipping_minor, 'shipping_minor'),
    customsMinor: requiredMinor(row.customs_minor, 'customs_minor'),
    discountMinor: requiredMinor(row.discount_minor, 'discount_minor'),
    totalMinor: requiredMinor(row.total_minor, 'total_minor'),
    totalNokMinor: requiredMinor(row.total_nok_minor, 'total_nok_minor'),
    notes: row.notes,
  }
}

/**
 * `idempotencyKey`: the caller generates one UUID per fresh form instance
 * (`write/idempotency-key.ts`) and resends the SAME value on any retry of that same attempt. A
 * replay with a key that already produced a purchase returns that purchase unchanged; a same-key
 * replay whose material fields differ is refused by the RPC (P107/P138).
 */
export async function createPurchase(
  input: PurchaseWriteInput,
  idempotencyKey: string,
  db: LeasedWriteDb,
): Promise<Purchase> {
  const { data, error } = await db
    .rpc('create_purchase', {
      p_purchased_on: input.purchasedOn,
      p_currency: input.currency,
      p_lines: input.lines.map(serializeLine),
      p_retailer_id: input.retailerId,
      p_shipping_minor: optionalMoneyArg(input.shippingMinor),
      p_customs_minor: optionalMoneyArg(input.customsMinor),
      p_discount_minor: optionalMoneyArg(input.discountMinor),
      p_fx_rate_to_nok: input.fxRateToNok,
      p_fx_rate_date: input.fxRateDate,
      p_fx_source: input.fxSource,
      p_notes: input.notes,
      p_idempotency_key: idempotencyKey,
    })
    .select(PURCHASE_COLUMNS)
    .single()
    .overrideTypes<PurchaseRow, { merge: false }>()
  if (error) throw new Error(error.message)
  return mapPurchase(data)
}
