import { AuthController, type AuthClientPort } from '../auth/auth-controller'
import { IdentityAuthority } from '../auth/identity-authority'
import type { CollectionPort } from '../collection/types'
import { createP169Feature, type P169Feature, type P169FeatureDeps } from '../features/feature'
import type { FxRateReader } from '../features/price-check/fx-source'
import { PhotoStore, type PhotoPort } from '../photo/photo-store'
import type { PriceCheckPort } from '../price-check/types'
import { CollectionStore } from '../state/collection-store'
import { HoldingDetailStore } from '../state/holding-detail-store'
import { NavigationMemory } from '../state/navigation-memory'
import { PendingWritesStore } from '../state/pending-writes-store'
import { PriceCheckStore } from '../state/price-check-store'
import { ScopedRegistry } from '../state/registry'
import { WriteFormStore } from '../state/write-form-store'
import type { ExistsCheckerMap } from '../write/pending-write-reconciliation'
import type { PendingWriteJournal } from '../write/pending-write-journal'
import type { AddCardAcquisitionResult } from '../write/collection-writes'
import {
  initialAcquisitionDraft,
  initialManualValuationDraft,
  initialOpeningDraft,
  initialPurchaseDraft,
  initialSaleDraft,
  type AcquisitionDraft,
  type ManualValuationDraft,
  type OpeningDraft,
  type PurchaseDraft,
  type SaleDraft,
} from '../write/drafts'
import type { Opening } from '../write/opening-writes'
import type { Purchase } from '../write/purchase-writes'
import type { Sale } from '../write/sale-writes'
import type { WriteDbBinder } from '../write/write-db'

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
  /** The P175 finance write seam's client factory, bound by the host to ONE Supabase session (the
   *  app's real one, or the backend test harness's). See `write/write-db.ts`. */
  writeDb: WriteDbBinder
  /** P180: the SAME `fx_rates` reader Price Check already uses (`fxRateReaderFor(supabase)`, bound
   *  to the app's one ambient client), reused by the purchase/sale screens so a non-NOK write can
   *  supply `create_purchase`/`create_sale`'s required FX metadata instead of inventing a second FX
   *  source. Read-only: never used to freeze or alter a stored amount. */
  readFx: FxRateReader
  /** P180: process-death-after-commit reliability for the purchase/sale write flows — a bounded,
   *  device-secure journal (see write/pending-write-journal.ts) plus the read that tells
   *  reconciliation whether a pending entry's operation already committed. */
  pendingWrites: {
    journal: PendingWriteJournal
    existsCheckers: ExistsCheckerMap
  }
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
  /** P180: exposed at the top level (not nested under `feature`) so the purchase/sale screens can
   *  read it directly without depending on the whole Price Check feature. */
  readFx: FxRateReader
  /** P180: this identity's unresolved pending writes (reconciled on every identity change,
   *  including the initial sign-in — see state/pending-writes-store.ts). */
  pendingWrites: PendingWritesStore
  /** The financial write forms (P175) — one identity-scoped draft store per screen. */
  writeForms: {
    acquisition: WriteFormStore<AcquisitionDraft, AddCardAcquisitionResult>
    purchase: WriteFormStore<PurchaseDraft, Purchase>
    sale: WriteFormStore<SaleDraft, Sale>
    manualValuation: WriteFormStore<ManualValuationDraft, void>
    opening: WriteFormStore<OpeningDraft, Opening>
  }
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

  const writeForms = {
    acquisition: new WriteFormStore<AcquisitionDraft, AddCardAcquisitionResult>(
      authority,
      () => initialAcquisitionDraft(''),
      deps.writeDb,
    ),
    purchase: new WriteFormStore<PurchaseDraft, Purchase>(
      authority,
      () => initialPurchaseDraft(''),
      deps.writeDb,
      {
        journal: deps.pendingWrites.journal,
        operationKind: 'create_purchase',
        // Non-secret summary only (mission §10) — never the price, quantity or card identity.
        summarize: (draft) => ({ currency: draft.currency, purchasedOn: draft.purchasedOn }),
      },
    ),
    sale: new WriteFormStore<SaleDraft, Sale>(authority, () => initialSaleDraft(''), deps.writeDb, {
      journal: deps.pendingWrites.journal,
      operationKind: 'create_sale',
      summarize: (draft) => ({ currency: draft.currency, soldOn: draft.soldOn }),
    }),
    manualValuation: new WriteFormStore<ManualValuationDraft, void>(
      authority,
      () => initialManualValuationDraft(''),
      deps.writeDb,
    ),
    opening: new WriteFormStore<OpeningDraft, Opening>(
      authority,
      () => initialOpeningDraft(''),
      deps.writeDb,
    ),
  }
  registry.register('write-acquisition', writeForms.acquisition)
  registry.register('write-purchase', writeForms.purchase)
  registry.register('write-sale', writeForms.sale)
  registry.register('write-manual-valuation', writeForms.manualValuation)
  registry.register('write-opening', writeForms.opening)

  // P180: registered like every other user-scoped store, so the FIRST identity change (including
  // the initial sign-in on a fresh process) already triggers the "on restart, reconcile" pass the
  // mission asks for — no separate startup hook needed.
  const pendingWrites = new PendingWritesStore(
    authority,
    deps.pendingWrites.journal,
    deps.pendingWrites.existsCheckers,
  )
  registry.register('pending-writes', pendingWrites)

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
    readFx: deps.readFx,
    pendingWrites,
    writeForms,
  }
}

/** The React key of the authenticated subtree: same key = keep every component's state. */
export function identityKey(userId: string | null, epoch: number): string {
  return userId === null ? 'anonymous' : `user:${userId}:${String(epoch)}`
}
