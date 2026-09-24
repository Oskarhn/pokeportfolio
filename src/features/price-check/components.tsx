import type { ReactNode } from 'react'
import { ageInDays, classifyFreshness, isFxRateStale } from '../../domain/price-check/freshness'
import { nokReference, type FxRateParse } from '../../domain/price-check/fx'
import { groupGradedByCompany, GRADING_COMPANIES } from '../../domain/price-check/graded'
import { RAW_UNSUPPORTED_DIMENSIONS, variantLabel } from '../../domain/price-check/identity'
import type {
  Freshness,
  GradedPriceSection,
  PriceKind,
  PriceObservation,
  RawPriceSection,
  UnavailableReason,
  VariantIdentity,
} from '../../domain/price-check/types'
import { formatCurrencyMinor, formatNokMinor } from '../../ui/money-format'

/**
 * Presentational pieces of the Price Check result page. Everything here is a pure function of its
 * props — no fetching, no router, no clock (the caller passes `nowMs`) — so the exact markup for
 * every state (fresh / stale / synthetic / unavailable / partial) is testable by rendering it.
 *
 * These components format amounts that the domain already settled; none of them computes money.
 */

const KIND_LABEL: Record<PriceKind, string> = {
  listing: 'Listing price',
  sold: 'Sold price',
  index: 'Index price',
}

const FRESHNESS_TEXT: Record<Freshness, string> = {
  fresh: 'Fresh',
  stale: 'Stale',
  outdated: 'Outdated',
  unknown: 'Age unknown',
}

const FRESHNESS_CLASS: Record<Freshness, string> = {
  fresh: 'border-emerald-900/60 bg-emerald-950/40 text-emerald-200',
  stale: 'border-slate-600 text-slate-200',
  outdated: 'border-rose-900/60 bg-rose-950/40 text-rose-200',
  unknown: 'border-slate-600 text-slate-200',
}

