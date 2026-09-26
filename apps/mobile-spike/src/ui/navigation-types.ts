import type { NavigatorScreenParams } from '@react-navigation/native'
import type { P169StackParams } from '../features/navigation'

export type CollectionStackParams = {
  CollectionList: undefined
  CardDetail: { holdingId: string }
}

/**
 * The Search tab's native stack: catalog search -> card + printing + price, and the photo entry
 * (all registered from the Search / Price Check feature), plus two screens of the shell:
 *   - P170VariantEntry: a holding's "Check price" knows its printing (variant id) but not its card;
 *     this screen resolves the card, then replaces itself with the card screen.
 *   - P170AddIntent: where "Add to collection" lands. It is an intent only; nothing is saved.
 */
export type SearchStackParams = P169StackParams & {
  P170VariantEntry: { variantId: string }
  P170AddIntent: { cardId: string; variantId: string }
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
