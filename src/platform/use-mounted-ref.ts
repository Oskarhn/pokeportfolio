import { useEffect, useRef } from 'react'

/**
 * P124: a `key={id}`-remounted edit form (`PurchaseEditPage`, `SaleEditPage`) fully unmounts its
 * OLD instance on a genuine entity switch — but a mutation's `onSuccess`/`onError` callback is a
 * plain closure over that old instance's `id` and keeps running after unmount if the network
 * response arrives late. Left unguarded, a slow purchase/sale A save response, arriving after the
 * user has already navigated to B, still fires `invalidateQueries`/`navigate` for A: it yanks the
 * user away from wherever they now are back to A's page. Read this ref inside such a callback and
 * bail out if it has already flipped to `false`.
 *
 * The effect re-arms the ref (`true`) on every mount, not just the first render: under React
 * StrictMode (development) React mounts, runs the cleanup, and mounts again on the SAME instance,
 * and without the re-arm the ref stayed `false` for the life of a perfectly live form — its error
 * message and post-save navigation were silently skipped in development builds (found while
 * testing P144's edit-form blank-price regression against the Vite dev server).
 */
export function useIsMountedRef() {
  const ref = useRef(true)
  useEffect(() => {
    ref.current = true
    return () => {
      ref.current = false
    }
  }, [])
  return ref
}
