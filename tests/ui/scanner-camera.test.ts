import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CAMERA_VIDEO_PROPS,
  openEnvironmentCamera,
  ScannerCameraSupersededError,
  stopActiveScannerCamera,
  visibilityChangeAction,
} from '../../src/features/scanner/camera-session'
import { describeCameraError, hasMediaDevicesSupport } from '../../src/features/scanner/errors'

/**
 * Camera lifecycle rules (prompt §7/§8) verified with fake tracks and an injectable acquire
 * function in a plain Node environment — the same platform-stub discipline as the M13
 * file-delivery tests. The DOMException-name → friendly-copy mapping (§24) is pinned here too,
 * including that camera-denied copy points at "Choose photo", the only remaining path.
 */

type StopFn = ReturnType<typeof vi.fn>

function fakeVideoElement(): { video: HTMLVideoElement; play: StopFn } {
  const play = vi.fn(() => Promise.resolve())
  const video = {
    srcObject: null,
    play,
  } as unknown as HTMLVideoElement
  return { video, play }
}

interface FakeTrack {
  kind: string
  stop: StopFn
  addEventListener: StopFn
  removeEventListener: StopFn
  /** Test helper: simulates the browser firing 'ended' on this track (hardware disconnect,
   *  permission revoke). No-op once the listener has been removed. */
  fireEnded: () => void
}

function fakeStream(trackCount = 1): { stream: MediaStream; stops: StopFn[]; tracks: FakeTrack[] } {
  const stops = Array.from({ length: trackCount }, () => vi.fn())
  const tracks: FakeTrack[] = stops.map((stop, index) => {
    let endedHandler: (() => void) | undefined
    const track: FakeTrack = {
      kind: index === 0 ? 'video' : 'audio',
      stop,
      addEventListener: vi.fn((event: string, handler: () => void) => {
        if (event === 'ended') endedHandler = handler
      }),
      removeEventListener: vi.fn((event: string) => {
        if (event === 'ended') endedHandler = undefined
      }),
      fireEnded: () => endedHandler?.(),
    }
    return track
  })
  return { stream: { getTracks: () => tracks } as unknown as MediaStream, stops, tracks }
}

afterEach(() => {
  // Never let a fake session leak between tests via the module-level active-session slot.
  stopActiveScannerCamera()
})

