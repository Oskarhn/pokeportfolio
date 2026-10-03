/**
 * Wire shape of the per-variant `observations` array `search-prices` returns (P153, Price Check).
 *
 * `search-prices` has always answered with ONE preferred headline value per variant (Cardmarket or
 * TCGplayer, per the caller's EU/US preference). Price Check needs to show every provider value the
 * exact variant genuinely has, side by side, so this adds the complete candidate list — additively:
 * the headline fields are unchanged, and a client that predates `observations` keeps working.
 *
 * Values are exact integer minor units serialised as decimal STRINGS (never JSON floats), and each
 * carries the provider's own `providerUpdatedAt` — nothing is stamped with "now" here.
 */
import type { PriceCandidate, ProviderVariantPricing } from './tcgdex.ts'

export interface PriceObservationWire {
  readonly provider: string
  readonly priceKind: string
  readonly sourceCurrency: string
  readonly valueMinor: string
  readonly providerUpdatedAt: string | null
}

function toWire(candidate: PriceCandidate): PriceObservationWire {
  return {
    provider: candidate.provider,
    priceKind: candidate.priceKind,
    sourceCurrency: candidate.sourceCurrency,
    valueMinor: candidate.valueMinor.toString(),
    providerUpdatedAt: candidate.providerUpdatedAt,
  }
}

/** Every provider candidate the mapper found for one exact variant — Cardmarket first, then
 *  TCGplayer. An ambiguous variant (the mapper returned `null` for a provider) contributes nothing
 *  for that provider; there is no fallback to another variant's price. */
export function observationsForVariant(
  match: Pick<ProviderVariantPricing, 'cardmarket' | 'tcgplayer'> | undefined,
): PriceObservationWire[] {
  if (match === undefined) return []
  const observations: PriceObservationWire[] = []
  if (match.cardmarket !== null) observations.push(toWire(match.cardmarket))
  if (match.tcgplayer !== null) observations.push(toWire(match.tcgplayer))
  return observations
}
