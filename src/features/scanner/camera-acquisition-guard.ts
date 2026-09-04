/**
 * P98 camera-resurrection fix: `ScannerPage.tsx`'s OWN "do I still want a live camera right now"
 * generation counter — distinct from `camera-session.ts`'s `openSeq`/`liveGeneration` primitive,
 * which instead answers "which overlapping `acquire()` call is authoritative for the shared
 * MediaStream slot" (P94/N-10). Both exist because they answer different questions: a call can
 * correctly win the camera-session module's own race and still be something the PAGE no longer
 * wants (the user tapped "Close scanner" while a permission prompt was pending) — this guard is
 * what lets the page's own `.then()` handler tell the two situations apart.
 *
 * Extracted as its own class (rather than left as a bare `useRef<number>`) so its exact semantics
 * — a token is current if and only if nothing has begun a new cycle or explicitly invalidated the
 * guard since that token was issued — are pinned by a direct unit test, independent of React
 * component-rendering infrastructure this project does not have (no jsdom/testing-library
 * dependency; every `tests/ui/*.test.ts` file tests an extracted module in a plain Node
 * environment, never a mounted component).
 */
export class CameraAcquisitionGuard {
  private generation = 0

  /** Begins a new desired-camera-open cycle and returns the token it owns. Every prior token
   *  (including one still in flight) stops being current the instant this is called. */
  begin(): number {
    this.generation += 1
    return this.generation
  }

  /** Invalidates whatever cycle is current WITHOUT starting a new one — the camera is no longer
   *  wanted at all (exit requested, route unmount, tab hidden), as opposed to `begin()`'s "a NEW
   *  cycle now supersedes the old one" (re-opening the camera). Any token issued before this call
   *  stops being current; a still-pending `acquire()` resolving afterward must stop its own stream
   *  rather than attach it. */
  invalidate(): void {
    this.generation += 1
  }

  /** True if `token` still names the current cycle — i.e. neither `begin()` nor `invalidate()`
   *  has run since the caller received it via `begin()`. */
  isCurrent(token: number): boolean {
    return token === this.generation
  }
}
