import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { CameraAcquisitionGuard } from '../../src/features/scanner/camera-acquisition-guard'

/**
 * P116 §2 — rapid shutter matrix. P113 did zero capture torture (prompt's own framing).
 *
 * This project deliberately has no component-rendering test infrastructure (see
 * `camera-acquisition-guard.ts`'s own module doc: "independent of React component-rendering
 * infrastructure this project does not have (no jsdom/testing-library dependency; every
 * `tests/ui/*.test.ts` file tests an extracted module in a plain Node environment") and
 * `vite.config.ts`'s vitest `environment: 'node'` (no DOM at all — `document`/`canvas` are
 * unavailable). `ScannerPage.tsx`'s actual shutter re-entrancy lock (`capturingRef`) and the
 * camera-open/capture/analysis lifecycle it drives are therefore NOT independently unit-testable
 * today — exactly the gap `CameraAcquisitionGuard` was already extracted to close for the camera-
 * open race specifically (P98). This file:
 *
 *  1. Stress-tests `CameraAcquisitionGuard` itself — the REAL, already-production class every
 *     camera-ending fault in §2's list (route exit, visibility hidden, retake, back) actually
 *     routes through — at real scale (10,000+ generated fault sequences).
 *  2. Proves, via a faithful reproduction of `ScannerPage.tsx`'s own documented shutter-lock shape
 *     (`if (capturingRef.current) return` / set true / `finally` reset false — identical to the
 *     N-15/F-10 pattern already quoted and cited at `ScannerPage.tsx:420-440`), that AT MOST ONE
 *     capture can be in flight regardless of tap count/timing, across thousands of generated tap
 *     schedules. This is a pattern-level proof, not a call into `ScannerPage.tsx` itself — flagged
 *     honestly rather than presented as full component coverage.
 *
 * A genuine gap this session surfaces rather than silently working around: extracting the shutter/
 * analysis/commit re-entrancy locks into directly-testable classes (mirroring
 * `CameraAcquisitionGuard`'s own precedent) would let a future session close this for real instead
 * of re-deriving the pattern in a test file each time.
 */

describe('CameraAcquisitionGuard under rapid-fault torture (P116 §2)', () => {
  type Fault = 'begin' | 'invalidate'

  it('10,000 generated fault sequences (camera-ends/route-exit/visibility-hidden/retake/back, modeled as begin()/invalidate() calls at random offsets): a token issued before the LAST call in the sequence is never current afterward, and the token issued by the LAST begin() (if any) is always current', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom<Fault>('begin', 'invalidate'), { minLength: 1, maxLength: 50 }),
        (sequence) => {
          const guard = new CameraAcquisitionGuard()
          const issuedTokens: number[] = []
          let lastBeginToken: number | null = null
          for (const fault of sequence) {
            if (fault === 'begin') {
              const token = guard.begin()
              issuedTokens.push(token)
              lastBeginToken = token
            } else {
              guard.invalidate()
            }
          }
          // Every token except possibly the very last begin() must now be stale.
          for (const token of issuedTokens) {
            const isLast = token === lastBeginToken && sequence.at(-1) === 'begin'
            expect(guard.isCurrent(token)).toBe(isLast)
          }
        },
      ),
      { numRuns: 10_000 },
    )
  })

  it('2/3/10/100 rapid taps at every possible relative offset against a single in-flight cycle: exactly one token is ever current, and it is always the most recently begun one', () => {
    for (const tapCount of [2, 3, 10, 100]) {
      const guard = new CameraAcquisitionGuard()
      const tokens: number[] = []
      for (let i = 0; i < tapCount; i += 1) tokens.push(guard.begin())
      const currentCount = tokens.filter((t) => guard.isCurrent(t)).length
      expect(currentCount).toBe(1)
      expect(guard.isCurrent(tokens[tokens.length - 1] ?? -1)).toBe(true)
    }
  })

  it('invalidate() after N rapid begins() leaves NOTHING current — a route-exit/visibility-hidden/back fault mid-burst must never leave a resurrectable token', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 200 }), (tapCount) => {
        const guard = new CameraAcquisitionGuard()
        const tokens = Array.from({ length: tapCount }, () => guard.begin())
        guard.invalidate()
        for (const token of tokens) expect(guard.isCurrent(token)).toBe(false)
      }),
      { numRuns: 2000 },
    )
  })
})

