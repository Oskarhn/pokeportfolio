import type { OpeningDetail, OpeningSource, TrackingCompleteness } from './contract'
import { computeOpeningCostPreview, openingRoiPercent } from '../../domain/opening'
import { toDecimalString } from '../../domain/money'

/**
 * Every financial sentence the opening UI shows, in one testable place (DESIGN_SYSTEM.md §8:
 * "financial terms mean what they mean"; FINANCIAL_MODEL.md §5's UI consequences). Components
 * render these strings verbatim and invent none of their own — that is what makes "no 0 kr, no
 * per-card ROI, no bare percentage without its marker" checkable rather than aspirational.
 *
 * The only arithmetic here is the display preview `unitCostNokMinor × quantityOpened` and §5.3's
 * own return/percentage composition over figures the backend already froze. Nothing is derived
 * from a missing value: an unknown cost produces "not recorded"/"—", never a computed zero.
 */

export const OPENING_COST_LABEL = 'Opening cost'
export const PURCHASE_COST_NOT_RECORDED = 'Purchase cost not recorded'
/** FINANCIAL_MODEL.md §5.2 verbatim consequence — shown wherever pulls are listed. */
export const PULL_COST_NOTE = 'No individual purchase cost — cost belongs to the opening.'
/** The fixed incompleteness marker copy (FINANCIAL_MODEL.md §5.3). */
export const INCOMPLETE_TRACKING_MARKER = 'Tracked pulls only — actual return is higher.'
export const RESULT_UNAVAILABLE_COPY = '—'
/** UX_FLOWS.md F5's plain statement — the exact behaviour users of other apps do not expect. */
export const THE_SEALED_NOTICE =
  'The purchase stays in your spending history. This product leaves sealed inventory.'
export const VOID_TITLE = 'Void / correct this opening?'
export const VOID_EXPLANATION =
  'The opened quantity returns to your sealed inventory. The pull records from this opening will be corrected along with it.'
/** P53 §10 policy, stated plainly: voiding an opening never undoes its purchase — the money
 *  was really spent whether or not the opening happened. Purchase corrections live elsewhere. */
export const VOID_PURCHASE_NOTE =
  'The purchase itself stays in your spending history — voiding an opening does not undo it.'
export const OPENING_RECORDED_ANNOUNCEMENT = 'Opening recorded.'

export type CostFigure = { kind: 'known'; minorUnits: bigint } | { kind: 'unknown' }

/**
 * The opening-cost figure a source lot implies for a given quantity — the EXACT rule
 * (P53 §7), delegated to the tested domain boundary `computeOpeningCostPreview`:
 *
 *   preview = effectiveUnitBasis × q + exhaustionResidual  (only when q exhausts the lot)
 *
 * This is byte-identical to what the backend will freeze: the 29995-øre lot previews 19996 for
 * two of three units and 9999 for the final one. Unknown stays unknown (M1) — never multiplied
 * into a fake zero.
 */
export function openingCostPreview(
  source: Pick<
    OpeningSource,
    'costKnown' | 'quantityAvailable' | 'effectiveUnitBasisNokMinor' | 'exhaustionResidualNokMinor'
  >,
  quantityOpened: number,
): CostFigure {
  if (
    !source.costKnown ||
    source.effectiveUnitBasisNokMinor === null ||
    source.effectiveUnitBasisNokMinor === undefined ||
    source.exhaustionResidualNokMinor === null ||
    source.exhaustionResidualNokMinor === undefined
  ) {
    return { kind: 'unknown' }
  }
  const minorUnits = computeOpeningCostPreview(
    {
      quantityAvailable: source.quantityAvailable,
      effectiveUnitBasisNokMinor: source.effectiveUnitBasisNokMinor,
      exhaustionResidualNokMinor: source.exhaustionResidualNokMinor,
    },
    quantityOpened,
  )
  return minorUnits === null ? { kind: 'unknown' } : { kind: 'known', minorUnits }
}

