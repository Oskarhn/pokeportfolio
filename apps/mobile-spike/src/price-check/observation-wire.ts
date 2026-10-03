import type { CurrencyCode } from '@shared/domain/currency'
import { getCurrencyMeta } from '@shared/domain/currency'
import type { Money } from '@shared/domain/money'
import type { PriceKind, PriceObservationView } from './types'

/**
 * Maps the wire shape P153's `search-prices` adds (`observations[]` per variant; branch
 * feat/p153-card-price-check, `supabase/functions/_shared/price-observations.ts`) to the spike's view
 * type. The wire shape is copied here from that file as DATA, not imported, because the Edge Function
 * is not live on DB 104:
 *
 *   { provider, priceKind, sourceCurrency, valueMinor: "<integer string>", providerUpdatedAt | null }
 *
 * Untrusted-input rules (the same ones P153's own mapper follows): only own properties select a table
 * entry (`'constructor' in {}` is true), the currency must be one the shared domain knows AND be the
 * provider's own currency, the amount must be a plain non-negative integer string (no float, no
 * exponent, no sign, no whitespace), and anything else is DROPPED and counted, never shown. Zero is
 * shown only when the provider actually reported zero.
 *
 * SPIKE_ONLY stand-in for P153's `src/domain/price-check/raw-observations.ts`.
 */

export interface PriceObservationWire {
  readonly provider: unknown
  readonly priceKind: unknown
  readonly sourceCurrency: unknown
  readonly valueMinor: unknown
  readonly providerUpdatedAt: unknown
}

interface ProviderInfo {
  label: string
  currency: CurrencyCode
  synthetic: boolean
}

const PROVIDERS: Readonly<Record<string, ProviderInfo>> = {
  tcgdex_cardmarket: { label: 'Cardmarket via TCGdex', currency: 'EUR', synthetic: false },
  tcgdex_tcgplayer: { label: 'TCGplayer via TCGdex', currency: 'USD', synthetic: false },
  // A clearly synthetic provider used only by the fixture, so a zero-exponent (JPY) source amount can
  // be exercised end to end. It is rendered as SYNTHETIC and never mistaken for market data.
  p158_fixture_jpy: { label: 'Synthetic fixture (JPY)', currency: 'JPY', synthetic: true },
}

const METRICS: Readonly<Record<string, { label: string; kind: PriceKind }>> = {
  cm_trend: { label: 'Trend price', kind: 'index' },
  cm_avg30: { label: '30-day average', kind: 'index' },
  cm_avg7: { label: '7-day average', kind: 'index' },
  cm_avg: { label: 'Average price', kind: 'index' },
  tp_market: { label: 'Market price', kind: 'index' },
  fixture_metric: { label: 'Fixture metric', kind: 'index' },
}

const INDEX_NOTE =
  'A provider-computed statistic. TCGdex does not document whether it is based on sold or listed prices.'
const NON_NEGATIVE_INTEGER = /^\d{1,18}$/

function own<T>(table: Readonly<Record<string, T>>, key: unknown): T | undefined {
  return typeof key === 'string' && Object.prototype.hasOwnProperty.call(table, key)
    ? table[key]
    : undefined
}

/** The shared `isSupportedCurrencyCode` is `value in CURRENCIES`, which is true for 'constructor'. */
export function asCurrencyCode(value: unknown): CurrencyCode | null {
  if (typeof value !== 'string') return null
  const known: readonly string[] = ['NOK', 'EUR', 'USD', 'GBP', 'JPY']
  if (!known.includes(value)) return null
  return getCurrencyMeta(value as CurrencyCode).code
}

export type DroppedReason =
  'unknown_provider' | 'unknown_metric' | 'currency_mismatch' | 'malformed_price'

export interface MappedObservations {
  readonly observations: readonly PriceObservationView[]
  readonly dropped: readonly { reason: DroppedReason; provider: string | null }[]
}

export function mapObservationsWire(wire: readonly PriceObservationWire[]): MappedObservations {
  const observations: PriceObservationView[] = []
  const dropped: { reason: DroppedReason; provider: string | null }[] = []
  for (const row of wire) {
    const providerId = typeof row.provider === 'string' ? row.provider : null
    const provider = own(PROVIDERS, row.provider)
    if (provider === undefined) {
      dropped.push({ reason: 'unknown_provider', provider: providerId })
      continue
    }
    const metric = own(METRICS, row.priceKind)
    if (metric === undefined) {
      dropped.push({ reason: 'unknown_metric', provider: providerId })
      continue
    }
    const currency = asCurrencyCode(row.sourceCurrency)
    if (currency === null || currency !== provider.currency) {
      dropped.push({ reason: 'currency_mismatch', provider: providerId })
      continue
    }
    if (typeof row.valueMinor !== 'string' || !NON_NEGATIVE_INTEGER.test(row.valueMinor)) {
      dropped.push({ reason: 'malformed_price', provider: providerId })
      continue
    }
    const source: Money = { minorUnits: BigInt(row.valueMinor), currency }
    observations.push({
      provider: providerId as string,
      providerLabel: provider.label,
      metric: row.priceKind as string,
      metricLabel: metric.label,
      basisNote: INDEX_NOTE,
      kind: metric.kind,
      source,
      nok: null,
      observedAt: typeof row.providerUpdatedAt === 'string' ? row.providerUpdatedAt : null,
      condition: null,
      synthetic: provider.synthetic,
    })
  }
  return { observations, dropped }
}
