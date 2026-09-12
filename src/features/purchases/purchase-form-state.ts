import type { CurrencyCode } from '../../domain/currency'
import { localTodayIso } from '../../platform/local-date'
import { newLineDraft, type LineDraft } from './LineEditor'

/**
 * P124: pure state extraction for `PurchaseFormPage`, mirroring `sale-form-state.ts`'s pattern —
 * the twelve-plus separate `useState`s the component held inline are collected here into one
 * object so a property test can drive the exact reset logic the component uses, not a
 * re-implementation of it.
 *
 * Unlike Sale Add (`/sales/new?holdingId=...`, same component instance re-rendered across a
 * `holdingId` change), Purchase Add has no URL-driven entity identity — `/purchases/new` is a
 * single fresh mount every time, with no in-place "switch to a different purchase" transition to
 * guard against. `EntityKeyChangeTracker` therefore does not apply here; there is nothing playing
 * the role of `holdingId`. What this module DOES capture, matching P124 §7-8: the fresh-default
 * shape of one purchase attempt, the "start a new logical attempt" reset (currently reached only
 * by a full component remount after a successful submit — see `PurchaseFormPage`'s own comment on
 * `idempotencyKey`'s lifecycle, reproduced below), and a `patch`-style field updater so the
 * property test can drive the same shallow-merge shape the component uses.
 */

export interface PurchaseFormFields {
  purchasedOn: string
  retailerId: string
  newRetailerName: string
  currency: CurrencyCode
  lines: LineDraft[]
  shippingInput: string
  customsInput: string
  discountInput: string
  notes: string
  fxMode: 'norges_bank' | 'manual'
  fxRate: string
  fxRateDate: string
  fxError: string | null
  error: string | null
  /** Minted fresh by {@link createInitialPurchaseFormFields} — stable across ordinary rerenders
   *  and retries of the SAME logical purchase attempt (never regenerated merely because an error
   *  was shown), naturally rotated only by React unmounting/remounting this component (a genuine
   *  new navigation to `/purchases/new` after a successful submit). Mirrors Sale Add's identical
   *  contract — see P108/P107 §17. */
  idempotencyKey: string
}

const defaultToday = localTodayIso

/** Fresh defaults for one brand-new Purchase Add attempt, including a newly-minted idempotency
 *  key. `today` is injectable only for deterministic tests; the component always calls it with no
 *  argument. */
export function createInitialPurchaseFormFields(
  today: () => string = defaultToday,
): PurchaseFormFields {
  return {
    purchasedOn: today(),
    retailerId: '',
    newRetailerName: '',
    currency: 'NOK',
    lines: [newLineDraft()],
    shippingInput: '',
    customsInput: '',
    discountInput: '',
    notes: '',
    fxMode: 'norges_bank',
    fxRate: '',
    fxRateDate: '',
    fxError: null,
    error: null,
    idempotencyKey: crypto.randomUUID(),
  }
}

/** Shallow-merges `patch` into `fields`. Never used for `lines` (callers need the current array
 *  to map/filter) — those replace `lines` directly with a full array. */
export function patchPurchaseFormFields(
  fields: PurchaseFormFields,
  patch: Partial<PurchaseFormFields>,
): PurchaseFormFields {
  return { ...fields, ...patch }
}

export function updatePurchaseLine(
  fields: PurchaseFormFields,
  lineId: string,
  patch: Partial<LineDraft>,
): PurchaseFormFields {
  return {
    ...fields,
    lines: fields.lines.map((line) => (line.id === lineId ? { ...line, ...patch } : line)),
  }
}

export function addPurchaseLine(fields: PurchaseFormFields): PurchaseFormFields {
  return { ...fields, lines: [...fields.lines, newLineDraft()] }
}

export function removePurchaseLine(fields: PurchaseFormFields, lineId: string): PurchaseFormFields {
  return { ...fields, lines: fields.lines.filter((line) => line.id !== lineId) }
}
