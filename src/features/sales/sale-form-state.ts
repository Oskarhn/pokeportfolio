import type { AcquisitionLot } from '../../data/collection'
import type { CurrencyCode } from '../../domain/currency'
import { localTodayIso } from '../../platform/local-date'

/**
 * P109 full-entity-isolation fix. The P106/P107 audits established that `SaleFormPage`'s
 * same-instance holdingId(s) navigation (`/sales/new?holdingId=A` -> `/sales/new?holdingId=B`,
 * no `remountDeps` on this route) only ever cleared `items` on a genuine entity change — every
 * other submission-bound field (date, marketplace, currency, fees, shipping, notes, FX
 * mode/rate/date, the idempotency key, and any validation/error state) silently carried A's
 * values into B's sale. This module is the single source of truth for "what belongs to one Sale
 * Add attempt" and "what a genuine entity change resets it to" — extracted so the component and
 * its tests exercise the exact same reset logic, not a re-implementation of it.
 */

export interface LotSelection {
  quantity: number
  unitGrossInput: string
}

export interface ItemDraft {
  holdingId: string
  displayName: string
  subtitle: string
  imageBaseUrl: string | null
  /** null while the lots for this item are still loading. */
  lots: AcquisitionLot[] | null
  selections: Record<string, LotSelection>
}

/** Every field that names ONE specific Sale Add attempt. Global/account-level settings have no
 *  place here — there are none in this form; every field below is transaction-specific and must
 *  be reset on a genuine entity change (see {@link EntityKeyChangeTracker}). */
export interface SaleFormFields {
  items: ItemDraft[]
  soldOn: string
  marketplace: string
  currency: CurrencyCode
  feesInput: string
  shippingCostInput: string
  shippingChargedInput: string
  notes: string
  fxMode: 'norges_bank' | 'manual'
  fxRate: string
  fxRateDate: string
  fxError: string | null
  error: string | null
  /** Minted fresh by {@link createInitialSaleFormFields} — stable across ordinary rerenders and
   *  retries of the SAME logical sale, but must never survive a genuine entity change (a stale
   *  key covering what the user believes are two distinct sales risks the server's idempotency
   *  contract coalescing or rejecting the second one). */
  idempotencyKey: string
}

const defaultToday = localTodayIso

/** Fresh defaults for one brand-new Sale Add attempt, including a newly-minted idempotency key.
 *  Called at mount AND on every genuine entity change — the mount case and the entity-change case
 *  are the same operation, which is exactly why one function serves both. `today` is injectable
 *  only for deterministic tests; the component always calls it with no argument. */
export function createInitialSaleFormFields(today: () => string = defaultToday): SaleFormFields {
  return {
    items: [],
    soldOn: today(),
    marketplace: '',
    currency: 'NOK',
    feesInput: '',
    shippingCostInput: '',
    shippingChargedInput: '',
    notes: '',
    fxMode: 'norges_bank',
    fxRate: '',
    fxRateDate: '',
    fxError: null,
    error: null,
    idempotencyKey: crypto.randomUUID(),
  }
}

/**
 * `EntityKeyChangeTracker` mirrors `KeyedPrefillGuard`'s identity/generation discipline (this
 * project's own established pattern for "same component instance, different logical target") but
 * answers a different question: `KeyedPrefillGuard` guards one in-flight FETCH against a stale
 * result; this guards the whole FORM against stale in-flight WORK of any kind (a fetch, but also
 * a submission whose response arrives after the user has already moved on to a different entity —
 * see `SaleFormPage`'s submit-generation guard, §11 of the P109 prompt).
 *
 * P140: moved to `platform/entity-key-change-tracker.ts` so `PurchaseFormPage`,
 * `AddToCollectionPage` and `AddSealedProductPage` can reuse it for their own userId/entity
 * boundary without an awkward cross-feature import into `sales/`; re-exported here unchanged so
 * this module's existing consumers (`SaleFormPage.tsx`, this file's own tests) are unaffected.
 */
export { EntityKeyChangeTracker } from '../../platform/entity-key-change-tracker'
