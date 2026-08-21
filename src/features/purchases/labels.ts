import type { LineType, SpendClass } from '../../data/purchases'

/** UI labels for the M8 ledger. Internal term → UI label mapping matches FINANCIAL_MODEL.md §9. */

export const LINE_TYPE_LABEL: Record<LineType, string> = {
  card: 'Card',
  sealed: 'Sealed product',
  grading_fee: 'Grading fee',
  grading_shipping: 'Grading shipping',
  bulk_lot: 'Bulk lot',
  accessory: 'Accessory',
  shipping_standalone: 'Shipping',
  customs_standalone: 'Customs / import',
  other: 'Other',
}

export const SPEND_CLASS_LABEL: Record<SpendClass, string> = {
  collectible: 'Collectible',
  hobby: 'Accessory / hobby',
}

/** Line types the form treats as ordinary spend lines — no catalog reference, no inventory. */
export const SPEND_ONLY_LINE_TYPES: LineType[] = [
  'grading_fee',
  'grading_shipping',
  'bulk_lot',
  'accessory',
  'shipping_standalone',
  'customs_standalone',
  'other',
]

export const LINE_TYPE_OPTIONS: readonly (readonly [LineType, string])[] = [
  ['card', LINE_TYPE_LABEL.card],
  ['sealed', LINE_TYPE_LABEL.sealed],
  ['accessory', LINE_TYPE_LABEL.accessory],
  ['bulk_lot', LINE_TYPE_LABEL.bulk_lot],
  ['grading_fee', LINE_TYPE_LABEL.grading_fee],
  ['grading_shipping', LINE_TYPE_LABEL.grading_shipping],
  ['shipping_standalone', LINE_TYPE_LABEL.shipping_standalone],
  ['customs_standalone', LINE_TYPE_LABEL.customs_standalone],
  ['other', LINE_TYPE_LABEL.other],
]
