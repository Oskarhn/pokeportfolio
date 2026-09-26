import { AuthController, type AuthClientPort } from '../auth/auth-controller'
import { IdentityAuthority } from '../auth/identity-authority'
import type { CollectionPort } from '../collection/types'
import { createP169Feature, type P169Feature, type P169FeatureDeps } from '../features/feature'
import { PhotoStore, type PhotoPort } from '../photo/photo-store'
import type { PriceCheckPort } from '../price-check/types'
import { CollectionStore } from '../state/collection-store'
import { HoldingDetailStore } from '../state/holding-detail-store'
import { NavigationMemory } from '../state/navigation-memory'
import { PriceCheckStore } from '../state/price-check-store'
import { ScopedRegistry } from '../state/registry'

/**
 * Composition root. Everything that talks to the outside world is injected, so the same wiring runs
 * in the app (real Supabase client, SecureStore, image picker) and in tests (fakes), and the identity
 * boundary is wired in exactly one place: an identity change resets EVERY registered user-scoped
 * store, synchronously.
 */

/** What the Search / Price Check feature needs from outside; the identity pieces come from here. */
export type PriceFeatureDeps = Omit<P169FeatureDeps, 'authority' | 'registry' | 'photo'>

export interface RuntimeDeps {
  auth: AuthClientPort
  removeStoredSession: () => Promise<void>
  collection: CollectionPort
  priceCheck: { released: PriceCheckPort; fixture: PriceCheckPort }
  /** Bound to the app's ONE Supabase client by the host (`client.functions.invoke`, fx reader). */
  priceFeature: PriceFeatureDeps
  photo: PhotoPort
}

export interface Runtime {
  authority: IdentityAuthority
  registry: ScopedRegistry
  auth: AuthController
  collection: CollectionStore
  holdingDetail: HoldingDetailStore
  priceCheck: PriceCheckStore
  /** Catalog search + read-only Price Check (P169). Its stores are in `registry` below. */
  feature: P169Feature
  photo: PhotoStore
  navigation: NavigationMemory
  ports: RuntimeDeps['priceCheck']
}

export function createRuntime(deps: RuntimeDeps): Runtime {
  const authority = new IdentityAuthority()
  const registry = new ScopedRegistry()

  const collection = new CollectionStore(deps.collection, authority)
  const holdingDetail = new HoldingDetailStore(deps.collection, authority)
  const priceCheck = new PriceCheckStore(deps.priceCheck.released, authority)
  const photo = new PhotoStore(deps.photo, authority)
  registry.register('collection', collection)
  registry.register('holding-detail', holdingDetail)
  registry.register('price-check', priceCheck)
  registry.register('photo', photo)
  const navigation = new NavigationMemory()
  registry.register('navigation', navigation)
  // Registers its own stores (catalog search, price lookup cache, price-check flow) in THIS registry
  // and leases their requests from THIS authority: one identity boundary for everything.
  const feature = createP169Feature({ ...deps.priceFeature, authority, registry, photo })

  const auth = new AuthController({
    auth: deps.auth,
    authority,
    onIdentityChange: () => {
      registry.resetAll()
    },
    removeStoredSession: deps.removeStoredSession,
  })

  return {
    authority,
    registry,
    auth,
    collection,
    holdingDetail,
    priceCheck,
    feature,
    photo,
    navigation,
    ports: deps.priceCheck,
  }
}

/** The React key of the authenticated subtree: same key = keep every component's state. */
export function identityKey(userId: string | null, epoch: number): string {
  return userId === null ? 'anonymous' : `user:${userId}:${String(epoch)}`
}
