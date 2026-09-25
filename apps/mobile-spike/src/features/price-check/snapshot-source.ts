import { ageInDays, classifyFreshness } from './p165-domain/price-check/freshness'
import type { SnapshotHeadline } from './model'

/**
 * The RELEASED (DB 104, unchanged on DB 106) price interface: `get_card_variant_price_history`,
 * reused through the shared web data layer unchanged (`@shared/data/pricing`). The server converts
 * stored snapshots to NOK and resolves ONE provider per variant from the caller's own profile
 * preference (`use_eu_pricing`), so the result is ACCOUNT-SPECIFIC and must never outlive an
 * identity change (the lookup service's cache is reset with the identity).
 *
 * The interface does not report the source currency, the source amount or the metric; they are not
 * guessed. A snapshot is classified with the same thresholds as a provider observation (P165
 * freshness: <= 3 days fresh, <= 30 stale, older outdated) from its snapshot DATE.
 */

export interface SnapshotPoint {
  readonly snapshotDate: string
  readonly valueNokMinor: bigint
  readonly provider: string | null
}

export type SnapshotHistoryReader = (variantId: string) => Promise<readonly SnapshotPoint[]>

const PROVIDER_LABEL: Readonly<Record<string, string>> = {
  tcgdex_cardmarket: 'Cardmarket via TCGdex',
  tcgdex_tcgplayer: 'TCGplayer via TCGdex',
}

export function latestSnapshotHeadlines(
  history: readonly SnapshotPoint[],
  nowMs: number,
): SnapshotHeadline[] {
  const latest = new Map<string, SnapshotPoint>()
  for (const point of history) {
    const key = point.provider ?? 'unknown'
    const current = latest.get(key)
    if (current === undefined || point.snapshotDate > current.snapshotDate) latest.set(key, point)
  }
  return [...latest.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([provider, point]) => ({
      provider,
      providerLabel: Object.hasOwn(PROVIDER_LABEL, provider)
        ? (PROVIDER_LABEL[provider] as string)
        : 'Unknown provider',
      nok: { minorUnits: point.valueNokMinor, currency: 'NOK' as const },
      snapshotDate: point.snapshotDate,
      freshness: classifyFreshness(point.snapshotDate, nowMs),
      ageDays: ageInDays(point.snapshotDate, nowMs),
    }))
}
