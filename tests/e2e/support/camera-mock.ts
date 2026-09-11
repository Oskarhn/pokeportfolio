import type { Page } from '@playwright/test'

/**
 * P119 Major Deliverable A: real-browser `getUserMedia` mock for Playwright.
 *
 * Production (`src/features/scanner/camera-session.ts`) calls
 * `navigator.mediaDevices.getUserMedia` directly with no test-only seam — by design, per this
 * project's "no production test backdoor" rule. This installs the mock entirely from the test
 * side via `page.addInitScript()`, patching `navigator.mediaDevices.getUserMedia` before any
 * page script runs.
 *
 * Rather than reimplement MediaStream/MediaStreamTrack from scratch (a fragile, incomplete fake),
 * a successful acquisition uses `HTMLCanvasElement.captureStream()` to produce a REAL
 * MediaStream/MediaStreamTrack pair — real enough that `video.srcObject = stream` (which validates
 * its argument is an actual MediaStream), `track.readyState`, `track.stop()` and the real `ended`
 * event all behave exactly as they do with a hardware camera, on both Chromium and WebKit. A test
 * simulates "camera disappeared" / "hardware disconnect" by calling `.stop()` on the SAME track
 * object the app is holding — indistinguishable, from the app's perspective, from a real
 * disconnect: both fire a real `ended` event on a real track.
 *
 * Diagnostics are exposed on `window.__scannerCameraMock` so a test can assert exactly what the
 * production camera-session code actually did, not just what the test itself expects it to do.
 */

export type CameraMockBehavior =
  | 'success'
  | 'NotAllowedError'
  | 'NotFoundError'
  | 'NotReadableError'
  | 'AbortError'
  | 'OverconstrainedError'
  | 'SecurityError'
  | 'TrackStartError'

export interface CameraMockOptions {
  /** Outcome for every getUserMedia call until changed via `setCameraMockBehavior`. */
  behavior?: CameraMockBehavior
  /** Synthetic video frame size (prompt §7's "video dimensions"). */
  videoWidth?: number
  videoHeight?: number
  /** Frames/sec for the synthetic canvas draw loop. Kept low — nothing in this pipeline reads
   *  motion, only the fact that a live video track exists and has pixels. */
  fps?: number
}

const DEFAULTS: Required<CameraMockOptions> = {
  behavior: 'success',
  videoWidth: 1280,
  videoHeight: 720,
  fps: 5,
}

/** Installed once per page via `addInitScript` — must be a plain function with no closure over
 *  anything outside its own arguments (Playwright serializes it into the page). */
