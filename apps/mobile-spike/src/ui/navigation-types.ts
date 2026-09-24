import type { NavigatorScreenParams } from '@react-navigation/native'

export type CollectionStackParams = {
  CollectionList: undefined
  CardDetail: { holdingId: string }
}

export type PriceCheckStackParams = {
  PriceCheckHome: undefined
  PriceCheckResult: { cardId?: string; variantId?: string }
  PhotoSpike: undefined
}

export type TabParams = {
  CollectionTab: NavigatorScreenParams<CollectionStackParams> | undefined
  SearchTab: undefined
  PriceCheckTab: NavigatorScreenParams<PriceCheckStackParams> | undefined
  ProfileTab: undefined
}
