/**
 * Turns what the `search-prices` Edge Function reported for ONE exact catalog variant into typed
 * raw price observations. The wire payload is a trust boundary (a deployed function, a third-party
 * provider behind it): every field is validated, and anything that does not validate is dropped
 * and COUNTED — never repaired into a plausible-looking number, never turned into zero.
 *
 * Provider semantics recorded here come from docs/API_SOURCES.md and the TCGdex mapper
 * (supabase/functions/_shared/tcgdex.ts):
 *   - Cardmarket values arrive in EUR, TCGplayer values in USD. A payload claiming another
 *     currency for a provider is rejected as inconsistent rather than believed.
 *   - The relayed metrics are provider-computed statistics; TCGdex does not document whether they
 *     derive from sales or from listings, so their kind is `index`, never `sold`/`listing`.
 *   - The relays carry no per-condition breakdown, so `condition` is null (not "NM").
 */
import { fromMinorUnits } from '../money'
import type { DroppedObservation, PriceKind, PriceObservation, VariantFinish } from './types'
import { parseInstant } from './freshness'
import { asCurrencyCode, asRecord, ownEntry } from './wire'

interface ProviderMeta {
  readonly label: string
  readonly currency: 'EUR' | 'USD'
}

const PROVIDERS: Readonly<Record<string, ProviderMeta>> = {
  tcgdex_cardmarket: { label: 'Cardmarket via TCGdex', currency: 'EUR' },
  tcgdex_tcgplayer: { label: 'TCGplayer via TCGdex', currency: 'USD' },
}

interface MetricMeta {
  readonly provider: string
  readonly label: string
  readonly kind: PriceKind
  readonly windowDays: number | null
}

const UNDOCUMENTED_BASIS =
  'Provider-computed statistic. TCGdex does not document whether it is derived from sales or from listings.'

const METRICS: Readonly<Record<string, MetricMeta>> = {
  cm_trend: {
    provider: 'tcgdex_cardmarket',
    label: 'Trend price',
    kind: 'index',
    windowDays: null,
  },
  cm_avg30: {
    provider: 'tcgdex_cardmarket',
    label: 'Average, 30 days',
    kind: 'index',
    windowDays: 30,
  },
  cm_avg7: {
    provider: 'tcgdex_cardmarket',
    label: 'Average, 7 days',
    kind: 'index',
    windowDays: 7,
  },
  cm_avg: {
    provider: 'tcgdex_cardmarket',
    label: 'Average price',
    kind: 'index',
    windowDays: null,
  },
  tp_market: {
    provider: 'tcgdex_tcgplayer',
    label: 'Market price',
    kind: 'index',
    windowDays: null,
  },
}

export function isKnownRawProvider(provider: string): boolean {
  return ownEntry(PROVIDERS, provider) !== undefined
}

export interface RawObservationContext {
  /** ISO 8601 instant at which this client received the payload. */
  readonly fetchedAt: string
  readonly finish: VariantFinish
  readonly synthetic?: boolean
}

export interface RawObservationParse {
  readonly observations: PriceObservation[]
  readonly dropped: DroppedObservation[]
}

const MINOR_UNITS_PATTERN = /^\d{1,18}$/

/** One wire observation → an observation, or the reason it was refused. */
function parseOne(
  wire: unknown,
  ctx: RawObservationContext,
): { observation: PriceObservation } | { dropped: DroppedObservation } {
  const record = asRecord(wire)
  const providerId = typeof record?.provider === 'string' ? record.provider : null
  const provider = providerId !== null ? ownEntry(PROVIDERS, providerId) : undefined
  if (record === null || providerId === null || provider === undefined) {
    return { dropped: { reason: 'unknown_provider', provider: providerId } }
  }

  const metricId = typeof record.priceKind === 'string' ? record.priceKind : null
  const metric = metricId !== null ? ownEntry(METRICS, metricId) : undefined
  if (metricId === null || metric === undefined || metric.provider !== providerId) {
    return { dropped: { reason: 'unknown_metric', provider: providerId } }
  }

  const currency = asCurrencyCode(record.sourceCurrency)
  if (currency === null) {
    return { dropped: { reason: 'unsupported_currency', provider: providerId } }
  }
  if (currency !== provider.currency) {
    return { dropped: { reason: 'currency_mismatch', provider: providerId } }
  }

  // Exact integer minor units as a decimal string. A JSON float would already have lost the
  // guarantee; a negative, fractional or non-numeric value is malformed, not "zero".
  const valueMinor = record.valueMinor
  if (typeof valueMinor !== 'string' || !MINOR_UNITS_PATTERN.test(valueMinor)) {
    return { dropped: { reason: 'malformed_price', provider: providerId } }
  }

  const observedRaw = record.providerUpdatedAt
  const observedAt =
    typeof observedRaw === 'string' && parseInstant(observedRaw) !== null ? observedRaw : null

  return {
    observation: {
      subject: { type: 'raw' },
      provider: providerId,
      providerLabel: provider.label,
      metric: metricId,
      metricLabel: metric.label,
      basisNote: UNDOCUMENTED_BASIS,
      kind: metric.kind,
      price: fromMinorUnits(BigInt(valueMinor), currency),
      windowDays: metric.windowDays,
      observedAt,
      fetchedAt: ctx.fetchedAt,
      condition: null,
      synthetic: ctx.synthetic ?? false,
    },
  }
}

/** Parses the `observations` array a `search-prices` row carries for one variant. */
export function parseRawObservations(
  wire: unknown,
  ctx: RawObservationContext,
): RawObservationParse {
  const observations: PriceObservation[] = []
  const dropped: DroppedObservation[] = []
  if (!Array.isArray(wire)) return { observations, dropped }
  for (const item of wire) {
    const parsed = parseOne(item, ctx)
    if ('observation' in parsed) observations.push(parsed.observation)
    else dropped.push(parsed.dropped)
  }
  return { observations, dropped }
}

/**
 * Version-skew fallback: a `search-prices` deployment that predates the `observations` field only
 * reports its single preferred headline value (`provider`/`priceKind`/`sourceValueMinor`).
 * That is still a genuine, variant-exact observation, so it is shown — but the caller must treat
 * the result as partial (the other provider may exist and is simply not visible).
 */
export function parseHeadlineObservation(
  row: {
    provider: unknown
    priceKind: unknown
    sourceCurrency: unknown
    sourceValueMinor: unknown
    providerUpdatedAt: unknown
  },
  ctx: RawObservationContext,
): RawObservationParse {
  if (row.provider === null || row.provider === undefined) {
    return { observations: [], dropped: [] }
  }
  const minor = row.sourceValueMinor
  const valueMinor =
    typeof minor === 'number' && Number.isSafeInteger(minor) && minor >= 0 ? String(minor) : null
  return parseRawObservations(
    [
      {
        provider: row.provider,
        priceKind: row.priceKind,
        sourceCurrency: row.sourceCurrency,
        valueMinor,
        providerUpdatedAt: row.providerUpdatedAt,
      },
    ],
    ctx,
  )
}
