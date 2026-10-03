import { getCardVariantPriceHistory } from '@shared/data/pricing'
import type { IdentityAuthority } from '../auth/identity-authority'
import type { PhotoStore } from '../photo/photo-store'
import { createReleasedPriceCheckPort } from '../price-check/released-adapter'
import type { ScopedRegistry } from '../state/registry'
import {
  createSharedCatalogSearchPort,
  type CatalogSearchPort,
} from './catalog-search/catalog-search-port'
import { CatalogSearchStore, type CatalogSearchEvent } from './catalog-search/catalog-search-store'
import type { FxRateReader } from './price-check/fx-source'
import { PriceCheckFlowStore, type CardReader } from './price-check/price-check-flow-store'
import { PriceLookupService, type PriceLookupEvent } from './price-check/price-lookup'
import { NATIVE_RECOGNITION_UNAVAILABLE, type CardRecognitionPort } from './price-check/recognition'
import type { SearchPricesInvoker } from './price-check/search-prices-source'
import type { SnapshotHistoryReader } from './price-check/snapshot-source'

/**
 * Composition of the P169 feature ON TOP of an existing runtime (src/wiring/runtime.ts), without
 * changing it: the stores register in the runtime's own ScopedRegistry, so the ONE identity boundary
 * (AuthController -> registry.resetAll) clears them together with every other user-scoped store,
 * synchronously, and the ONE IdentityAuthority leases their requests. There is no second auth store,
 * no second Supabase client (the invoker and fx reader are bound to the app's client by the host) and
 * no second money domain (the shared domain plus the vendored P165 price-check domain).
 */

export interface P169FeatureDeps {
  readonly authority: IdentityAuthority
  readonly registry: ScopedRegistry
  /** `(name, options) => supabase.functions.invoke(name, options)` on the app's one client. */
  readonly invoke: SearchPricesInvoker
  /** `fxRateReaderFor(supabase)` on the app's one client. */
  readonly readFx: FxRateReader
  readonly photo: PhotoStore
  readonly catalog?: CatalogSearchPort
  readonly readCard?: CardReader
  readonly readSnapshots?: SnapshotHistoryReader
  readonly recognition?: CardRecognitionPort
  readonly now?: () => number
  readonly onEvent?: (event: PriceLookupEvent | CatalogSearchEvent) => void
  readonly searchOptions?: ConstructorParameters<typeof CatalogSearchStore>[2]
}

export interface P169Feature {
  readonly search: CatalogSearchStore
  readonly priceCheck: PriceCheckFlowStore
  readonly prices: PriceLookupService
  readonly photo: PhotoStore
  readonly recognition: CardRecognitionPort
}

export function createP169Feature(deps: P169FeatureDeps): P169Feature {
  const now = deps.now ?? Date.now
  const prices = new PriceLookupService({
    invoke: deps.invoke,
    readFx: deps.readFx,
    readSnapshots: deps.readSnapshots ?? ((variantId) => getCardVariantPriceHistory(variantId)),
    now,
    ...(deps.onEvent !== undefined ? { onEvent: deps.onEvent } : {}),
  })
  const catalogPort = createReleasedPriceCheckPort()
  const readCard: CardReader = deps.readCard ?? ((cardId) => catalogPort.loadCard(cardId))
  const search = new CatalogSearchStore(
    deps.catalog ?? createSharedCatalogSearchPort(),
    deps.authority,
    {
      ...deps.searchOptions,
      ...(deps.onEvent !== undefined ? { onEvent: deps.onEvent } : {}),
    },
  )
  const priceCheck = new PriceCheckFlowStore(readCard, prices, deps.authority)
  deps.registry.register('p169-catalog-search', search)
  deps.registry.register('p169-price-lookup', prices)
  deps.registry.register('p169-price-check', priceCheck)
  const recognition = deps.recognition ?? NATIVE_RECOGNITION_UNAVAILABLE
  // A recognition started for user A must never publish under user B (P184): the port's own reset
  // invalidates it synchronously with the rest of the identity boundary.
  if (recognition.reset !== undefined) {
    deps.registry.register('p169-recognition', { reset: () => recognition.reset?.() })
  }
  return {
    search,
    priceCheck,
    prices,
    photo: deps.photo,
    recognition,
  }
}
