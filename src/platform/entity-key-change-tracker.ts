import { useEffect, useRef } from 'react'

/**
 * Detects a genuine transition of some caller-defined "entity key" across renders of the SAME
 * component instance. Originally `SaleFormPage.tsx`'s own private class for its `holdingId(s)`
 * entity boundary (P109) — moved here (P140) so it can be shared outside the sales feature
 * without an awkward cross-feature import; `features/sales/sale-form-state.ts` re-exports it
 * unchanged so `SaleFormPage.tsx`'s existing import keeps working.
 *
 * Never fires on a component's first observation (its initial state is already fresh for
 * whatever key it first renders with) — only on a REAL change to a DIFFERENT key thereafter.
 */
export class EntityKeyChangeTracker {
  private lastKey: string | null = null
  private seenFirst = false
  private currentGeneration = 0

  /**
   * Call once per render (or once per effect tick keyed on the same dependency) with the
   * current entity key. Returns `true` exactly when `key` differs from the previously observed
   * key — a genuine entity change the caller must reset its own state for.
   */
  observe(key: string): boolean {
    if (!this.seenFirst) {
      this.seenFirst = true
      this.lastKey = key
      return false
    }
    if (this.lastKey === key) return false
    this.lastKey = key
    this.currentGeneration += 1
    return true
  }

  /** The generation number of the entity most recently observed. Capture this at the moment a
   *  submission begins; compare again when its response arrives. A mismatch means the caller has
   *  since switched to a different entity, and the response must not mutate what is now current. */
  generation(): number {
    return this.currentGeneration
  }
}

/**
 * P140: the reusable shape `EntityKeyChangeTracker` exists for — reset some component state the
 * moment `key` genuinely changes, without relying on the component being remounted.
 *
 * WHY THIS EXISTS: P130-23 found that this app's protected routes are never keyed by userId (see
 * `auth/guards.tsx`), so a same-tab identity change (another tab signs out A / signs in B —
 * supabase-js broadcasts the new session to every tab sharing the same browser storage, see
 * `AuthProvider.tsx`'s `onAuthStateChange`) does NOT unmount a mounted form. P130-04/05 (fixed in
 * P138) added per-mount idempotency-key/manual-card-resolution state to `PurchaseFormPage`,
 * `AddToCollectionPage` and `AddSealedProductPage` on the implicit assumption that a mount
 * boundary always separates one identity's attempt from another's — which P130-23 already showed
 * is false for this app. This hook is the explicit reset that state needed. It changes nothing
 * about session handling itself (RLS remains the real authorization boundary — see
 * `auth/guards.tsx`'s own doc); it only prevents a stale client-side write-idempotency artifact
 * (a request key, a resolved manual-card id) from surviving an identity change it was never
 * issued under. Also used for a narrower, non-identity case: `AddSealedProductPage`'s "choose a
 * different product" control changes which product a submission would be FOR without unmounting
 * the page, so its own entity key includes the selected product id — same mechanism, same reason
 * (a new logical intent, same component instance).
 *
 * `onKeyChanged` is a normal effect dependency (not a "latest ref" pattern — this project's lint
 * config flags a ref write during render): callers typically pass a fresh closure every render, so
 * this effect re-runs every render, but `EntityKeyChangeTracker.observe` is idempotent for an
 * unchanged key (always returns `false` again), so a render that didn't change `key` costs one
 * harmless extra `observe` call and never re-invokes `onKeyChanged`.
 */
export function useEntityKeyReset(key: string, onKeyChanged: () => void): void {
  const trackerRef = useRef(new EntityKeyChangeTracker())

  useEffect(() => {
    if (trackerRef.current.observe(key)) {
      onKeyChanged()
    }
  }, [key, onKeyChanged])
}
