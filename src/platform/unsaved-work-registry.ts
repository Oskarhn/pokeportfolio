import { useEffect, useRef, useState } from 'react'

/**
 * F-40 (P89): app-wide registry of "does some page currently hold unsaved user input" — the
 * single source of truth every automatic-reload/navigation decision must consult.
 *
 * Before this, the stale-deployment auto-reload (build-freshness-runtime.ts) asked ONLY the
 * scanner's own batch-size flag (src/features/scanner/unsaved-work.ts), on the untested
 * assumption that "the scanner batch is the app's only real in-memory unsaved work" (D-100).
 * Typed-but-unsubmitted input on any OTHER page — a purchase price, a sale detail, a portfolio
 * bulk-selection — was silently discarded by an unrelated automatic reload: a real regression
 * introduced BY the P83 stale-deployment fix itself, worse than the pre-P83 baseline (which never
 * force-reloaded anyone) on every route except Scanner.
 *
 * Deliberately a bare module-level Map, not a store/observable: nothing needs to REACT to
 * membership changing, only to read the current union at the moment a reload/navigation is being
 * considered — matching the same "read a point-in-time snapshot" shape
 * src/features/scanner/unsaved-work.ts already used for the scanner alone.
 */
export type UnsavedWorkGetter = () => boolean

const sources = new Map<string, UnsavedWorkGetter>()

/**
 * Registers one page/feature's own "am I dirty right now" check under a stable id. Returns an
 * unregister function — call it when the source stops being valid (component unmount) so a
 * stale getter from an unmounted page can never wrongly report unsaved work forever after.
 * Registering under an id that is already registered replaces the previous getter (the common
 * React-effect-rerun shape); the returned unregister function only removes ITS OWN getter, so an
 * out-of-order cleanup from a superseded registration can never evict a newer one.
 */
export function registerUnsavedWorkSource(id: string, getter: UnsavedWorkGetter): () => void {
  sources.set(id, getter)
  return () => {
    if (sources.get(id) === getter) sources.delete(id)
  }
}

/** True the instant ANY registered source currently reports unsaved work. */
export function hasAnyUnsavedWork(): boolean {
  for (const getter of sources.values()) {
    if (getter()) return true
  }
  return false
}

/** Test-only reset — production never needs to clear the whole registry mid-session. */
export function resetUnsavedWorkRegistryForTests(): void {
  sources.clear()
}

/**
 * React hook form of {@link registerUnsavedWorkSource}: registers `isDirty`'s CURRENT value
 * under `id` for as long as the calling component stays mounted. Re-registers only if `id`
 * itself changes (never on every dirty-value flip) — a `useRef` carries the latest `isDirty`
 * value into the stable getter closure so a rapidly-typing form does not churn the registry map
 * on every keystroke, and unregisters automatically on unmount.
 */
export function useUnsavedWorkSource(id: string, isDirty: boolean): void {
  const dirtyRef = useRef(isDirty)
  // Refs are only ever read/written from effects here — never during render — so this stays
  // clean under React's "no ref access during render" rule despite existing purely to avoid
  // re-registering on every keystroke.
  useEffect(() => {
    dirtyRef.current = isDirty
  }, [isDirty])
  useEffect(() => {
    return registerUnsavedWorkSource(id, () => dirtyRef.current)
  }, [id])
}

/**
 * Core baseline/diff bookkeeping behind {@link useIsDirtyByDiff}, extracted into a plain class so
 * it is directly unit-testable — this project has no React renderer/testing-library dependency
 * (see `KeyedPrefillGuard`/`CameraAcquisitionGuard` for the same extraction pattern, and this
 * file's own header comment for why the hook wrappers stay thin glue over testable core logic).
 *
 * D-110's disclosed residual: a component instance reused for a genuinely different logical
 * entity (e.g. `SaleFormPage` navigating from one holdingId set to another with no remount) must
 * not keep comparing the NEW entity's values against the OLD entity's baseline forever. Passing a
 * `resetKey` that changes when the entity changes makes the tracker discard its baseline and wait
 * to recapture it — exactly the identity/generation discipline `KeyedPrefillGuard` already uses
 * for the fetch itself, applied here to the diff baseline it feeds.
 */
const UNOBSERVED_RESET_KEY = Symbol('dirty-by-diff-baseline-unobserved')

export class DirtyByDiffBaseline {
  private resetKey: unknown = UNOBSERVED_RESET_KEY
  private baseline: string | undefined = undefined

