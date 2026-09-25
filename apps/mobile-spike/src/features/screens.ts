import { CatalogSearchScreen } from './catalog-search/CatalogSearchScreen'
import type { P169ScreenRegistration } from './navigation'
import { CardPriceScreen } from './price-check/CardPriceScreen'
import { PhotoEntryScreen } from './price-check/PhotoEntryScreen'

/** The screens a host stack registers (see ./navigation.tsx for the full contract). */
export const P169_SCREENS: readonly P169ScreenRegistration[] = [
  { name: 'P169Search', title: 'Search cards', component: CatalogSearchScreen },
  { name: 'P169Card', title: 'Price Check', component: CardPriceScreen },
  { name: 'P169PhotoEntry', title: 'From a photo', component: PhotoEntryScreen },
]

export { createP169Feature, type P169Feature, type P169FeatureDeps } from './feature'
export { P169FeatureProvider, type P169Host, type P169StackParams } from './navigation'
export type { AddToCollectionIntent } from './price-check/price-check-flow-store'
