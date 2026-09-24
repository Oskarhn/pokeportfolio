import { AuthController, type AuthClientPort } from '../auth/auth-controller'
import { IdentityAuthority } from '../auth/identity-authority'
import type { CollectionPort } from '../collection/types'
import { PhotoStore, type PhotoPort } from '../photo/photo-store'
import type { PriceCheckPort } from '../price-check/types'
import { CollectionStore } from '../state/collection-store'
import { HoldingDetailStore } from '../state/holding-detail-store'
import { PriceCheckStore } from '../state/price-check-store'
import { ScopedRegistry } from '../state/registry'

/**
 * Composition root. Everything that talks to the outside world is injected, so the same wiring runs
 * in the app (real Supabase client, SecureStore, image picker) and in tests (fakes), and the identity
 * boundary is wired in exactly one place: an identity change resets EVERY registered user-scoped
 * store, synchronously.
 */

export interface RuntimeDeps {
  auth: AuthClientPort
  removeStoredSession: () => Promise<void>
  collection: CollectionPort
  priceCheck: { released: PriceCheckPort; fixture: PriceCheckPort }
  photo: PhotoPort
}

export interface Runtime {
  authority: IdentityAuthority
  registry: ScopedRegistry
  auth: AuthController
  collection: CollectionStore
  holdingDetail: HoldingDetailStore
  priceCheck: PriceCheckStore
  photo: PhotoStore
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
    photo,
    ports: deps.priceCheck,
  }
}

/** The React key of the authenticated subtree: same key = keep every component's state. */
export function identityKey(userId: string | null, epoch: number): string {
  return userId === null ? 'anonymous' : `user:${userId}:${String(epoch)}`
}
