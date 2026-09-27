import type {
  CardCondition,
  CostBasisState,
  GradingState,
  Grader,
  LotOrigin,
  SealedIntent,
} from '@shared/data/collection'
import type { LeasedWriteDb } from './leased-write-client'
import { moneyArg, optionalMoneyArg } from './money-wire'

/**
 * The single write seam's RPC callers for the collection ledger (P175), typed and wired exactly
 * like the unreleased web `src/data/collection.ts` (branch fix/p149-auth-refresh-failure-recovery
 * onward): every money argument goes through `moneyArg`/`optionalMoneyArg` (decimal string, never
 * `Number()`), and every call takes an explicit {@link LeasedWriteDb} instead of an ambient client,
 * so a write can never be issued without first going through `write/leased-write-client.ts`'s
 * identity check.
 */

export interface AddCardAcquisitionInput {
  cardVariantId?: string
  manualCardId?: string
  sealedProductId?: string
  gradingState: GradingState
  condition?: CardCondition
  grader?: Grader
  grade?: number
  certNumber?: string
  isFavorite?: boolean
  holdingNotes?: string
  origin: LotOrigin
  costBasisState: CostBasisState
  /** Per-unit cost in minor units. Present only when `costBasisState === 'known'`; omitted (never
   *  `0n`) otherwise — an unknown cost stays unknown on the wire, not zero. */
  unitCostBasisMinor?: bigint
  quantity: number
  acquiredOn: string
  storageLocationId?: string
  lotNotes?: string
  manualValueMinor?: bigint
  sealedIntent?: SealedIntent
  clientRequestKey?: string
}

export interface AddCardAcquisitionResult {
  holdingId: string
  lotId: string
}

export async function addCardAcquisition(
  input: AddCardAcquisitionInput,
  db: LeasedWriteDb,
): Promise<AddCardAcquisitionResult> {
  const { data, error } = await db
    .rpc('add_card_acquisition', {
      p_card_variant_id: input.cardVariantId,
      p_manual_card_id: input.manualCardId,
      p_sealed_product_id: input.sealedProductId,
      p_grading_state: input.gradingState,
      p_condition: input.condition,
      p_grader: input.grader,
      p_grade: input.grade,
      p_cert_number: input.certNumber,
      p_is_favorite: input.isFavorite,
      p_holding_notes: input.holdingNotes,
      p_origin: input.origin,
      p_cost_basis_state: input.costBasisState,
      p_unit_cost_basis_minor: optionalMoneyArg(input.unitCostBasisMinor),
      p_quantity: input.quantity,
      p_acquired_on: input.acquiredOn,
      p_storage_location_id: input.storageLocationId,
      p_lot_notes: input.lotNotes,
      p_manual_value_minor: optionalMoneyArg(input.manualValueMinor),
      p_sealed_intent: input.sealedIntent,
      p_client_request_key: input.clientRequestKey ?? undefined,
    })
    .single()
  if (error) throw new Error(error.message)
  return { holdingId: data.holding_id, lotId: data.lot_id }
}

export interface SetManualValuationParams {
  holdingId: string
  /** An explicit amount, including an explicit `0`. To CLEAR a manual valuation (return the
   *  holding to its automatic resolved value) call {@link clearManualValuation} instead — the two
   *  are never conflated: clearing is NOT the same request as setting zero. */
  valueMinor: bigint
  note?: string
  effectiveFrom?: string
}

export async function setManualValuation(
  params: SetManualValuationParams,
  db: LeasedWriteDb,
): Promise<void> {
  const { error } = await db
    .rpc('set_manual_valuation', {
      p_holding_id: params.holdingId,
      p_value_minor: moneyArg(params.valueMinor),
      p_note: params.note,
      p_effective_from: params.effectiveFrom,
    })
    // Only the id: the function returns the whole manual_valuations row (value_minor is bigint,
    // which would otherwise cross the wire as an inexact JSON number above 2^53).
    .select('id')
  if (error) throw new Error(error.message)
}

export async function clearManualValuation(holdingId: string, db: LeasedWriteDb): Promise<void> {
  const { error } = await db.rpc('clear_manual_valuation', { p_holding_id: holdingId })
  if (error) throw new Error(error.message)
}
