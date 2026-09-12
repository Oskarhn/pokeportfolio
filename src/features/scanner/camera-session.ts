import { hasMediaDevicesSupport } from './errors'

/** Thrown when this browser exposes no usable mediaDevices surface at all (prompt §7). */
export class ScannerCameraUnsupportedError extends Error {
  constructor() {
    super('This browser does not support live camera scanning.')
    this.name = 'ScannerCameraUnsupportedError'
  }
}

/** Thrown when a call to {@link openEnvironmentCamera} loses the race to a newer call that is
 *  still eligible to win (P94 N-10) — never resolved as a fake "success" with a dead stream. Its
 *  own just-acquired stream has already been stopped by the time this rejects. Callers that
 *  already guard on their own external generation/identity ref (as `ScannerPage.tsx` does) can
 *  safely ignore this specific error class: a genuinely superseded call always corresponds to an
 *  outdated external generation too, so the caller's own stale-result guard already discards it
 *  before this error's content would ever matter. */
export class ScannerCameraSupersededError extends Error {
  constructor() {
    super('A newer camera-open request superseded this one before it could become active.')
    this.name = 'ScannerCameraSupersededError'
  }
}

/**
 * Camera lifecycle for the scanner (prompt §7/§8, D-006). The scanner route owns exactly ONE
 * MediaStream at a time: opening a new session stops any previous one first, and every exit
 * path — leaving the camera step, unmount, tab hidden — funnels through `stop()`, which stops
 * every track. No orphan tracks, ever.
 *
 * Standards only: navigator.mediaDevices.getUserMedia with a rear-camera *preference* (ideal,
 * not exact — a desktop webcam or an unavailable rear lens still works). Torch/zoom/ImageCapture
 * are deliberately not touched.
 */

/** Attributes the preview <video> must carry: autoplay + muted satisfies iOS autoplay policy,
 *  playsInline prevents iOS Safari hijacking the page into fullscreen playback. Exported so the
 *  semantics stay pinned by test and the component cannot drift from them. */
export const CAMERA_VIDEO_PROPS = {
  autoPlay: true,
  muted: true,
  playsInline: true,
} as const

/**
 * Opens the environment-facing camera and attaches it to `video`. If another scanner session is
 * somehow already running it is stopped first — two live streams are never allowed to coexist.
 *
 * `acquire` is injectable so tests can drive real success/failure paths against fake tracks.
 *
 * L1 (P70): when any track ends unexpectedly (hardware disconnect, browser permission revoke),
 * the session is stopped and `onEnded` is called so the UI can transition gracefully.
 */
/**
 * Resolution hints (P79): no width/height constraint was ever requested here, so the browser
 * was free to hand back whatever "default" video track resolution it likes rather than the
 * camera's real capability — a real-device diagnostic (`CAPTURE_CROP_DIMENSIONS=252x352`) traced
 * back to exactly this: the guide-geometry math checks out exactly against a small source
 * resolution (see docs/PROJECT_JOURNAL.md's 2026-08-27 P79 entry for the reconstructed numbers).
 * `ideal` (not `exact` or `min`) keeps every existing fallback intact — a desktop webcam or a
 * rear lens capped below this still opens successfully at whatever it actually supports; this
 * only raises the ceiling a capable phone camera was never being asked to reach. Width AND height
 * are both hinted (not just the long edge) so the constraint helps regardless of device/viewport
 * orientation.
 */
const CAMERA_IDEAL_RESOLUTION_PX = 1920

/**
 * F-06 (P89): the module's own "stops any previous session first" guarantee used to hold only
 * against SEQUENTIAL callers — two overlapping invocations (neither awaited before the next
 * starts) both saw `activeScannerSession === null` at the top and both proceeded, so whichever
 * `acquire()` resolved SECOND silently overwrote `activeScannerSession`, leaking the other's
 * tracks. A per-call token (`openSeq`) plus one piece of AUTHORITATIVE shared state
 * (`liveGeneration` — "which token is still eligible to become/stay the active session") makes
 * the primitive itself enforce the invariant regardless of caller discipline.
 *
 * N-10 (P94): the ORIGINAL fix here bumped a single shared counter on every call start and
 * compared against it on every call's OWN resolution — but never rolled it back when a call's
 * `acquire()` REJECTED. Concretely: call A starts (token 1, counter now 1); call B starts before
 * A resolves (token 2, counter now 2); B's `acquire()` rejects — the counter stays at 2, nothing
 * restores it to 1; A's `acquire()` later resolves and is wrongly compared against the counter's
 * now-permanently-stale value of 2, sees `1 !== 2`, concludes it lost a race that never actually
 * happened (B never became live — it FAILED), stops its own perfectly good stream, and used to
 * resolve as if successful anyway. Zero live streams, no error surfaced.
 *
 * The fix is NOT a blind decrement on failure (`liveGeneration -= 1`) — with more than two
 * overlapping calls that is just as unsafe: which value to fall back to depends on exactly which
 * other calls are still in flight, not a fixed offset. Instead, each call captures the
 * `liveGeneration` value it is about to DISPLACE (`previousLiveGeneration`) when it claims the
 * slot; on failure, it restores exactly that captured value — but ONLY if nothing even newer has
 * claimed the slot since (checked via `liveGeneration === myToken` immediately before restoring).
 * That guard is what makes chained failures/successes resolve correctly no matter how many calls
 * overlap or what order their `acquire()` promises settle in — proven by the ordering matrix in
 * `tests/ui/scanner-camera.test.ts`.
 *
 * A call that ends up NOT holding the slot once its own `acquire()` settles — because a still-live
 * newer call already displaced it — stops its own stream immediately and REJECTS with
 * {@link ScannerCameraSupersededError} rather than ever resolving a dead session as if it were a
 * success (the old, buggy `{ stream, stop() {} }` shape).
 */