  /**
   * Call on every tick with the current `resetKey`. If it differs from the last-observed value
   * (including the very first call, or a caller that never passes one — `undefined` is a normal
   * key), the baseline is discarded and this returns `true`, meaning `isDirty` must report `false`
   * until a baseline is recaptured. A caller whose `resetKey` never changes gets `false` forever
   * after its first (harmless) reset, preserving the original "capture once, ever" behavior.
   */
  observeResetKey(resetKey: unknown): boolean {
    if (this.resetKey === resetKey) return false
    this.resetKey = resetKey
    this.baseline = undefined
    return true
  }

  hasBaseline(): boolean {
    return this.baseline !== undefined
  }

  captureBaseline(serialized: string): void {
    this.baseline = serialized
  }

  isDirty(serialized: string): boolean {
    return this.baseline !== undefined && serialized !== this.baseline
  }
}

/**
 * Snapshots `values` on the first `ready` tick (of the current `resetKey`, see below) and reports
 * `true` from then on whenever a later tick's `values` no longer deep-equals (via JSON
 * serialization) that snapshot. Deliberately generic over per-field dirty logic: an "Add" form's
 * snapshot is its own empty defaults, an "Edit" form's snapshot is the record as fetched, and
 * either way "differs from where it started" is exactly what "unsaved work" means for a plain
 * form with no autosave. Cheap for the small field-count objects every caller in this codebase
 * passes (a handful of primitives plus a short line-item array), not intended for large/deeply
 * nested values.
 *
 * `ready` (P94 N-14): defaults to `true` — most callers have every field available synchronously
 * at mount. A form with an ASYNC one-time prefill (e.g. `SaleFormPage`'s holdingId(s) lookup) must
 * pass `false` until that prefill resolves: without it, the baseline snapshot is captured against
 * pre-prefill (typically empty) values, and the moment prefill's `setState` lands, the diff
 * against that stale baseline reports dirty with ZERO actual user edits — a false positive that
 * would trigger an unwanted "unsaved work" prompt on a page the user hasn't touched yet. While
 * `ready` is `false`, no baseline is captured AND no comparison runs (`isDirty` stays `false`);
 * the first tick where it is `true` captures the baseline from THAT tick's values.
 *
 * `resetKey` (D-110 residual fix): omit it for the common case (one entity per component
 * lifetime — the default `undefined` never changes, so behavior is identical to before this
 * parameter existed). Pass a value that identifies WHICH entity `values` currently describes for
 * a component instance that can be reused for a different entity without remounting (matching
 * `KeyedPrefillGuard`'s own `key` for the same form). When `resetKey` changes, any captured
 * baseline is discarded immediately — even before `ready` flips back to `true` for the new
 * entity — so `isDirty` reports `false` (never a stale true) while the new entity's own data is
 * still loading, and a fresh baseline is captured exactly once, from the new entity's own first
 * `ready` tick, rather than comparing it forever against the previous entity's snapshot.
 */
export function useIsDirtyByDiff(values: unknown, ready = true, resetKey?: unknown): boolean {
  const trackerRef = useRef(new DirtyByDiffBaseline())
  const [isDirty, setIsDirty] = useState(false)
  // Comparison happens inside an effect, never during render, so the initial snapshot and every
  // later comparison both stay off the render-phase ref-access rule; the one-tick delay between
  // a value changing and isDirty flipping is immaterial here — this only gates a decision made
  // in response to a background browser event (stale deployment / reload), never render output.
  useEffect(() => {
    const tracker = trackerRef.current
    if (tracker.observeResetKey(resetKey)) setIsDirty(false)
    if (!ready) return
    const serialized = JSON.stringify(values)
    if (!tracker.hasBaseline()) {
      tracker.captureBaseline(serialized)
      return
    }
    setIsDirty(tracker.isDirty(serialized))
  }, [values, ready, resetKey])
  return isDirty
}

/** Combines {@link useIsDirtyByDiff} and {@link useUnsavedWorkSource} — the one call most page
 *  components need: register `values`'s current dirty-by-diff state under `id`. `ready` and
 *  `resetKey` are {@link useIsDirtyByDiff}'s own parameters (P94 N-14; D-110), passed through
 *  unchanged. */
export function useUnsavedWorkSnapshot(
  id: string,
  values: unknown,
  ready = true,
  resetKey?: unknown,
): void {
  const isDirty = useIsDirtyByDiff(values, ready, resetKey)
  useUnsavedWorkSource(id, isDirty)
}
