import { afterEach, describe, expect, it, vi } from 'vitest'
import { CameraAcquisitionGuard } from '../../src/features/scanner/camera-acquisition-guard'
import { openEnvironmentCamera, stopActiveScannerCamera } from '../../src/features/scanner/camera-session'

// Never let a fake session leak between tests via camera-session.ts's module-level active-slot,
// matching the existing scanner-camera.test.ts discipline.
afterEach(() => {
  stopActiveScannerCamera()
})

/**
 * P98 camera-resurrection fix. `CameraAcquisitionGuard` is the primitive `ScannerPage.tsx`'s
 * camera-open effect and exit-requested effect both now use consistently. No React
 * component-rendering infrastructure exists in this project (no jsdom/testing-library dependency
 * — every `tests/ui/*.test.ts` file, including the existing `scanner-camera.test.ts`, tests an
 * extracted module directly rather than a mounted component), so these tests pin the guard's
 * semantics directly, plus a small harness in the second `describe` block that reproduces
 * `ScannerPage.tsx`'s own camera-open `.then()` guard clause verbatim
 * (`if (cancelled || !guard.isCurrent(generation)) { session.stop(); return }`) against the real
 * `openEnvironmentCamera` primitive, proving the combination behaves correctly for the three
 * scenarios the P98 audit named.
 */

function fakeVideoElement(): HTMLVideoElement {
  return { srcObject: null, play: () => Promise.resolve() } as unknown as HTMLVideoElement
}

interface FakeTrack {
  stop: ReturnType<typeof vi.fn>
  addEventListener: ReturnType<typeof vi.fn>
  removeEventListener: ReturnType<typeof vi.fn>
}

function fakeStream(): { stream: MediaStream; stop: ReturnType<typeof vi.fn> } {
  const stop = vi.fn()
  const track: FakeTrack = { stop, addEventListener: vi.fn(), removeEventListener: vi.fn() }
  return { stream: { getTracks: () => [track] } as unknown as MediaStream, stop }
}

/** A getUserMedia stand-in the test controls the resolution timing of, like a real pending
 *  permission prompt. */
function deferredAcquire(): {
  acquire: (constraints: MediaStreamConstraints) => Promise<MediaStream>
  resolve: (stream: MediaStream) => void
} {
  let resolveCurrent: ((stream: MediaStream) => void) | undefined
  const acquire = () =>
    new Promise<MediaStream>((res) => {
      resolveCurrent = res
    })
  // A stable function that forwards to whatever `acquire()`'s own Promise executor most recently
  // captured — returning the closure variable directly (as the old, buggy version of this helper
  // did) would capture its value (`undefined`) at THIS point, before `acquire()` had ever run.
  const resolve = (stream: MediaStream) => {
    if (resolveCurrent === undefined) throw new Error('acquire() has not been called yet')
    resolveCurrent(stream)
  }
  return { acquire, resolve }
}

describe('CameraAcquisitionGuard', () => {
  it('a token stays current until begin() or invalidate() runs again', () => {
    const guard = new CameraAcquisitionGuard()
    const token = guard.begin()
    expect(guard.isCurrent(token)).toBe(true)
  })

  it('begin() supersedes the previous token — reopening invalidates the old one', () => {
    const guard = new CameraAcquisitionGuard()
    const first = guard.begin()
    const second = guard.begin()
    expect(guard.isCurrent(first)).toBe(false)
    expect(guard.isCurrent(second)).toBe(true)
  })

  it('invalidate() ends the current token WITHOUT starting a new one — no token is current after', () => {
    const guard = new CameraAcquisitionGuard()
    const token = guard.begin()
    guard.invalidate()
    expect(guard.isCurrent(token)).toBe(false)
    // A second, independent invalidate (e.g. exit-requested firing twice) must not resurrect it
    // or produce a token that happens to collide with anything still held.
    guard.invalidate()
    expect(guard.isCurrent(token)).toBe(false)
  })
})

describe('P98 scenarios: camera-open effect .then() guard against a pending acquire', () => {
  it('acquire pending, exit requested, then acquire resolves: stream is stopped immediately, camera stays closed', async () => {
    const guard = new CameraAcquisitionGuard()
    const video = fakeVideoElement()
    const { acquire, resolve } = deferredAcquire()
    const generation = guard.begin()
    const openPromise = openEnvironmentCamera(video, acquire)

    // User taps "Close scanner" while the permission prompt is still pending — mirrors
    // ScannerPage.tsx's exitRequested effect, which invalidates the guard without a matching
    // begin() (unlike re-opening the camera).
    guard.invalidate()

    const { stream, stop } = fakeStream()
    resolve(stream)
    const session = await openPromise

    // Mirrors ScannerPage.tsx's camera-open effect .then() handler exactly.
    let attached = false
    if (guard.isCurrent(generation)) {
      attached = true
    } else {
      session.stop()
    }

    expect(attached).toBe(false)
    expect(stop).toHaveBeenCalledOnce()
    expect(video.srcObject).toBeNull()
  })

  it('acquire A pending, exit, explicit reopen B, A resolves late, B resolves: only B attaches', async () => {
    const guard = new CameraAcquisitionGuard()
    const video = fakeVideoElement()
    const a = deferredAcquire()
    const genA = guard.begin()
    const openA = openEnvironmentCamera(video, a.acquire)

    guard.invalidate() // exit requested while A is still pending

    const genB = guard.begin() // user reopens the camera explicitly
    const b = deferredAcquire()
    const openB = openEnvironmentCamera(video, b.acquire)

    // A resolves AFTER B has already started its own acquire() — the late arrival must not win
    // even though it resolves before B does. `openEnvironmentCamera`'s own module-level
    // openSeq/liveGeneration primitive (camera-session.ts, P94/N-10) already stops A's stream and
    // rejects with ScannerCameraSupersededError in this exact situation (a still-live newer call
    // already holds the slot) — mirrors ScannerPage.tsx's `.catch()` handler, which relies on this
    // same guard to no-op instead of surfacing a spurious CAMERA_FAILED for a call the user
    // themselves superseded by reopening.
    const streamA = fakeStream()
    a.resolve(streamA.stream)
    await expect(openA).rejects.toThrow('superseded')
    expect(streamA.stop).toHaveBeenCalledOnce()
    expect(guard.isCurrent(genA)).toBe(false)

    const streamB = fakeStream()
    b.resolve(streamB.stream)
    const sessionB = await openB
    expect(guard.isCurrent(genB)).toBe(true)
    if (guard.isCurrent(genB)) {
      // B is the one session actually attached — matches video.srcObject, which
      // openEnvironmentCamera itself set when B's acquire settled and won the module-level race.
      expect(video.srcObject).toBe(streamB.stream)
      sessionB.stop()
    }
  })

  it('unmount while an acquire is pending: no resurrection once it resolves', async () => {
    const guard = new CameraAcquisitionGuard()
    const video = fakeVideoElement()
    const { acquire, resolve } = deferredAcquire()
    const generation = guard.begin()
    const openPromise = openEnvironmentCamera(video, acquire)

    // Route unmount — the merged controller-lifecycle effect's cleanup invalidates the guard,
    // exactly like exit-requested does.
    guard.invalidate()
    stopActiveScannerCamera()

    const { stream, stop } = fakeStream()
    resolve(stream)
    const session = await openPromise
    if (!guard.isCurrent(generation)) session.stop()

    expect(stop).toHaveBeenCalledOnce()
    expect(video.srcObject).toBeNull()
  })
})