let openSeq = 0
let liveGeneration = 0

export async function openEnvironmentCamera(
  video: HTMLVideoElement,
  acquire: (constraints: MediaStreamConstraints) => Promise<MediaStream> = defaultAcquire,
  onEnded?: () => void,
): Promise<ManagedCameraSession> {
  stopActiveScannerCamera()
  const myToken = ++openSeq
  const previousLiveGeneration = liveGeneration
  liveGeneration = myToken
  let stream: MediaStream
  try {
    stream = await acquire({
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: CAMERA_IDEAL_RESOLUTION_PX },
        height: { ideal: CAMERA_IDEAL_RESOLUTION_PX },
      },
      audio: false,
    })
  } catch (error) {
    // Retract this call's claim on the slot — but ONLY if nothing newer has claimed it since
    // (a newer call's own eventual success/failure must not be affected by an older call's
    // unrelated rejection). Restores the EXACT value this call displaced, not a blind decrement.
    if (liveGeneration === myToken) liveGeneration = previousLiveGeneration
    throw error
  }
  if (myToken !== liveGeneration) {
    // A still-live newer call already holds the slot — this stream lost the race before it ever
    // became visible. Stop it immediately and reject clearly; never resolve a dead session as a
    // fake success.
    for (const track of stream.getTracks()) track.stop()
    throw new ScannerCameraSupersededError()
  }
  video.srcObject = stream
  let stopped = false
  const session: ManagedCameraSession = {
    stream,
    stop() {
      if (stopped) return
      stopped = true
      for (const track of stream.getTracks()) {
        track.removeEventListener('ended', onTrackEnded)
        track.stop()
      }
      if (video.srcObject === stream) video.srcObject = null
      if (activeScannerSession === session) activeScannerSession = null
    },
  }
  function onTrackEnded(): void {
    if (stopped) return
    session.stop()
    onEnded?.()
  }
  // Ownership of the stream (this session object, the ended listeners, `activeScannerSession`)
  // is established BEFORE playback is even requested. A hardware disconnect must be observable
  // regardless of what `video.play()` is doing — see the playback note below for why that
  // Promise cannot be allowed to gate any of this.
  for (const track of stream.getTracks()) {
    track.addEventListener('ended', onTrackEnded)
  }
  activeScannerSession = session
  // Muted+playsInline makes this succeed on iOS. Deliberately NOT awaited: a rejected play() is
  // non-fatal (the stream is live either way and the user can tap to begin playback), and on some
  // engines (observed in GitHub Actions' Linux-hosted WebKit against a canvas.captureStream()
  // mock) play() can render frames and advance currentTime while its own Promise never settles at
  // all — awaiting it here used to block session ownership (and therefore the ended-listener
  // attachment above) indefinitely, silently freezing the shutter forever and swallowing a
  // simultaneous hardware disconnect. A synchronous throw is equally non-fatal (not guaranteed by
  // the spec, but some implementations/mocks do it).
  try {
    video.play().catch(() => {
      /* play() rejection is non-fatal — the stream is live either way */
    })
  } catch {
    /* synchronous play() throw is equally non-fatal */
  }
  return session
}

function defaultAcquire(constraints: MediaStreamConstraints): Promise<MediaStream> {
  if (!hasMediaDevicesSupport(navigator)) {
    throw new ScannerCameraUnsupportedError()
  }
  return navigator.mediaDevices.getUserMedia(constraints)
}

export interface ManagedCameraSession {
  readonly stream: MediaStream
  /** Stops every track and detaches the stream. Idempotent. */
  stop(): void
}

let activeScannerSession: ManagedCameraSession | null = null

/** Safety valve: stops whatever scanner camera session exists, wherever it is referenced from. */
export function stopActiveScannerCamera(): void {
  activeScannerSession?.stop()
  activeScannerSession = null
}

/** Testable statement of the visibility policy (prompt §8): when the page hides, release the
 *  camera hardware immediately rather than keeping a backgrounded stream alive. Permission
 *  persists, so returning re-opens without a new prompt; orphan tracks become impossible even
 *  if the user never comes back. */
export function visibilityChangeAction(visibilityState: DocumentVisibilityState): 'stop' | 'keep' {
  return visibilityState === 'hidden' ? 'stop' : 'keep'
}
