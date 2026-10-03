import type { NavigatorScreenParams } from '@react-navigation/native'
import type { P169StackParams } from '../features/navigation'

/**
 * P180: the human-readable card identity a screen needs to show instead of a raw
 * `card_variant_id`/catalog-card UUID. Built once, where the identity is already known (Price
 * Check's own confirmed card + printing, in `AddIntentScreen`), and carried through navigation
 * params rather than re-fetched — UUIDs stay internal identifiers, never rendered.
 */
export interface CardDisplaySummary {
  name: string
  setName: string
  collectorNumber: string
  languageLabel: string
  /** e.g. "Holo · Reverse" — empty when the printing has no distinguishing label. */
  printingLabel: string
}

export type CollectionStackParams = {
  CollectionList: undefined
  CardDetail: { holdingId: string }
  /** Record a sale of one of this holding's lots (P175). */
  RecordSale: { holdingId: string }
  /** Set/clear this holding's manual valuation (P175). */
  ManualValuation: { holdingId: string }
  /** Open one of this holding's sealed lots (P175, minimal form — see write/opening-writes.ts). */
  RecordOpening: { holdingId: string }
}

/**
 * The Search tab's native stack: catalog search -> card + printing + price, and the photo entry
 * (all registered from the Search / Price Check feature), plus screens of the shell:
 *   - P170VariantEntry: a holding's "Check price" knows its printing (variant id) but not its card;
 *     this screen resolves the card, then replaces itself with the card screen.
 *   - P170AddIntent: the hub reached from "Add to collection" — offers the acquisition form and the
 *     purchase form for the confirmed card + printing (P175; P173 left this as an explanatory
 *     read-only stub).
 *   - P175AddAcquisition / P175RecordPurchase: the two real write forms P170AddIntent leads to.
 */
export type SearchStackParams = P169StackParams & {
  P170VariantEntry: { variantId: string }
  P170AddIntent: { cardId: string; variantId: string }
  /** `cardDisplay` is optional only because a param type cannot force every existing caller to
   *  supply it; `AddIntentScreen` (the one real caller) always does — see P180_CARD_DISPLAY. */
  P175AddAcquisition: { cardId: string; variantId: string; cardDisplay?: CardDisplaySummary }
  P175RecordPurchase: { cardId: string; variantId: string; cardDisplay?: CardDisplaySummary }
}

/** The Price Check tab: a read-only landing; every price is read on the Search stack's card screen. */
export type PriceCheckStackParams = {
  PriceCheckHome: undefined
}

export type TabParams = {
  CollectionTab: NavigatorScreenParams<CollectionStackParams> | undefined
  SearchTab: NavigatorScreenParams<SearchStackParams> | undefined
  PriceCheckTab: NavigatorScreenParams<PriceCheckStackParams> | undefined
  ProfileTab: undefined
}
