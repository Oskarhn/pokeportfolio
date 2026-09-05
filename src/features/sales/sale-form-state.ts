import type { AcquisitionLot } from '../../data/collection'
import type { CurrencyCode } from '../../domain/currency'

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

function defaultToday(): string {
  return new Date().toISOString().slice(0, 10)
}

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
 * Detects a genuine entity-identity change from a stream of per-render key observations, and
 * hands out a monotonically increasing generation number for the entity currently in view.
 *
 * Mirrors `KeyedPrefillGuard`'s identity/generation discipline (this project's own established
 * pattern for "same component instance, different logical target") but answers a different
 * question: `KeyedPrefillGuard` guards one in-flight FETCH against a stale result; this guards the
 * whole FORM against stale in-flight WORK of any kind (a fetch, but also a submission whose
 * response arrives after the user has already moved on to a different entity — see
 * `SaleFormPage`'s submit-generation guard, §11 of the P109 prompt).
 *
 * Unlike `KeyedPrefillGuard.begin`, `observe` is side-effect-free with respect to "should I start
 * work" — it only reports identity, so it can be called every render/effect tick without
 * consuming anything.
 */
export class EntityKeyChangeTracker {
  private lastKey: string | null = null
  private seenFirst = false
  private currentGeneration = 0

  /**
   * Call once per render (or once per effect tick keyed on the same dependency) with the
   * current entity key. Returns `true` exactly when `key` differs from the previously observed
   * key — a genuine entity change the caller must reset its own state for. Never `true` on the
   * very first observation: a component's initial state (from {@link createInitialSaleFormFields})
   * is already fresh for whatever key it first renders with, so there is nothing to reset yet.
   */
  observe(key: string): boolean {
    if (!this.seenFirst) {
      this.seenFirst = true
      this.lastKey = key
      return false
    }
    if (this.lastKey === key) return false
    this.lastKey = key
    this.currentGeneration += 1
    return true
  }

  /** The generation number of the entity most recently observed. Capture this at the moment a
   *  submission begins; compare again when its response arrives. A mismatch means the user has
   *  since switched to a different entity, and the response must not mutate what is now on
   *  screen — the server-side effect already happened (or didn't) and is not undone by this. */
  generation(): number {
    return this.currentGeneration
  }
}
