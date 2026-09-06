/**
 * P98 cross-holding-leak fix. `SaleFormPage.tsx`'s holdingId(s) prefill needs BOTH properties a
 * plain one-shot ref latch cannot give it together: (1) run at most once per DISTINCT key — so
 * React StrictMode's synthetic double-invoke of the SAME key does not fire a second real network
 * request — and (2) actually run again when the key genuinely changes (a same-component-instance
 * navigation with no `remountDeps`), rather than silently no-opping forever the way the original
 * permanent `prefillStarted.current` latch did. `isCurrent` additionally guards every async
 * result against a NEWER key having superseded the one it was fetched for, so a late-arriving
 * result for an old key can never be applied against the form now showing a different key.
 *
 * Generic over `key` (not hardcoded to holdingIds) so any future keyed one-time-per-value prefill
 * in this codebase can reuse it instead of re-deriving the same guard.
 */
export class KeyedPrefillGuard {
  private startedKey: string | null = null
  private generation = 0

  /** Call at the top of the prefill effect. Returns the generation number this fetch owns, or
   *  `null` if `key` is already started/completed (the effect should no-op — same key, most
   *  likely StrictMode's synthetic re-invoke). A genuinely new `key` always returns a fresh,
   *  higher generation, immediately superseding whatever the previous key's generation was. */
  begin(key: string): number | null {
    if (this.startedKey === key) return null
    this.startedKey = key
    this.generation += 1
    return this.generation
  }

  /** True if `generation` still names the most recently begun fetch — i.e. no other `key` has
   *  called `begin()` since. A fetch whose generation is no longer current must not apply its
   *  result to any state the current key's form is showing. */
  isCurrent(generation: number): boolean {
    return generation === this.generation
  }
}
