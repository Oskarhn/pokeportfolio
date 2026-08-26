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
 */
export async function openEnvironmentCamera(
  video: HTMLVideoElement,
  acquire: (constraints: MediaStreamConstraints) => Promise<MediaStream> = defaultAcquire,
): Promise<ManagedCameraSession> {
  stopActiveScannerCamera()
  const stream = await acquire({
    video: { facingMode: { ideal: 'environment' } },
    audio: false,
  })
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
      for (const track of stream.getTracks()) track.stop()
      if (video.srcObject === stream) video.srcObject = null
      if (activeScannerSession === session) activeScannerSession = null
    },
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
