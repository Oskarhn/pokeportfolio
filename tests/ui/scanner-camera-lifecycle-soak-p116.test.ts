import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  openEnvironmentCamera,
  stopActiveScannerCamera,
} from '../../src/features/scanner/camera-session'

/**
 * P116 §3 (Phase C) — camera session long soak. `scanner-camera-soak.test.ts` (P113 §8) proved
 * 1,000 clean sequential open→stop cycles with zero fault injection. The P116 brief explicitly
 * asks to go further: thousands more cycles AND randomized fault injection across the outcomes a
 * real device actually produces (permission rejection, NotReadableError, AbortError, a track
 * ending unexpectedly, and immediate re-entry without ever "using" the session) — not just the
 * happy path repeated.
 *
 * Deterministic: a seeded PRNG picks each cycle's outcome, so a failure reproduces exactly by
 * re-running with the same SEED named in the test title.
 *
 * `camera-session.ts`'s own invariant under test: exactly one active session may ever hold a live
 * stream (module-level `activeScannerSession` singleton, not a growing collection) and every track
 * this module ever creates is stopped exactly once, however the cycle that created it ended.
 */

function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type Outcome =
  | 'success'
  | 'permission-denied'
  | 'not-readable'
  | 'abort'
  | 'unexpected-end-after-open'
  | 'immediate-restop'

const OUTCOMES: Outcome[] = [
  'success',
  'permission-denied',
  'not-readable',
  'abort',
  'unexpected-end-after-open',
  'immediate-restop',
]

function fakeVideoElement(): HTMLVideoElement {
  return { srcObject: null, play: vi.fn(() => Promise.resolve()) } as unknown as HTMLVideoElement
}

interface LiveTrack {
  kind: 'video'
  stopped: boolean
  stop: () => void
  addEventListener: (event: string, handler: () => void) => void
  removeEventListener: (event: string, handler: () => void) => void
  fireEnded: () => void
}

interface Counters {
  streamsCreated: number
  tracksStopped: number
  endedListenersAdded: number
  endedListenersRemoved: number
  liveTracks: Set<LiveTrack>
}

function fakeStream(counters: Counters): { stream: MediaStream; track: LiveTrack } {
  counters.streamsCreated += 1
  let endedHandler: (() => void) | null = null
  const track: LiveTrack = {
    kind: 'video',
    stopped: false,
    stop: () => {
      if (track.stopped) return
      track.stopped = true
      counters.tracksStopped += 1
      counters.liveTracks.delete(track)
    },
    addEventListener: (event, handler) => {
      if (event !== 'ended') return
      endedHandler = handler
      counters.endedListenersAdded += 1
    },
    removeEventListener: (event) => {
      if (event !== 'ended') return
      endedHandler = null
      counters.endedListenersRemoved += 1
    },
    fireEnded: () => endedHandler?.(),
  }
  counters.liveTracks.add(track)
  const stream = { getTracks: () => [track] } as unknown as MediaStream
  return { stream, track }
}

afterEach(() => {
  stopActiveScannerCamera()
})

async function runSoak(cycles: number, seed: number): Promise<Counters> {
  const rng = mulberry32(seed)
  const counters: Counters = {
    streamsCreated: 0,
    tracksStopped: 0,
    endedListenersAdded: 0,
    endedListenersRemoved: 0,
    liveTracks: new Set(),
  }
  const video = fakeVideoElement()

  for (let i = 0; i < cycles; i += 1) {
    const outcome = OUTCOMES[Math.floor(rng() * OUTCOMES.length)]

    if (outcome === 'permission-denied' || outcome === 'not-readable' || outcome === 'abort') {
      const errorName =
        outcome === 'permission-denied'
          ? 'NotAllowedError'
          : outcome === 'not-readable'
            ? 'NotReadableError'
            : 'AbortError'
      await expect(
        openEnvironmentCamera(video, () =>
          Promise.reject(new DOMException(`synthetic ${errorName}`, errorName)),
        ),
      ).rejects.toThrow()
      // A failed acquire() must never leave a dangling live track and must never disturb an
      // already-active session from a PRIOR successful cycle (the module stops any previous
      // session unconditionally at the top of openEnvironmentCamera, before attempting acquire —
      // so a rejection here always finds zero live tracks by this point).
      expect(counters.liveTracks.size).toBe(0)
      continue
    }

    const { stream, track } = fakeStream(counters)
    const session = await openEnvironmentCamera(video, () => Promise.resolve(stream))
    expect(video.srcObject).toBe(stream)
    expect(counters.liveTracks.size).toBe(1) // at most one intended live stream, ever

    if (outcome === 'unexpected-end-after-open') {
      track.fireEnded() // hardware disconnect / permission revoke mid-session (L1, P70)
      expect(counters.liveTracks.size).toBe(0)
      expect(video.srcObject).toBeNull()
    } else if (outcome === 'immediate-restop') {
      session.stop()
      session.stop() // idempotency under soak, not just the P113 smoke case
      expect(counters.liveTracks.size).toBe(0)
    } else {
      session.stop()
      expect(counters.liveTracks.size).toBe(0)
      expect(video.srcObject).toBeNull()
    }
  }

  // Ownership token / next-open-still-functional check: after thousands of mixed
  // success/failure/unexpected-end cycles, one more clean open must still succeed exactly as the
  // very first one did.
  const { stream: finalStream } = fakeStream(counters)
  const finalSession = await openEnvironmentCamera(video, () => Promise.resolve(finalStream))
  expect(video.srcObject).toBe(finalStream)
  expect(counters.liveTracks.size).toBe(1)
  finalSession.stop()
  expect(counters.liveTracks.size).toBe(0)

  return counters
}

describe('camera session long soak with randomized fault injection (P116 §3 / Phase C)', () => {
  const PERMANENT_CYCLES = 5_000
  const SOAK_CYCLES = 10_000
  const SOAK_ENABLED = process.env.SCANNER_CAMERA_LIFECYCLE_SOAK === '1'
  const CYCLES = SOAK_ENABLED ? SOAK_CYCLES : PERMANENT_CYCLES
  const SEED = 0x116cafe

  it(
    `${String(CYCLES)} cycles of randomized camera-session outcomes (success / NotAllowedError / ` +
      'NotReadableError / AbortError / unexpected track-ended / immediate double-stop, seed ' +
      `0x${SEED.toString(16)}, SCANNER_CAMERA_LIFECYCLE_SOAK=1 for ${String(SOAK_CYCLES)}): zero orphan ` +
      'live tracks at any point, listener add/remove stay balanced, and the module remains ' +
      'functional for one final clean open after the soak',
    async () => {
      const counters = await runSoak(CYCLES, SEED)

      expect(counters.liveTracks.size).toBe(0)
      expect(counters.endedListenersAdded).toBe(counters.endedListenersRemoved)
      // Every stream this run ever created was eventually stopped exactly once — no leak survives
      // to the end of the soak regardless of which random outcome sequence produced it.
      expect(counters.tracksStopped).toBe(counters.streamsCreated)
    },
    SOAK_ENABLED ? 60_000 : 20_000,
  )

  it('a second independent seed reproduces the same invariants (not an artifact of one specific fault sequence)', async () => {
    const counters = await runSoak(PERMANENT_CYCLES, 0xdeadbeef)
    expect(counters.liveTracks.size).toBe(0)
    expect(counters.endedListenersAdded).toBe(counters.endedListenersRemoved)
    expect(counters.tracksStopped).toBe(counters.streamsCreated)
  })
})