function installInPage(options: Required<CameraMockOptions>): void {
  interface MockState {
    behavior: CameraMockBehavior
    createdStreamCount: number
    stoppedTrackCount: number
    activeStreamCount: number
    activeTrackCount: number
    lastConstraints: MediaStreamConstraints | null
    getUserMediaCallCount: number
    activeTracks: Set<MediaStreamTrack>
    canvases: Set<HTMLCanvasElement>
    rafHandles: Map<HTMLCanvasElement, number>
  }

  const state: MockState = {
    behavior: options.behavior,
    createdStreamCount: 0,
    stoppedTrackCount: 0,
    activeStreamCount: 0,
    activeTrackCount: 0,
    lastConstraints: null,
    getUserMediaCallCount: 0,
    activeTracks: new Set(),
    canvases: new Set(),
    rafHandles: new Map(),
  }

  function nameToError(name: CameraMockBehavior): DOMException {
    const messages: Record<Exclude<CameraMockBehavior, 'success'>, string> = {
      NotAllowedError: 'Permission denied (mock).',
      NotFoundError: 'No camera device found (mock).',
      NotReadableError: 'Could not start video source (mock).',
      AbortError: 'Starting the camera was aborted (mock).',
      OverconstrainedError: 'Constraints could not be satisfied (mock).',
      SecurityError: 'Camera access blocked by security policy (mock).',
      TrackStartError: 'Track failed to start (mock).',
    }
    return new DOMException(messages[name as Exclude<CameraMockBehavior, 'success'>], name)
  }

  function stopDrawLoop(canvas: HTMLCanvasElement): void {
    const handle = state.rafHandles.get(canvas)
    if (handle !== undefined) {
      cancelAnimationFrame(handle)
      state.rafHandles.delete(canvas)
    }
    state.canvases.delete(canvas)
  }

  function startDrawLoop(canvas: HTMLCanvasElement): void {
    const ctx = canvas.getContext('2d')
    if (ctx === null) return
    state.canvases.add(canvas)
    let hue = 0
    const intervalMs = 1000 / options.fps
    let lastDraw = 0
    function tick(now: number): void {
      if (!state.canvases.has(canvas)) return
      if (now - lastDraw >= intervalMs) {
        lastDraw = now
        hue = (hue + 5) % 360
        ctx!.fillStyle = `hsl(${String(hue)}, 60%, 45%)`
        ctx!.fillRect(0, 0, canvas.width, canvas.height)
        ctx!.fillStyle = 'white'
        ctx!.fillRect(
          canvas.width * 0.1,
          canvas.height * 0.1,
          canvas.width * 0.8,
          canvas.height * 0.8,
        )
      }
      const handle = requestAnimationFrame(tick)
      state.rafHandles.set(canvas, handle)
    }
    const handle = requestAnimationFrame(tick)
    state.rafHandles.set(canvas, handle)
  }

  function createFakeStream(): MediaStream {
    const canvas = document.createElement('canvas')
    canvas.width = options.videoWidth
    canvas.height = options.videoHeight
    startDrawLoop(canvas)
    const stream = (
      canvas as unknown as { captureStream: (fps?: number) => MediaStream }
    ).captureStream(options.fps)
    state.createdStreamCount += 1
    state.activeStreamCount += 1
    let streamRetired = false
    function retireStream(): void {
      // captureStream() streams in this mock are always single-track (one canvas -> one video
      // track), so the one track ending IS the whole stream retiring — decremented exactly once
      // per stream via this guard, not once per track, in case a future caller ever widens this.
      if (streamRetired) return
      streamRetired = true
      state.activeStreamCount = Math.max(0, state.activeStreamCount - 1)
      stopDrawLoop(canvas)
    }
    const tracksInThisStream = stream.getTracks()
    for (const track of tracksInThisStream) {
      state.activeTrackCount += 1
      state.activeTracks.add(track)
      let trackRetired = false
      function retireTrack(): void {
        // A per-track guard alongside the per-stream one: this fires from BOTH the wrapped
        // stop() below AND the 'ended' listener, and a real disconnect (endActiveTracks,
        // dispatching a synthetic 'ended') is very likely to be followed by the app's own
        // session.stop() calling the SAME track's real .stop() a moment later — both must count
        // as exactly one retirement, not two.
        if (trackRetired) return
        trackRetired = true
        state.stoppedTrackCount += 1
        state.activeTrackCount = Math.max(0, state.activeTrackCount - 1)
        state.activeTracks.delete(track)
        retireStream()
      }
      track.addEventListener('ended', retireTrack)
      // Per the MediaStreamTrack spec (confirmed empirically against this exact browser this
      // session), calling `.stop()` directly NEVER fires the track's own 'ended' event — 'ended'
      // is reserved for the track stopping for a reason OUTSIDE the caller's control (a real
      // disconnect). `camera-session.ts`'s NORMAL exit paths (route leave, tab hidden, closing
      // the scanner) all call the real `.stop()` directly, not a synthetic disconnect — without
      // this wrapper ALSO retiring the mock's own accounting, every ordinary stop would be
      // invisible to diagnostics and activeStreamCount would never return to 0 after a normal,
      // successful teardown (caught by this session's own visibility-soak test failing on
      // exactly that gap before this fix).
      const originalStop = track.stop.bind(track)
      track.stop = () => {
        originalStop()
        retireTrack()
      }
    }
    return stream
  }

  async function mockGetUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream> {
    // A real getUserMedia call is genuinely asynchronous (permission prompt round-trip) — an
    // immediately-synchronous mock would let a caller's race-condition bug hide behind timing
    // that never occurs on a real device. One microtask tick is enough to force any ordering
    // assumption in the caller to go through a real await.
    await Promise.resolve()
    state.getUserMediaCallCount += 1
    state.lastConstraints = constraints
    if (state.behavior !== 'success') {
      throw nameToError(state.behavior)
    }
    return createFakeStream()
  }

  async function mockEnumerateDevices(): Promise<MediaDeviceInfo[]> {
    await Promise.resolve()
    if (state.behavior === 'NotFoundError') return []
    return [
      {
        deviceId: 'mock-environment-camera',
        kind: 'videoinput' as const,
        label: 'Mock Environment Camera',
        groupId: 'mock-group',
        toJSON() {
          return this
        },
      },
    ]
  }

  // Production only ever calls `navigator.mediaDevices.getUserMedia` (camera-session.ts) and
  // feature-detects it (`errors.ts`'s hasMediaDevicesSupport) — a plain object with just these two
  // methods is a complete, honest substitute; spreading the real MediaDevices instance would only
  // copy its own enumerable properties (none — its methods live on the prototype) while losing the
  // prototype itself, so it is deliberately not attempted here.
  Object.defineProperty(navigator, 'mediaDevices', {
    value: {
      getUserMedia: mockGetUserMedia,
      enumerateDevices: mockEnumerateDevices,
    },
    configurable: true,
  })

  ;(window as unknown as { __scannerCameraMock: unknown }).__scannerCameraMock = {
    setBehavior(behavior: CameraMockBehavior): void {
      state.behavior = behavior
    },
    getBehavior(): CameraMockBehavior {
      return state.behavior
    },
    diagnostics() {
      return {
        behavior: state.behavior,
        createdStreamCount: state.createdStreamCount,
        stoppedTrackCount: state.stoppedTrackCount,
        activeStreamCount: state.activeStreamCount,
        activeTrackCount: state.activeTrackCount,
        getUserMediaCallCount: state.getUserMediaCallCount,
        lastConstraints: state.lastConstraints,
      }
    },
    /** Simulates a hardware disconnect / camera taken by another app. Per the MediaStream spec, a
     *  track's own `.stop()` NEVER fires its `ended` event — `ended` only fires when the track
     *  stops for a reason OUTSIDE the caller's own control (verified empirically against real
     *  Chromium this session: calling `.stop()` alone left the app's `onTrackEnded` listener never
     *  invoked). Dispatching a synthetic `ended` Event is what a real disconnect's `ended` event
     *  delivery looks like from a listener's perspective — indistinguishable from the app's own
     *  `camera-session.ts` `addEventListener('ended', onTrackEnded)` handler, which is exactly the
     *  code path this needs to exercise. The app's own `onTrackEnded` handler then calls the real
     *  `session.stop()` (which DOES call the real `track.stop()`), so the underlying canvas stream
     *  still gets torn down for real — this only supplies the missing event, nothing else. */
    endActiveTracks(): number {
      const tracks = [...state.activeTracks]
      for (const track of tracks) track.dispatchEvent(new Event('ended'))
      return tracks.length
    },
  }
}

