import { getHoldingLots } from '@shared/data/collection'

/**
 * A read-only projection of one holding's lots for the write screens (Record sale, Record opening):
 * which lots exist, how much of each is still owned, and — for a sealed holding — whether it can be
 * opened. Reused unchanged from the web's released data layer through the `@shared` alias, exactly
 * like `collection/shared-data-adapter.ts` reuses `getHoldingSummary`/`getHoldingValueProvenance`;
 * this file exists only to slim the ~13-field `AcquisitionLot` down to what a write form needs.
 */
export interface WritableLot {
  lotId: string
  quantityRemaining: number
  /** Known per-unit cost, or null when the lot's cost basis is unknown (never a fabricated 0). */
  unitCostBasisMinor: bigint | null
  /** Non-null only for a sealed-product lot (Record opening filters on this). */
  sealedIntent: string | null
  acquiredOn: string
}

export async function listWritableLots(holdingId: string): Promise<WritableLot[]> {
  const lots = await getHoldingLots(holdingId)
  return lots
    .filter((lot) => lot.voidedAt === null && lot.quantityRemaining > 0)
    .map((lot) => ({
      lotId: lot.id,
      quantityRemaining: lot.quantityRemaining,
      unitCostBasisMinor: lot.unitCostBasisMinor,
      sealedIntent: lot.sealedIntent,
      acquiredOn: lot.acquiredOn,
    }))
}
