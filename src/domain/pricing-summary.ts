/**
 * Pure aggregation over a batched search-prices result, grouped by catalog card (M9.1 prompt §7).
 * No Supabase, no React — this is what makes it testable without a live database (the boundary
 * rule in DEVELOPMENT.md §5: `src/domain/` takes data as arguments, never fetches it).
 */

export interface CardPriceCandidate {
  cardId: string
  priceState: 'available' | 'missing'
  valueNokMinor: bigint | null
}

export interface CardPriceSummary {
  variantCount: number
  pricedCount: number
  minValueNokMinor: bigint | null
  maxValueNokMinor: bigint | null
}

/** Groups a batched search-prices result by card: a catalog card can have several variants at
 *  different prices, so a result tile never shows one arbitrary variant's price as "the" price.
 *  `pricedCount < variantCount` is the partial-coverage signal the caller uses to choose
 *  "150 kr" vs "120–220 kr" vs "From 120 kr" — never implying full coverage that isn't real. */
export function summarizeCardPricing(
  results: Iterable<CardPriceCandidate>,
): Map<string, CardPriceSummary> {
  const byCard = new Map<string, CardPriceSummary>()
  for (const r of results) {
    const existing = byCard.get(r.cardId) ?? {
      variantCount: 0,
      pricedCount: 0,
      minValueNokMinor: null,
      maxValueNokMinor: null,
    }
    existing.variantCount += 1
    if (r.priceState === 'available' && r.valueNokMinor !== null) {
      existing.pricedCount += 1
      existing.minValueNokMinor =
        existing.minValueNokMinor === null || r.valueNokMinor < existing.minValueNokMinor
          ? r.valueNokMinor
          : existing.minValueNokMinor
      existing.maxValueNokMinor =
        existing.maxValueNokMinor === null || r.valueNokMinor > existing.maxValueNokMinor
          ? r.valueNokMinor
          : existing.maxValueNokMinor
    }
    byCard.set(r.cardId, existing)
  }
  return byCard
}
