import { localTodayIso } from './event-date'

/**
 * The raw string draft shape of each write form (P175). Every field is a STRING as the person
 * typed it — parsing into bigint/number happens only at submit time (`write/money-input.ts`,
 * `write/event-date.ts`), so an invalid or in-progress value never crashes the form and a blank
 * money field is preserved as `""`, not silently coerced. `contextKey` lets a screen tell whether
 * an existing draft still belongs to the entity it was opened for (see the screens' `useEffect`).
 */

export interface AcquisitionDraft {
  contextKey: string
  cardVariantId: string
  costKnown: boolean
  unitCostInput: string
  quantity: string
  condition: string
  acquiredOn: string
  notes: string
}

export function initialAcquisitionDraft(cardVariantId: string): AcquisitionDraft {
  return {
    contextKey: cardVariantId,
    cardVariantId,
    costKnown: true,
    unitCostInput: '',
    quantity: '1',
    condition: 'NM',
    acquiredOn: localTodayIso(),
    notes: '',
  }
}

export interface PurchaseDraft {
  contextKey: string
  cardVariantId: string
  quantity: string
  unitPriceInput: string
  currency: string
  shippingInput: string
  customsInput: string
  discountInput: string
  purchasedOn: string
  retailerName: string
  notes: string
}

export function initialPurchaseDraft(cardVariantId: string): PurchaseDraft {
  return {
    contextKey: cardVariantId,
    cardVariantId,
    quantity: '1',
    unitPriceInput: '',
    currency: 'NOK',
    shippingInput: '',
    customsInput: '',
    discountInput: '',
    purchasedOn: localTodayIso(),
    retailerName: '',
    notes: '',
  }
}

export interface SaleDraft {
  contextKey: string
  holdingId: string
  lotId: string
  quantity: string
  unitGrossInput: string
  currency: string
  feesInput: string
  shippingCostInput: string
  soldOn: string
  marketplace: string
  notes: string
}

export function initialSaleDraft(holdingId: string): SaleDraft {
  return {
    contextKey: holdingId,
    holdingId,
    lotId: '',
    quantity: '1',
    unitGrossInput: '',
    currency: 'NOK',
    feesInput: '',
    shippingCostInput: '',
    soldOn: localTodayIso(),
    marketplace: '',
    notes: '',
  }
}

export interface ManualValuationDraft {
  contextKey: string
  holdingId: string
  /** `null` = "clear the manual valuation"; a string (including `"0"`) = "set it to this amount".
   *  Kept as a tri-state on the draft itself so Clear and "set to zero" are never the same button. */
  mode: 'set' | 'clear'
  valueInput: string
  note: string
}

export function initialManualValuationDraft(holdingId: string): ManualValuationDraft {
  return { contextKey: holdingId, holdingId, mode: 'set', valueInput: '', note: '' }
}

export interface OpeningDraft {
  contextKey: string
  holdingId: string
  lotId: string
  quantity: string
  openedOn: string
  bulkRemainderEstimateInput: string
  notes: string
}

export function initialOpeningDraft(holdingId: string): OpeningDraft {
  return {
    contextKey: holdingId,
    holdingId,
    lotId: '',
    quantity: '1',
    openedOn: localTodayIso(),
    bulkRemainderEstimateInput: '',
    notes: '',
  }
}
