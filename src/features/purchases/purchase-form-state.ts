import type { CurrencyCode } from '../../domain/currency'
import { localTodayIso } from '../../platform/local-date'
import type { CardCondition, Grader, GradingState, SealedIntent } from '../../data/collection'
import type { LineType, SpendClass } from '../../data/purchases'

/**
 * P125: `LineDraft`/`newLineDraft` moved here from `LineEditor.tsx` (originally defined there,
 * imported back by this module). Both are pure — no data-layer or component dependency — but
 * living inside a `.tsx` component file that itself imports `../../data/catalog` (which throws at
 * module-eval time without `VITE_SUPABASE_URL`/`VITE_SUPABASE_PUBLISHABLE_KEY`) meant importing
 * `newLineDraft` here pulled that whole chain into any test — including this file's own
 * `purchase-form-state-property.test.ts` — that imports only this "pure state" module. CI's
 * `pnpm test` step deliberately never sets those env vars (only the later `Build` step does; see
 * `.github/workflows/ci.yml`), so this surfaced as a real Vitest module-load failure there. Moving
 * the definitions into this already-pure module and having `LineEditor.tsx` import them back fixes
 * the dependency direction: pure state no longer depends on a UI component file.
 */
export interface LineDraft {
  id: string
  lineType: LineType
  cardMode: 'catalog' | 'manual'
  cardVariantId: string | null
  cardDisplayName: string
  manualCardName: string
  sealedProductId: string | null
  sealedProductDisplayName: string
  sealedIntent: SealedIntent
  gradingState: GradingState
  condition: CardCondition
  grader: Grader
  grade: string
  certNumber: string
  manualValue: string
  description: string
  quantity: string
  unitPrice: string
  spendClassOverride: SpendClass | ''
  storageLocationId: string
  isFavorite: boolean
}

let draftCounter = 0
export function newLineDraft(lineType: LineType = 'card'): LineDraft {
  draftCounter += 1
  return {
    id: `line-${Date.now()}-${draftCounter}`,
    lineType,
    cardMode: 'catalog',
    cardVariantId: null,
    cardDisplayName: '',
    manualCardName: '',
    sealedProductId: null,
    sealedProductDisplayName: '',
    sealedIntent: 'undecided',
    gradingState: 'raw',
    condition: 'NM',
    grader: 'psa',
    grade: '',
    certNumber: '',
    manualValue: '',
    description: '',
    quantity: '1',
    unitPrice: '',
    spendClassOverride: '',
    storageLocationId: '',
    isFavorite: false,
  }
}

/**
 * P124: pure state extraction for `PurchaseFormPage`, mirroring `sale-form-state.ts`'s pattern —
 * the twelve-plus separate `useState`s the component held inline are collected here into one
 * object so a property test can drive the exact reset logic the component uses, not a
 * re-implementation of it.
 *
 * Unlike Sale Add (`/sales/new?holdingId=...`, same component instance re-rendered across a
 * `holdingId` change), Purchase Add has no URL-driven ENTITY identity — `/purchases/new` is a
 * single fresh mount every time, with no in-place "switch to a different purchase" transition to
 * guard against; nothing here plays the role of `holdingId`. What this module DOES capture,
 * matching P124 §7-8: the fresh-default shape of one purchase attempt, the "start a new logical
 * attempt" reset (reached by a full component remount after a successful submit, OR — as of P140
 * — by an explicit reset when the signed-in USER identity changes mid-mount without unmounting
 * the component; see `PurchaseFormPage`'s own comment on `idempotencyKey`'s lifecycle and its
 * `useEntityKeyReset` call, both reproduced below), and a `patch`-style field updater so the
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
