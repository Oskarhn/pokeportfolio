import type { ReactNode } from 'react'
import { buildRawSection, type CardPriceResponse } from '../../domain/price-check/raw-section'
import type { FxRateParse } from '../../domain/price-check/fx'
import {
  languageLabel,
  variantLabel,
  type VariantResolution,
} from '../../domain/price-check/identity'
import type {
  CardIdentity,
  GradedPriceSection,
  RawPriceSection,
  UnavailableReason,
  VariantIdentity,
} from '../../domain/price-check/types'
import { CardImage } from '../catalog/CardImage'
import { GradedPriceBlock, RawPriceBlock, UnavailableNotice, VariantChooser } from './components'

export type RawLoadState =
  | { readonly state: 'loading' }
  | { readonly state: 'error'; readonly reason: UnavailableReason }
  | {
      readonly state: 'ready'
      readonly response: CardPriceResponse
      readonly origin: 'network' | 'cache'
    }

export interface ResultViewProps {
  readonly card: CardIdentity
  readonly variants: readonly VariantIdentity[]
  readonly resolution: VariantResolution
  readonly raw: RawLoadState
  readonly graded: GradedPriceSection
  readonly fxByCurrency: Readonly<Record<string, FxRateParse | undefined>>
  readonly nowMs: number
  readonly onSelectVariant: (variantId: string) => void
  readonly onRetry: () => void
  /** Router links are injected so this view renders without a router (and can be tested). */
  readonly slots: {
    readonly addToCollection: ReactNode
    readonly searchAgain: ReactNode
    readonly scanAgain: ReactNode
    readonly setLink: ReactNode
  }
}

function variantSummary(raw: RawLoadState, variant: VariantIdentity): ReactNode {
  if (raw.state === 'loading') return '…'
  if (raw.state === 'error') return 'Unknown'
  const { section } = buildRawSection(raw.response, variant)
  if (section.status === 'available') {
    const count = section.observations.length
    return `${String(count)} ${count === 1 ? 'price' : 'prices'}`
  }
  return section.unavailable === 'no_variant_price' ? 'No price' : 'Unknown'
}

function LoadingBlock() {
  return (
    <div role="status" aria-live="polite" data-testid="prices-loading" className="space-y-2">
      <span className="sr-only">Loading prices…</span>
      <div className="h-24 animate-pulse rounded-xl bg-slate-800/60" aria-hidden />
    </div>
  )
}

export function ResultView(props: ResultViewProps) {
  const { card, variants, resolution, raw, graded, fxByCurrency, nowMs, slots } = props
  const selected: VariantIdentity | null =
    resolution.status === 'confirmed' ? resolution.variant : null

  let rawSection: RawPriceSection | null = null
  let headlineOnly = false
  if (selected !== null && raw.state === 'ready') {
    const built = buildRawSection(raw.response, selected)
    rawSection = built.section
    headlineOnly = built.headlineOnly
  }

  return (
    <div className="mx-auto w-full max-w-2xl space-y-4 py-2">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        {slots.searchAgain}
        {slots.scanAgain}
      </div>

      <CardImage
        imageBaseUrl={card.imageBaseUrl}
        alt={card.name}
        quality="high"
        className="mx-auto h-64 w-44 sm:h-72 sm:w-52"
      />

      <div className="space-y-5 rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
        <div className="min-w-0">
          <h1 className="break-words text-xl font-semibold tracking-tight text-slate-100">
            {card.name}
          </h1>
          <p className="break-words text-sm">
            {slots.setLink}
            <span className="text-slate-400"> · #{card.collectorNumber}</span>
          </p>
        </div>

        <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
          <dt className="text-slate-500">Language</dt>
          <dd className="text-slate-200">{languageLabel(card.language)}</dd>
          <dt className="text-slate-500">Rarity</dt>
          <dd className="text-slate-200">{card.rarity ?? '—'}</dd>
          <dt className="text-slate-500">Illustrator</dt>
          <dd className="break-words text-slate-200">{card.illustrator ?? '—'}</dd>
        </dl>

        <section
          aria-labelledby="pc-variant-heading"
          className="space-y-2 border-t border-slate-800 pt-4"
        >
          <h2 id="pc-variant-heading" className="text-sm font-semibold text-slate-300">
            Variant
          </h2>
          {resolution.status === 'no_variants' ? (
            <p data-testid="no-variants" className="text-sm text-slate-300">
              This card has no known variants, so a price cannot be matched to an exact variant.
            </p>
          ) : resolution.status === 'confirmed' && resolution.basis === 'only_variant' ? (
            <p data-testid="only-variant" className="text-sm text-slate-200">
              {variantLabel(resolution.variant) || 'Standard'}
              <span className="text-slate-400"> · the only variant of this card</span>
            </p>
          ) : (
            <>
              {resolution.status === 'mismatch' ? (
                <p
                  role="alert"
                  className="rounded-lg border border-rose-900/60 bg-rose-950/40 px-3 py-2 text-sm text-rose-200"
                >
                  The requested variant does not belong to this card. Choose one below.
                </p>
              ) : null}
              {resolution.status === 'choice_required' || resolution.status === 'mismatch' ? (
                <p data-testid="choose-variant" className="text-sm text-slate-300">
                  This card has {String(variants.length)} variants with different prices. Choose the
                  exact one to see its price — nothing is picked for you.
                </p>
              ) : null}
              <VariantChooser
                variants={variants}
                selectedVariantId={selected?.variantId ?? null}
                onSelect={props.onSelectVariant}
                priceSummary={(variantId) => {
                  const variant = variants.find((v) => v.variantId === variantId)
                  return variant === undefined ? null : variantSummary(raw, variant)
                }}
              />
            </>
          )}
        </section>

        {selected !== null ? (
          <div className="space-y-5 border-t border-slate-800 pt-4">
            {raw.state === 'loading' ? (
              <LoadingBlock />
            ) : raw.state === 'error' ? (
              <section aria-labelledby="pc-raw-heading" className="space-y-3">
                <h2 id="pc-raw-heading" className="text-sm font-semibold text-slate-300">
                  Raw (ungraded) prices
                </h2>
                <UnavailableNotice reason={raw.reason} onRetry={props.onRetry} />
              </section>
            ) : rawSection !== null ? (
              <RawPriceBlock
                section={rawSection}
                fxByCurrency={fxByCurrency}
                nowMs={nowMs}
                origin={raw.origin}
                headlineOnly={headlineOnly}
                onRetry={props.onRetry}
              />
            ) : null}

            <GradedPriceBlock
              section={graded}
              fxByCurrency={fxByCurrency}
              nowMs={nowMs}
              origin={raw.state === 'ready' ? raw.origin : 'network'}
            />
          </div>
        ) : null}

        {selected !== null ? (
          <div className="space-y-2 border-t border-slate-800 pt-4">
            <p className="text-xs text-slate-400">
              Price Check only looks prices up. Nothing is added to your collection, purchases or
              sales unless you choose to.
            </p>
            {slots.addToCollection}
          </div>
        ) : null}
      </div>
    </div>
  )
}