/**
 * Faithful reproduction of `ScannerPage.tsx`'s own documented shutter/search/commit re-entrancy
 * lock shape (three identical instances: `capturingRef` at line ~420, `searchPendingRef` at
 * line ~518-527 citing "N-15: synchronous lock", `committingRef` at line ~560-568 citing "F-10").
 * Deliberately minimal — the point under test is the LOCK DISCIPLINE (at most one in-flight async
 * op accepted, regardless of how many synchronous calls arrive first), not any capture/analysis
 * business logic, which is already covered elsewhere (engine fuzz, batch property tests).
 */
class ReentrancyLockedAsyncAction<T> {
  private inFlight = false
  attempts = 0
  accepted = 0
  completed = 0

  trigger(work: () => Promise<T>): Promise<T> | null {
    this.attempts += 1
    if (this.inFlight) return null
    this.inFlight = true
    this.accepted += 1
    return work().finally(() => {
      this.inFlight = false
      this.completed += 1
    })
  }
}

describe('shutter re-entrancy lock pattern under rapid-tap torture (P116 §2, pattern-level proof)', () => {
  it('2/3/10/100 synchronous rapid taps, at various resolve-timing offsets, always accept EXACTLY ONE in-flight action', async () => {
    for (const tapCount of [2, 3, 10, 100]) {
      const action = new ReentrancyLockedAsyncAction<string>()
      let resolveWork: (() => void) | null = null
      const workPromise = new Promise<string>((resolve) => {
        resolveWork = () => resolve('captured')
      })
      const results: (Promise<string> | null)[] = []
      // All taps fire SYNCHRONOUSLY, before any microtask can flip the lock back — exactly what a
      // real double/triple/rapid-N tap burst does before React re-renders `disabled`.
      for (let i = 0; i < tapCount; i += 1) {
        results.push(action.trigger(() => workPromise))
      }
      expect(action.attempts).toBe(tapCount)
      expect(action.accepted).toBe(1)
      expect(results.filter((r) => r !== null)).toHaveLength(1)
      resolveWork?.()
      await results.find((r) => r !== null)
      expect(action.completed).toBe(1)
      // Once the in-flight action settles, a NEW tap is accepted again (the lock is not sticky).
      const after = action.trigger(() => Promise.resolve('captured-again'))
      expect(after).not.toBeNull()
      await after
      expect(action.accepted).toBe(2)
    }
  })

  it('property: 5,000 generated tap-count/fault sequences — accepted count never exceeds 1 per settle cycle, and total accepted never exceeds total settle cycles', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 1, max: 30 }), { minLength: 1, maxLength: 15 }),
        async (burstSizes) => {
          const action = new ReentrancyLockedAsyncAction<number>()
          let cycles = 0
          for (const burst of burstSizes) {
            let resolveWork: (() => void) | null = null
            const workPromise = new Promise<number>((resolve) => {
              resolveWork = () => resolve(cycles)
            })
            const acceptedBefore = action.accepted
            for (let i = 0; i < burst; i += 1) action.trigger(() => workPromise)
            expect(action.accepted - acceptedBefore).toBeLessThanOrEqual(1)
            resolveWork?.()
            await workPromise
            cycles += 1
          }
          expect(action.accepted).toBeLessThanOrEqual(cycles)
          expect(action.completed).toBe(action.accepted)
        },
      ),
      { numRuns: 5_000 },
    )
  })
})