describe('camera start semantics', () => {
  it('the preview video carries autoplay + muted + playsInline (iOS-safe inline playback)', () => {
    expect(CAMERA_VIDEO_PROPS.autoPlay).toBe(true)
    expect(CAMERA_VIDEO_PROPS.muted).toBe(true)
    expect(CAMERA_VIDEO_PROPS.playsInline).toBe(true)
  })

  it('requests the environment-facing camera with audio disabled', async () => {
    const acquire = vi.fn(() => Promise.resolve(fakeStream().stream))
    const { video } = fakeVideoElement()
    await openEnvironmentCamera(video, acquire)
    expect(acquire).toHaveBeenCalledWith({
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1920 },
        height: { ideal: 1920 },
      },
      audio: false,
    })
  })

  it('requests a resolution ideal, never exact — a device below it must still open (P79)', async () => {
    const acquire = vi.fn<(constraints: MediaStreamConstraints) => Promise<MediaStream>>(() =>
      Promise.resolve(fakeStream().stream),
    )
    const { video } = fakeVideoElement()
    await openEnvironmentCamera(video, acquire)
    const constraints = acquire.mock.calls[0]?.[0]
    if (constraints === undefined) throw new Error('acquire was never called')
    const videoConstraints = constraints.video as MediaTrackConstraints
    expect(videoConstraints.width).toEqual({ ideal: 1920 })
    expect(videoConstraints.height).toEqual({ ideal: 1920 })
    expect(videoConstraints.width).not.toHaveProperty('exact')
    expect(videoConstraints.width).not.toHaveProperty('min')
  })

  it('attaches the live stream to the video element and awaits play', async () => {
    const { stream } = fakeStream()
    const { video, play } = fakeVideoElement()
    await openEnvironmentCamera(video, () => Promise.resolve(stream))
    expect(video.srcObject).toBe(stream)
    expect(play).toHaveBeenCalledOnce()
  })

  it('a rejected play() never fails the start — the stream is live regardless', async () => {
    const { video, play } = fakeVideoElement()
    play.mockReturnValueOnce(Promise.reject(new Error('autoplay policy')))
    const session = await openEnvironmentCamera(video, () => Promise.resolve(fakeStream().stream))
    expect(video.srcObject).not.toBeNull()
    session.stop()
  })

  it('with no mediaDevices surface at all, the unsupported error is thrown for friendly mapping', async () => {
    vi.stubGlobal('navigator', {})
    try {
      const { video } = fakeVideoElement()
      await expect(openEnvironmentCamera(video)).rejects.toMatchObject({
        name: 'ScannerCameraUnsupportedError',
      })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('the default acquire path calls getUserMedia through navigator.mediaDevices', async () => {
    const { stream } = fakeStream()
    const getUserMedia = vi.fn(() => Promise.resolve(stream))
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })
    try {
      const { video } = fakeVideoElement()
      const session = await openEnvironmentCamera(video)
      expect(getUserMedia).toHaveBeenCalledWith({
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1920 },
          height: { ideal: 1920 },
        },
        audio: false,
      })
      session.stop()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('camera teardown guarantees', () => {
  it('stop() stops EVERY track, detaches the stream, and is idempotent', async () => {
    const { stream, stops } = fakeStream(2)
    const { video } = fakeVideoElement()
    const session = await openEnvironmentCamera(video, () => Promise.resolve(stream))
    session.stop()
    session.stop()
    expect(stops[0]).toHaveBeenCalledTimes(1)
    expect(stops[1]).toHaveBeenCalledTimes(1)
    expect(video.srcObject).toBeNull()
  })

  it('opening a new session while one is live stops the old one first — never two streams', async () => {
    const first = fakeStream(1)
    const second = fakeStream(1)
    const { video } = fakeVideoElement()
    const firstSession = await openEnvironmentCamera(video, () => Promise.resolve(first.stream))
    const secondSession = await openEnvironmentCamera(video, () => Promise.resolve(second.stream))
    expect(first.stops[0]).toHaveBeenCalledTimes(1)
    expect(second.stops[0]).not.toHaveBeenCalled()
    secondSession.stop()
    void firstSession
  })

  it('two concurrent unresolved getUserMedia calls leave exactly one live stream — the loser REJECTS, never a fake success (F-06/N-10)', async () => {
    const first = fakeStream(1)
    const second = fakeStream(1)
    const { video } = fakeVideoElement()
    let resolveFirstAcquire!: (stream: MediaStream) => void
    let resolveSecondAcquire!: (stream: MediaStream) => void
    const firstAcquire = vi.fn(
      () =>
        new Promise<MediaStream>((resolve) => {
          resolveFirstAcquire = resolve
        }),
    )
    const secondAcquire = vi.fn(
      () =>
        new Promise<MediaStream>((resolve) => {
          resolveSecondAcquire = resolve
        }),
    )
    // Neither call is awaited before the next starts — both getUserMedia calls are in flight
    // simultaneously, which is exactly the race the module-level active-session check alone
    // cannot serialize against.
    const firstPromise = openEnvironmentCamera(video, firstAcquire)
    const secondPromise = openEnvironmentCamera(video, secondAcquire)
    // Resolve the SECOND call's getUserMedia first — the primitive must still let the LATER
    // (second) call win regardless of settle order, not whichever getUserMedia promise happens
    // to resolve first.
    resolveSecondAcquire(second.stream)
    resolveFirstAcquire(first.stream)
    // The loser (first) must reject clearly — the pre-N-10 bug resolved it as a fake success with
    // a dead, already-stopped stream and no error surfaced anywhere.
    await expect(firstPromise).rejects.toThrow(ScannerCameraSupersededError)
    const secondSession = await secondPromise
    expect(first.stops[0]).toHaveBeenCalledTimes(1)
    expect(second.stops[0]).not.toHaveBeenCalled()
    expect(video.srcObject).toBe(second.stream)
    secondSession.stop()
  })

  describe('N-10 ordering matrix — a call that fails must never wrongly invalidate an unrelated in-flight or later call', () => {
    it('B (started after A, still in flight) rejects; A (started first, still in flight) later succeeds — A must win, not be misclassified as stale (the exact P92 bug)', async () => {
      const aStream = fakeStream(1)
      const { video } = fakeVideoElement()
      let resolveA!: (stream: MediaStream) => void
      let rejectB!: (error: unknown) => void
      const acquireA = vi.fn(() => new Promise<MediaStream>((resolve) => (resolveA = resolve)))
      const acquireB = vi.fn(
        () => new Promise<MediaStream>((_resolve, reject) => (rejectB = reject)),
      )
      const promiseA = openEnvironmentCamera(video, acquireA)
      const promiseB = openEnvironmentCamera(video, acquireB)
      rejectB(new Error('getUserMedia denied'))
      await expect(promiseB).rejects.toThrow('getUserMedia denied')
      resolveA(aStream.stream)
      const sessionA = await promiseA
      expect(video.srcObject).toBe(aStream.stream)
      expect(aStream.stops[0]).not.toHaveBeenCalled()
      sessionA.stop()
    })

    it('A rejects, B (started after) succeeds — ordinary case, unaffected', async () => {
      const bStream = fakeStream(1)
      const { video } = fakeVideoElement()
      let rejectA!: (error: unknown) => void
      let resolveB!: (stream: MediaStream) => void
      const acquireA = vi.fn(
        () => new Promise<MediaStream>((_resolve, reject) => (rejectA = reject)),
      )
      const acquireB = vi.fn(() => new Promise<MediaStream>((resolve) => (resolveB = resolve)))
      const promiseA = openEnvironmentCamera(video, acquireA)
      const promiseB = openEnvironmentCamera(video, acquireB)
      rejectA(new Error('denied'))
      await expect(promiseA).rejects.toThrow('denied')
      resolveB(bStream.stream)
      const sessionB = await promiseB
      expect(video.srcObject).toBe(bStream.stream)
      sessionB.stop()
    })

    it('both A and B reject — no active session, no unhandled state corruption for a later C', async () => {
      const { video } = fakeVideoElement()
      let rejectA!: (error: unknown) => void
      let rejectB!: (error: unknown) => void
      const acquireA = vi.fn(
        () => new Promise<MediaStream>((_resolve, reject) => (rejectA = reject)),
      )
      const acquireB = vi.fn(
        () => new Promise<MediaStream>((_resolve, reject) => (rejectB = reject)),
      )
      const promiseA = openEnvironmentCamera(video, acquireA)
      const promiseB = openEnvironmentCamera(video, acquireB)
      rejectB(new Error('B denied'))
      await expect(promiseB).rejects.toThrow('B denied')
      rejectA(new Error('A denied'))
      await expect(promiseA).rejects.toThrow('A denied')

      // A fresh call afterward must behave normally — no residual state from the two failures.
      const cStream = fakeStream(1)
      const sessionC = await openEnvironmentCamera(video, () => Promise.resolve(cStream.stream))
      expect(video.srcObject).toBe(cStream.stream)
      sessionC.stop()
    })

    it('a third request C supersedes a still-queued B before B even settles; C wins, B rejects', async () => {
      const cStream = fakeStream(1)
      const { video } = fakeVideoElement()
      let resolveB!: (stream: MediaStream) => void
      const acquireA = vi.fn(() => Promise.resolve(fakeStream(1).stream))
      const acquireB = vi.fn(() => new Promise<MediaStream>((resolve) => (resolveB = resolve)))
      const acquireC = vi.fn(() => Promise.resolve(cStream.stream))
      await openEnvironmentCamera(video, acquireA) // A settles immediately, becomes active first
      const promiseB = openEnvironmentCamera(video, acquireB) // still pending
      const promiseC = openEnvironmentCamera(video, acquireC) // C supersedes B before B resolves
      const sessionC = await promiseC
      expect(video.srcObject).toBe(cStream.stream)
      resolveB(fakeStream(1).stream)
      await expect(promiseB).rejects.toThrow(ScannerCameraSupersededError)
      // C is still the one and only live session after B's late resolution.
      expect(video.srcObject).toBe(cStream.stream)
      sessionC.stop()
    })

    it('unmount mid-flight: the caller-side generation guard discards a late resolution instead of leaking a stream', async () => {
      // Mirrors ScannerPage.tsx's own cameraGenerationRef pattern directly against the primitive.
      const { video } = fakeVideoElement()
      let resolveA!: (stream: MediaStream) => void
      const acquireA = vi.fn(() => new Promise<MediaStream>((resolve) => (resolveA = resolve)))
      let callerGeneration = 1
      const myGeneration = callerGeneration
      const promise = openEnvironmentCamera(video, acquireA)
      // Simulate unmount: caller bumps its own generation and would call stopActiveScannerCamera().
      callerGeneration += 1
      stopActiveScannerCamera()
      const aStream = fakeStream(1)
      resolveA(aStream.stream)
      const session = await promise
      // The primitive itself has no idea about the unmount — it resolved successfully. The
      // CALLER'S OWN guard (already shipped in ScannerPage.tsx) is what must stop the now-unwanted
      // session rather than leaving a live stream attached to a torn-down video element.
      if (myGeneration !== callerGeneration) session.stop()
      expect(aStream.stops[0]).toHaveBeenCalledTimes(1)
    })
  })

  it('the safety valve used on unmount/visibility stops whatever session exists', async () => {
    const { stream, stops } = fakeStream(1)
    const { video } = fakeVideoElement()
    await openEnvironmentCamera(video, () => Promise.resolve(stream))
    stopActiveScannerCamera()
    expect(stops[0]).toHaveBeenCalledTimes(1)
    expect(video.srcObject).toBeNull()
  })
})

describe('unexpected track-ended handling (P70, prompt §13)', () => {
  it('an unexpected ended event stops the session and calls onEnded', async () => {
    const { stream, stops, tracks } = fakeStream(1)
    const { video } = fakeVideoElement()
    const onEnded = vi.fn()
    await openEnvironmentCamera(video, () => Promise.resolve(stream), onEnded)
    tracks[0]?.fireEnded()
    expect(stops[0]).toHaveBeenCalledTimes(1)
    expect(video.srcObject).toBeNull()
    expect(onEnded).toHaveBeenCalledTimes(1)
  })

  it('an intentional stop() removes the ended listener first — no false onEnded call', async () => {
    const { stream, tracks } = fakeStream(1)
    const { video } = fakeVideoElement()
    const onEnded = vi.fn()
    const session = await openEnvironmentCamera(video, () => Promise.resolve(stream), onEnded)
    session.stop()
    // Simulate a browser that still fires 'ended' after stop() — the handler must already be gone.
    tracks[0]?.fireEnded()
    expect(onEnded).not.toHaveBeenCalled()
  })

  it('a repeated ended event on an already-stopped session is a no-op', async () => {
    const { stream, stops, tracks } = fakeStream(1)
    const { video } = fakeVideoElement()
    const onEnded = vi.fn()
    await openEnvironmentCamera(video, () => Promise.resolve(stream), onEnded)
    tracks[0]?.fireEnded()
    tracks[0]?.fireEnded()
    expect(stops[0]).toHaveBeenCalledTimes(1)
    expect(onEnded).toHaveBeenCalledTimes(1)
  })
})

describe('visibility policy', () => {
  it('releases the hardware when the page hides; keeps it while visible', () => {
    expect(visibilityChangeAction('hidden')).toBe('stop')
    expect(visibilityChangeAction('visible')).toBe('keep')
  })
})

describe('support detection and error mapping', () => {
  it('detects a usable mediaDevices surface precisely', () => {
    expect(hasMediaDevicesSupport(undefined)).toBe(false)
    expect(hasMediaDevicesSupport({})).toBe(false)
    expect(hasMediaDevicesSupport({ mediaDevices: {} })).toBe(false)
    expect(hasMediaDevicesSupport({ mediaDevices: { getUserMedia: () => undefined } })).toBe(true)
  })

  it('permission denied maps to copy that names the Choose-photo fallback', () => {
    const info = describeCameraError(new DOMException('denied', 'NotAllowedError'))
    expect(info.title).toBe('Camera access was blocked')
    expect(info.message).toContain('Choose photo')
    expect(info.message).not.toMatch(/DOMException|NotAllowedError/)
  })

  it('a missing camera maps to honest unavailable copy, not raw internals', () => {
    const info = describeCameraError(new DOMException('none', 'NotFoundError'))
    expect(info.title).toBe('No camera found')
    expect(info.message).toContain('Choose photo')
  })

  it('a busy camera gets its own cause-and-fix message', () => {
    const info = describeCameraError(new DOMException('busy', 'NotReadableError'))
    expect(info.title).toBe('Camera is in use')
  })

  it('an unknown failure stays generic and internal-free', () => {
    const weird = Object.assign(new Error('totally unexpected'), { name: 'WeirdError' })
    const info = describeCameraError(weird)
    expect(info.title).toBe('Camera could not start')
    expect(info.message).not.toContain('WeirdError')
  })

  it('the unsupported-browser class explains itself without jargon', () => {
    const unsupported = Object.assign(new Error('no camera scanning'), {
      name: 'ScannerCameraUnsupportedError',
    })
    const info = describeCameraError(unsupported)
    expect(info.title).toBe('Camera not supported')
    expect(info.message).toContain('Choose photo')
  })
})
