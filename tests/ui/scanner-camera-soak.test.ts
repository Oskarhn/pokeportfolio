import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  openEnvironmentCamera,
  stopActiveScannerCamera,
} from '../../src/features/scanner/camera-session'

/**
 * P113 §8 — 1000 camera open/close cycles. `scanner-camera.test.ts` thoroughly covers the race
 * SEMANTICS (N-10 ordering matrix) at small scale (2-3 concurrent calls); this file instead runs
 * many SEQUENTIAL open→stop cycles with fake deterministic streams and tracks aggregate counters
 * across the whole run — created streams, stopped tracks, active tracks, and 'ended' listener
 * add/remove balance — the leak-detection shape prompt §8 asks for. `camera-session.ts`'s own
 * module-level state is a single active-session slot (never a growing collection), so this is
 * primarily a regression guard: it empirically proves that invariant rather than assuming it from
 * reading the source.
 */

type StopFn = ReturnType<typeof vi.fn>

function fakeVideoElement(): HTMLVideoElement {
  return { srcObject: null, play: vi.fn(() => Promise.resolve()) } as unknown as HTMLVideoElement
}

interface Counters {
  streamsCreated: number
  tracksStopped: number
  endedListenersAdded: number
  endedListenersRemoved: number
}

function fakeStreamWithCounters(counters: Counters): MediaStream {
  counters.streamsCreated += 1
  const stop: StopFn = vi.fn(() => {
    counters.tracksStopped += 1
  })
  const track = {
    kind: 'video',
    stop,
    addEventListener: vi.fn((event: string) => {
      if (event === 'ended') counters.endedListenersAdded += 1
    }),
    removeEventListener: vi.fn((event: string) => {
      if (event === 'ended') counters.endedListenersRemoved += 1
    }),
  }
  return { getTracks: () => [track] } as unknown as MediaStream
}

afterEach(() => {
  stopActiveScannerCamera()
})

describe('camera open/close soak (P113 §8)', () => {
  it('1000 sequential open→stop cycles: every stream stopped exactly once, every listener balanced, no leak', async () => {
    const CYCLES = 1000
    const counters: Counters = {
      streamsCreated: 0,
      tracksStopped: 0,
      endedListenersAdded: 0,
      endedListenersRemoved: 0,
    }
    const video = fakeVideoElement()

    for (let i = 0; i < CYCLES; i += 1) {
      const session = await openEnvironmentCamera(video, () =>
        Promise.resolve(fakeStreamWithCounters(counters)),
      )
      expect(video.srcObject).not.toBeNull()
      session.stop()
      expect(video.srcObject).toBeNull()
    }

    expect(counters.streamsCreated).toBe(CYCLES)
    // Exactly one stop() per cycle's own track — no cycle left a stream running, and no cycle's
    // stop() call was somehow skipped or doubled.
    expect(counters.tracksStopped).toBe(CYCLES)
    // Every 'ended' listener this run ever added was removed again by the matching stop() —
    // proves camera-session.ts never accumulates listeners across repeated cycles.
    expect(counters.endedListenersAdded).toBe(CYCLES)
    expect(counters.endedListenersRemoved).toBe(CYCLES)
  })

  it('1000 cycles with an occasional intentional double-stop() interleaved: still no double-counted stop, no leak', async () => {
    const CYCLES = 1000
    const counters: Counters = {
      streamsCreated: 0,
      tracksStopped: 0,
      endedListenersAdded: 0,
      endedListenersRemoved: 0,
    }
    const video = fakeVideoElement()

    for (let i = 0; i < CYCLES; i += 1) {
      const session = await openEnvironmentCamera(video, () =>
        Promise.resolve(fakeStreamWithCounters(counters)),
      )
      session.stop()
      if (i % 3 === 0) session.stop() // idempotency, exercised interleaved with the soak
    }

    expect(counters.streamsCreated).toBe(CYCLES)
    // Idempotent stop() must never re-stop an already-stopped track — the count stays exactly
    // one per cycle regardless of how many times THIS session's own stop() is called.
    expect(counters.tracksStopped).toBe(CYCLES)
    expect(counters.endedListenersAdded).toBe(counters.endedListenersRemoved)
  })
})
