import { hasMediaDevicesSupport } from './errors'

/** Thrown when this browser exposes no usable mediaDevices surface at all (prompt §7). */
export class ScannerCameraUnsupportedError extends Error {
  constructor() {
    super('This browser does not support live camera scanning.')
    this.name = 'ScannerCameraUnsupportedError'
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
 * tracks. `openGeneration` makes the primitive itself enforce the invariant regardless of caller
 * discipline: each call is stamped with the generation current when it started, and a call whose
 * generation has since been superseded (a later `openEnvironmentCamera` call started before this
 * one's `acquire()` resolved) stops its own just-acquired stream immediately instead of ever
 * touching `video`/`activeScannerSession` — so exactly one stream ever becomes active no matter
 * which underlying `acquire()` promise happens to settle first.
 */
let openGeneration = 0

export async function openEnvironmentCamera(
  video: HTMLVideoElement,
  acquire: (constraints: MediaStreamConstraints) => Promise<MediaStream> = defaultAcquire,
  onEnded?: () => void,
): Promise<ManagedCameraSession> {
  stopActiveScannerCamera()
  const myGeneration = ++openGeneration
  const stream = await acquire({
    video: {
      facingMode: { ideal: 'environment' },
      width: { ideal: CAMERA_IDEAL_RESOLUTION_PX },
      height: { ideal: CAMERA_IDEAL_RESOLUTION_PX },
    },
    audio: false,
  })
  if (myGeneration !== openGeneration) {
    // A newer openEnvironmentCamera call started while this one's acquire() was pending — this
    // stream lost the race before it ever became visible; stop it immediately, touch nothing.
    for (const track of stream.getTracks()) track.stop()
    return { stream, stop() {} }
  }
  video.srcObject = stream
  try {
    // Muted+playsInline makes this succeed on iOS; a rejected play() here must not fail the
    // whole start — the stream is live either way and the user can tap to begin playback.
    await video.play()
  } catch {
    /* play() rejection is non-fatal */
  }
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
  for (const track of stream.getTracks()) {
    track.addEventListener('ended', onTrackEnded)
  }
  activeScannerSession = session
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