export async function installCameraMock(
  page: Page,
  options: CameraMockOptions = {},
): Promise<void> {
  const merged: Required<CameraMockOptions> = { ...DEFAULTS, ...options }
  await page.addInitScript(installInPage, merged)
}

export interface CameraMockDiagnostics {
  behavior: CameraMockBehavior
  createdStreamCount: number
  stoppedTrackCount: number
  activeStreamCount: number
  activeTrackCount: number
  getUserMediaCallCount: number
  lastConstraints: MediaStreamConstraints | null
}

export async function getCameraMockDiagnostics(page: Page): Promise<CameraMockDiagnostics> {
  return page.evaluate(() => {
    return (
      window as unknown as {
        __scannerCameraMock: { diagnostics(): CameraMockDiagnostics }
      }
    ).__scannerCameraMock.diagnostics()
  })
}

export async function setCameraMockBehavior(
  page: Page,
  behavior: CameraMockBehavior,
): Promise<void> {
  await page.evaluate((b) => {
    ;(
      window as unknown as {
        __scannerCameraMock: { setBehavior(behavior: CameraMockBehavior): void }
      }
    ).__scannerCameraMock.setBehavior(b)
  }, behavior)
}

/** Ends every currently-live mock camera track (simulated hardware disconnect). Returns how many
 *  tracks were ended. */
export async function endActiveMockCameraTracks(page: Page): Promise<number> {
  return page.evaluate(() => {
    return (
      window as unknown as { __scannerCameraMock: { endActiveTracks(): number } }
    ).__scannerCameraMock.endActiveTracks()
  })
}