export function FreshnessBadge({
  observedAt,
  nowMs,
}: {
  observedAt: string | null
  nowMs: number
}) {
  const freshness = classifyFreshness(observedAt, nowMs)
  const age = ageInDays(observedAt, nowMs)
  return (
    <span
      data-testid="freshness"
      data-freshness={freshness}
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${FRESHNESS_CLASS[freshness]}`}
    >
      {FRESHNESS_TEXT[freshness]}
      {age !== null ? ` · ${String(age)} ${age === 1 ? 'day' : 'days'} old` : ''}
    </span>
  )
}

function SyntheticBadge() {
  return (
    <span
      data-testid="synthetic-badge"
      className="inline-flex items-center rounded-full border border-slate-600 px-2 py-0.5 text-xs font-semibold text-slate-200"
    >
      Synthetic test data
    </span>
  )
}

/** The original-currency figure is always the primary; NOK is a labelled reference beneath it. */
function NokLine({
  observation,
  fx,
  nowMs,
}: {
  observation: PriceObservation
  fx: FxRateParse | null
  nowMs: number
}) {
  const reference = nokReference(observation.price, fx)
  if (reference.status === 'source_is_nok') return null
  if (reference.status === 'unavailable') {
    return (
      <p data-testid="nok-unavailable" className="text-xs text-slate-400">
        {reference.reason === 'fx_malformed'
          ? 'NOK reference unavailable — the cached exchange rate is invalid.'
          : `NOK reference unavailable — no ${observation.price.currency}/NOK exchange rate is cached.`}
      </p>
    )
  }
  const stale = isFxRateStale(reference.rate.rateDate, nowMs)
  return (
    <p data-testid="nok-reference" className="text-xs text-slate-400">
      ≈ kr {formatNokMinor(reference.nok.minorUnits)} at {reference.rate.rateToNok} NOK per{' '}
      {observation.price.currency} (Norges Bank, {reference.rate.rateDate})
      {stale ? (
        <span data-testid="fx-stale" className="ml-1 font-medium text-slate-200">
          · Exchange rate is {String(Math.max(0, ageInDays(reference.rate.rateDate, nowMs) ?? 0))}{' '}
          days old
        </span>
      ) : null}
    </p>
  )
}

function fetchedText(fetchedAt: string, origin: 'network' | 'cache'): string {
  const time = fetchedAt.slice(11, 16)
  const date = fetchedAt.slice(0, 10)
  return `${origin === 'cache' ? 'Cached — fetched' : 'Fetched'} ${date} ${time} UTC`
}

export function ObservationCard({
  observation,
  fx,
  nowMs,
  origin,
}: {
  observation: PriceObservation
  fx: FxRateParse | null
  nowMs: number
  origin: 'network' | 'cache'
}) {
  const { price } = observation
  return (
    <li
      data-testid="observation"
      data-provider={observation.provider}
      data-metric={observation.metric}
      data-kind={observation.kind}
      className="space-y-1.5 rounded-xl border border-slate-800 p-3"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="min-w-0 break-words text-sm font-medium text-slate-100">
          {observation.providerLabel}
          <span className="text-slate-400"> · {observation.metricLabel}</span>
        </p>
        <p
          data-testid="observation-price"
          className="text-xl font-semibold tabular-nums tracking-tight text-slate-100"
        >
          {formatCurrencyMinor(price.minorUnits, price.currency)}
        </p>
      </div>
      <NokLine observation={observation} fx={fx} nowMs={nowMs} />
      <div className="flex flex-wrap items-center gap-1.5">
        <FreshnessBadge observedAt={observation.observedAt} nowMs={nowMs} />
        <span className="inline-flex items-center rounded-full border border-slate-600 px-2 py-0.5 text-xs text-slate-200">
          {KIND_LABEL[observation.kind]}
        </span>
        {observation.synthetic ? <SyntheticBadge /> : null}
      </div>
      <p className="text-xs text-slate-400">
        {observation.observedAt !== null
          ? `Observed by source ${observation.observedAt.slice(0, 10)}`
          : 'Source gave no observation date'}
        {' · '}
        {fetchedText(observation.fetchedAt, origin)}
      </p>
      <p className="text-xs text-slate-500">{observation.basisNote}</p>
      <p className="text-xs text-slate-500">
        {observation.condition !== null
          ? `Condition: ${observation.condition}`
          : 'Condition not specified by source'}
        {observation.windowDays !== null ? ` · ${String(observation.windowDays)}-day window` : ''}
      </p>
    </li>
  )
}

const UNAVAILABLE_COPY: Record<UnavailableReason, { text: string; retry: boolean }> = {
  no_variant_price: {
    text: 'The price source has no price for this exact variant. Nothing has been estimated from another variant.',
    retry: false,
  },
  variant_not_in_response: {
    text: 'The price source did not return this variant.',
    retry: true,
  },
  provider_error: {
    text: 'The price source could not be reached for this card. This is a lookup failure, not a zero price.',
    retry: true,
  },
  rate_limited: {
    text: 'The price source is rate limiting requests. Wait a moment and try again.',
    retry: true,
  },
  network: {
    text: 'The connection failed. Check your network and try again.',
    retry: true,
  },
  malformed_response: {
    text: 'The price source returned data that could not be trusted, so it is not shown.',
    retry: true,
  },
  not_found: {
    text: 'The price service was not found. It may not be deployed yet.',
    retry: false,
  },
  unauthorized: {
    text: 'Your session is not authorised to look up prices. Sign in again.',
    retry: false,
  },
  graded_source_not_configured: {
    text: 'No graded price source is connected to this app, so graded prices are not available. They are never estimated from raw prices.',
    retry: false,
  },
  graded_no_data: {
    text: 'The graded price source has no data for this variant.',
    retry: false,
  },
}

export function UnavailableNotice({
  reason,
  onRetry,
}: {
  reason: UnavailableReason
  onRetry?: () => void
}) {
  const copy = UNAVAILABLE_COPY[reason]
  return (
    <div
      data-testid="unavailable"
      data-reason={reason}
      // A retryable reason is a failure the person must hear about; "no price exists" is not.
      role={copy.retry ? 'alert' : undefined}
      className="space-y-2 text-sm"
    >
      <p className="text-slate-300">
        <span className="font-medium text-slate-100">— Not available. </span>
        {copy.text}
      </p>
      {copy.retry && onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="min-h-11 rounded-full border border-slate-700 px-4 text-sm font-medium text-slate-200 hover:bg-slate-800"
        >
          Try again
        </button>
      ) : null}
    </div>
  )
}

export function RawPriceBlock({
  section,
  fxByCurrency,
  nowMs,
  origin,
  headlineOnly,
  onRetry,
}: {
  section: RawPriceSection
  fxByCurrency: Readonly<Record<string, FxRateParse | undefined>>
  nowMs: number
  origin: 'network' | 'cache'
  headlineOnly: boolean
  onRetry: () => void
}) {
  return (
    <section aria-labelledby="pc-raw-heading" className="space-y-3">
      <h2 id="pc-raw-heading" className="text-sm font-semibold text-slate-300">
        Raw (ungraded) prices
      </h2>
      {section.status === 'available' ? (
        <>
          <ul className="space-y-2">
            {section.observations.map((observation) => (
              <ObservationCard
                key={`${observation.provider}:${observation.metric}`}
                observation={observation}
                fx={fxByCurrency[observation.price.currency] ?? null}
                nowMs={nowMs}
                origin={origin}
              />
            ))}
          </ul>
          <p className="text-xs text-slate-500">
            Not available from these sources: {RAW_UNSUPPORTED_DIMENSIONS.join(', ')}. Prices are
            shown in the source currency; NOK is a reference only.
          </p>
          {headlineOnly ? (
            <p data-testid="headline-only" className="text-xs text-slate-400">
              The price service reports one provider value for this variant; another provider may
              have a price that is not shown here.
            </p>
          ) : null}
        </>
      ) : (
        <UnavailableNotice reason={section.unavailable ?? 'no_variant_price'} onRetry={onRetry} />
      )}
      {section.dropped.length > 0 ? (
        <p data-testid="dropped-notice" className="text-xs text-slate-400">
          {String(section.dropped.length)} provider{' '}
          {section.dropped.length === 1 ? 'value was' : 'values were'} ignored because{' '}
          {section.dropped.length === 1 ? 'it was' : 'they were'} malformed or unsupported.
        </p>
      ) : null}
    </section>
  )
}

export function GradedPriceBlock({
  section,
  fxByCurrency,
  nowMs,
  origin,
}: {
  section: GradedPriceSection
  fxByCurrency: Readonly<Record<string, FxRateParse | undefined>>
  nowMs: number
  origin: 'network' | 'cache'
}) {
  const groups = groupGradedByCompany(section.observations)
  return (
    <section aria-labelledby="pc-graded-heading" className="space-y-3">
      <h2 id="pc-graded-heading" className="text-sm font-semibold text-slate-300">
        Graded prices
      </h2>
      {section.status === 'available' ? (
        <div className="space-y-4">
          {groups.map(({ company, rows }) => (
            <div key={company} className="space-y-1.5">
              <h3 className="text-sm font-medium text-slate-100">{company}</h3>
              {/* Keyboard-focusable scroll region: a wide table must be reachable without a mouse
                  (axe `scrollable-region-focusable`), which is why this non-interactive region is
                  deliberately given a tabIndex. */}
              <div
                role="region"
                aria-label={`${company} graded prices`}
                // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
                tabIndex={0}
                className="overflow-x-auto rounded-xl border border-slate-800 focus-visible:outline-2 focus-visible:outline-sky-500"
              >
                <table className="w-full min-w-[34rem] border-collapse text-left text-sm">
                  <caption className="sr-only">{company} graded prices by grade</caption>
                  <thead>
                    <tr className="border-b border-slate-800 text-xs text-slate-400">
                      <th scope="col" className="px-3 py-2 font-medium">
                        Grade
                      </th>
                      <th scope="col" className="px-3 py-2 font-medium">
                        Price
                      </th>
                      <th scope="col" className="px-3 py-2 font-medium">
                        Type
                      </th>
                      <th scope="col" className="px-3 py-2 font-medium">
                        Observed
                      </th>
                      <th scope="col" className="px-3 py-2 font-medium">
                        Source
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => {
                      const graded = row.subject.type === 'graded' ? row.subject : null
                      return (
                        <tr
                          key={`${row.provider}:${graded?.grade ?? ''}:${graded?.qualifier ?? ''}:${row.metric}`}
                          data-testid="graded-row"
                          data-company={company}
                          data-grade={graded?.grade}
                          className="border-b border-slate-800 align-top last:border-b-0"
                        >
                          <th scope="row" className="px-3 py-2 font-medium text-slate-100">
                            {company} {graded?.grade}
                            {graded?.qualifier ? ` ${graded.qualifier}` : ''}
                          </th>
                          <td className="px-3 py-2 tabular-nums text-slate-100">
                            {formatCurrencyMinor(row.price.minorUnits, row.price.currency)}
                            <GradedNok
                              row={row}
                              fx={fxByCurrency[row.price.currency] ?? null}
                              nowMs={nowMs}
                            />
                          </td>
                          <td className="px-3 py-2 text-slate-300">{KIND_LABEL[row.kind]}</td>
                          <td className="px-3 py-2 text-slate-300">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span>
                                {row.observedAt !== null ? row.observedAt.slice(0, 10) : 'No date'}
                              </span>
                              <FreshnessBadge observedAt={row.observedAt} nowMs={nowMs} />
                            </div>
                          </td>
                          <td className="px-3 py-2 text-slate-300">
                            {row.providerLabel}
                            {row.synthetic ? (
                              <>
                                {' '}
                                <SyntheticBadge />
                              </>
                            ) : null}
                            <span className="block text-xs text-slate-500">
                              {fetchedText(row.fetchedAt, origin)}
                            </span>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
          <p className="text-xs text-slate-500">
            Grades are never compared across companies: a PSA 10, a BGS 10 and a CGC 10 are separate
            prices.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          <UnavailableNotice reason={section.unavailable ?? 'graded_source_not_configured'} />
          <ul
            data-testid="graded-company-status"
            className="flex flex-wrap gap-1.5 text-xs text-slate-300"
          >
            {GRADING_COMPANIES.slice(0, 3).map((company) => (
              <li key={company} className="rounded-full border border-slate-700 px-2 py-0.5">
                {company}: no data
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}

function GradedNok({
  row,
  fx,
  nowMs,
}: {
  row: PriceObservation
  fx: FxRateParse | null
  nowMs: number
}) {
  const reference = nokReference(row.price, fx)
  if (reference.status === 'source_is_nok') return null
  return (
    <span className="block text-xs font-normal text-slate-400">
      {reference.status === 'converted'
        ? `≈ kr ${formatNokMinor(reference.nok.minorUnits)}${isFxRateStale(reference.rate.rateDate, nowMs) ? ' (rate is old)' : ''}`
        : 'NOK reference unavailable'}
    </span>
  )
}

/** One selectable variant. A radio-style choice: exactly one is checked, and none is pre-checked
 *  for a card with several variants. */
export function VariantChooser({
  variants,
  selectedVariantId,
  onSelect,
  priceSummary,
}: {
  variants: readonly VariantIdentity[]
  selectedVariantId: string | null
  onSelect: (variantId: string) => void
  /** Per-variant short text about price availability ("2 sources", "No price"). */
  priceSummary: (variantId: string) => ReactNode
}) {
  return (
    <div role="radiogroup" aria-label="Card variant" className="space-y-2">
      {variants.map((variant) => {
        const selected = variant.variantId === selectedVariantId
        return (
          <button
            key={variant.variantId}
            type="button"
            role="radio"
            aria-checked={selected}
            data-testid="variant-option"
            onClick={() => {
              onSelect(variant.variantId)
            }}
            className={`flex min-h-11 w-full items-center justify-between gap-3 rounded-xl border px-3 py-2 text-left text-sm focus-visible:outline-2 focus-visible:outline-sky-500 ${
              selected
                ? 'border-sky-500 bg-sky-600/20 text-slate-100'
                : 'border-slate-700 text-slate-200 hover:bg-slate-800'
            }`}
          >
            <span className="min-w-0 break-words font-medium">
              {variantLabel(variant) || 'Standard'}
              {!variant.isActive ? (
                <span className="ml-2 text-xs font-normal text-slate-400">No longer listed</span>
              ) : null}
            </span>
            <span className="shrink-0 text-xs text-slate-400">
              {priceSummary(variant.variantId)}
            </span>
          </button>
        )
      })}
    </div>
  )
}
