import type { CameraAcquisitionGuard } from './camera-acquisition-guard'
import type { CapturedFrame } from './capture'

/**
 * Latest-capture-wins for the two ways a frame enters the scanner: the shutter (video frame ->
 * canvas -> JPEG) and the file picker (decode -> canvas -> JPEG). Both are asynchronous, and until
 * P151 both applied their result unconditionally when they finally settled — after the page had
 * already unmounted, the user had pressed Close, the tab had been hidden (camera released, step reset
 * to the intro screen), or a newer pick had started. In every one of those cases the late result:
 *
 *   - called `CaptureStore.set()`, which allocates an object URL for the raw camera frame AFTER the
 *     unmount cleanup had already cleared the store — a blob URL (a full-resolution JPEG of whatever
 *     was in front of the camera) alive until the tab closes, and
 *   - dispatched CAPTURE_SUCCEEDED / CAPTURE_FAILED into a state machine that had moved on (the
 *     hidden-tab case: the intro screen suddenly jumps to "review" with a photo taken before the
 *     tab was backgrounded; a failed stale pick raises a capture error over a screen that never
 *     asked for one), and
 *   - with two picks in flight, whichever decoded LAST won regardless of which the user chose last.
 *
 * `begin()` on the shared guard marks this capture as the newest; `invalidate()` (unmount, exit,
 * hide, camera restart) makes every in-flight capture stale. A stale capture's frame is simply
 * dropped (it is only a Blob until the store turns it into a URL, so dropping it releases it) and
 * its error is not reported.
 */
export interface GuardedCaptureHandlers {
  /** Called only if this capture is still the newest and nothing has invalidated the guard. */
  onFrame(frame: CapturedFrame): void
  /** Called only under the same condition. */
  onError(error: unknown): void
}

export function runGuardedCapture(
  guard: CameraAcquisitionGuard,
  produce: () => Promise<CapturedFrame>,
  handlers: GuardedCaptureHandlers,
): Promise<void> {
  const token = guard.begin()
  return produce().then(
    (frame) => {
      if (guard.isCurrent(token)) handlers.onFrame(frame)
    },
    (error: unknown) => {
      if (guard.isCurrent(token)) handlers.onError(error)
    },
  )
}