/**
 * The read-only per-unit provenance line ("99.98 kr each, from the original purchase"): the
 * derived unit basis as-is. The exhaustion residual is NOT smeared across units here — it is
 * shown honestly through the total preview instead.
 */
export function unitCostCopy(source: OpeningSource): string | null {
  if (!source.costKnown || !source.effectiveUnitBasisNokMinor) return null
  return `${formatNok(source.effectiveUnitBasisNokMinor)} kr each`
}

export interface ResultCopy {
  /** Kroner-first result string, or the em-dash unavailable marker. */
  headline: string
  /** Percentage line — only ever present with the completeness marker alongside it rules allow. */
  percentage: string | null
  /** Present exactly when tracking is not all_cards; must accompany any displayed result. */
  incompleteMarker: string | null
}

/**
 * FINANCIAL_MODEL.md §5.3 rendering rules as copy:
 *   - unknown cost → result renders "—" (return AND roi are undefined there);
 *   - incomplete tracking → kroner figure (when computable) plus the fixed marker, and NO
 *     percentage at all — a bare percentage on a partially tracked opening is a bug;
 *   - complete + known cost → kroner first, percentage second.
 * `resultNokMinor === undefined` means the adapter cannot provide the figure yet (P53): the row
 * hides rather than pretending.
 */
export function resultCopy(detail: OpeningDetail): ResultCopy | null {
  if (detail.resultNokMinor === undefined) return null

  if (detail.resultNokMinor === null || !detail.costKnown) {
    return {
      headline: RESULT_UNAVAILABLE_COPY,
      percentage: null,
      incompleteMarker:
        detail.trackingCompleteness !== 'all_cards' ? INCOMPLETE_TRACKING_MARKER : null,
    }
  }

  const kroner = signedKroner(detail.resultNokMinor)
  if (detail.trackingCompleteness !== 'all_cards') {
    return {
      headline: kroner,
      percentage: null,
      incompleteMarker: INCOMPLETE_TRACKING_MARKER,
    }
  }
  // §5.3's percentage, computed by the tested exact-integer domain helper (P53 §16) — never a
  // float ratio of two Numbers.
  const roi = openingRoiPercent(
    { minorUnits: detail.resultNokMinor, currency: 'NOK' },
    detail.costNokMinor !== null ? { minorUnits: detail.costNokMinor, currency: 'NOK' } : null,
  )
  return {
    headline: kroner,
    percentage: roi === null ? null : `${roi < 0 ? '−' : '+'}${Math.abs(roi).toFixed(1)} %`,
    incompleteMarker: null,
  }
}

/** Kroner-first figure with an explicit direction sign — the sign is added once, here, because
 *  gain/loss must survive without colour (DESIGN_SYSTEM.md §3). */
function signedKroner(minorUnits: bigint): string {
  const magnitude = minorUnits < 0n ? -minorUnits : minorUnits
  return `${minorUnits < 0n ? '−' : '+'}${formatNok(magnitude)} kr`
}

/** nb-NO formatting of an already-settled NOK minor-unit amount (no arithmetic) — the same
 *  domain-parser boundary `src/ui/money-format.ts` uses, kept local so this feature module stays
 *  self-contained for tests. */
export function formatNok(minorUnits: bigint): string {
  const decimal = toDecimalString({ minorUnits, currency: 'NOK' })
  return new Intl.NumberFormat('nb-NO', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number(decimal))
}

export const COMPLETENESS_QUESTION = 'How much of the opening did you record?'

export const COMPLETENESS_OPTIONS: readonly {
  value: TrackingCompleteness
  label: string
  note: string
}[] = [
  {
    value: 'all_cards',
    label: 'All cards',
    note: 'Every card pulled is recorded in the list.',
  },
  {
    value: 'selected_pulls',
    label: 'Selected pulls only',
    note: 'Opening results will only include the cards you recorded.',
  },
  {
    value: 'unknown',
    label: 'Not sure',
    note: 'Opening results will only include the cards you recorded.',
  },
]

export function completenessNote(value: TrackingCompleteness): string {
  return COMPLETENESS_OPTIONS.find((option) => option.value === value)?.note ?? ''
}
