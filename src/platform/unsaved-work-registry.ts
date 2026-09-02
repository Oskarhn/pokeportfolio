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
 * Snapshots `values` on first render and reports `true` from then on whenever a later render's
 * `values` no longer deep-equals (via JSON serialization) that snapshot. Deliberately generic
 * over per-field dirty logic: an "Add" form's snapshot is its own empty defaults, an "Edit"
 * form's snapshot is the record as fetched, and either way "differs from where it started" is
 * exactly what "unsaved work" means for a plain form with no autosave. Cheap for the small
 * field-count objects every caller in this codebase passes (a handful of primitives plus a short
 * line-item array), not intended for large/deeply nested values.
 */
export function useIsDirtyByDiff(values: unknown): boolean {
  const initialRef = useRef<string | undefined>(undefined)
  const [isDirty, setIsDirty] = useState(false)
  // Comparison happens inside an effect, never during render, so the initial snapshot and every
  // later comparison both stay off the render-phase ref-access rule; the one-tick delay between
  // a value changing and isDirty flipping is immaterial here — this only gates a decision made
  // in response to a background browser event (stale deployment / reload), never render output.
  useEffect(() => {
    const serialized = JSON.stringify(values)
    if (initialRef.current === undefined) {
      initialRef.current = serialized
      return
    }
    setIsDirty(serialized !== initialRef.current)
  }, [values])
  return isDirty
}

/** Combines {@link useIsDirtyByDiff} and {@link useUnsavedWorkSource} — the one call most page
 *  components need: register `values`'s current dirty-by-diff state under `id`. */
export function useUnsavedWorkSnapshot(id: string, values: unknown): void {
  const isDirty = useIsDirtyByDiff(values)
  useUnsavedWorkSource(id, isDirty)
}
