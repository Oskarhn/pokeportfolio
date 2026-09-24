import type { IdentityAuthority } from '../auth/identity-authority'
import { Emitter, type Resettable } from '../state/registry'

/**
 * NATIVE PHOTO FEASIBILITY (bounded): acquire an image on the device, show a preview, own the file,
 * release it, and hand a typed reference to a FUTURE scanner. It proves the API and ownership
 * contract only. It does no recognition, and NOTHING is uploaded: this module and its adapter import
 * no network client (asserted by tests/unit/photo-privacy.test.ts), and no server-side OCR is
 * permitted without a separate privacy review.
 *
 * OWNERSHIP. The picker copies the chosen image into the app's cache; that file is owned by the
 * store until `release()` deletes it. `release()` runs when the person leaves the screen and when the
 * identity changes (a private image must not outlive the account that took it). An image that arrives
 * after the identity changed is deleted immediately instead of being kept.
 *
 * CONSENT. Camera and library access are opt-in, per action. A denied permission is a state
 * (`denied`) with honest copy, never a crash or a silent no-op.
 */

export interface LocalImageRef {
  readonly kind: 'local_image'
  readonly uri: string
  readonly width: number
  readonly height: number
  readonly source: 'camera' | 'library'
  readonly acquiredAt: string
}

/** What a future scanner port consumes: a reference to a local image, never bytes, never a URL. */
export type ScannerImageInput = Readonly<Pick<LocalImageRef, 'uri' | 'width' | 'height'>>

export function toScannerInput(image: LocalImageRef): ScannerImageInput {
  return { uri: image.uri, width: image.width, height: image.height }
}

export type PhotoOutcome =
  | { status: 'picked'; image: LocalImageRef }
  | { status: 'cancelled' }
  | { status: 'permission_denied'; canAskAgain: boolean }
  | { status: 'unavailable'; reason: 'no_camera' | 'error' }

export interface PhotoPort {
  acquire(source: 'camera' | 'library'): Promise<PhotoOutcome>
  /** Deletes an image file this app owns. Rejects if it could not. */
  deleteFile(uri: string): Promise<void>
}

export interface PhotoState {
  status: 'idle' | 'acquiring' | 'ready' | 'cancelled' | 'denied' | 'unavailable'
  image: LocalImageRef | null
  canAskAgain: boolean
  /** URIs whose deletion failed (surfaced so a leak is visible in a test, not silent). */
  leaked: readonly string[]
}

const INITIAL: PhotoState = { status: 'idle', image: null, canAskAgain: true, leaked: [] }

export class PhotoStore implements Resettable {
  private state: PhotoState = INITIAL
  private readonly emitter = new Emitter()
  private token = 0

  constructor(
    private readonly port: PhotoPort,
    private readonly authority: IdentityAuthority,
  ) {}

  subscribe = this.emitter.subscribe

  getSnapshot = (): PhotoState => this.state

  private set(next: PhotoState): void {
    this.state = next
    this.emitter.emit()
  }

  async acquire(source: 'camera' | 'library'): Promise<void> {
    await this.release()
    const token = (this.token += 1)
    const lease = this.authority.begin(this.authority.userId)
    this.set({ ...this.state, status: 'acquiring', image: null })
    let outcome: PhotoOutcome
    try {
      outcome = await this.port.acquire(source)
    } catch {
      outcome = { status: 'unavailable', reason: 'error' }
    }
    if (outcome.status === 'picked' && (!lease.isCurrent() || token !== this.token)) {
      // The identity changed (or the person left) while the picker was open: never keep this image.
      await this.deleteQuietly(outcome.image.uri)
      return
    }
    if (!lease.isCurrent() || token !== this.token) return
    switch (outcome.status) {
      case 'picked':
        this.set({ ...this.state, status: 'ready', image: outcome.image })
        return
      case 'cancelled':
        this.set({ ...this.state, status: 'cancelled', image: null })
        return
      case 'permission_denied':
        this.set({ ...this.state, status: 'denied', image: null, canAskAgain: outcome.canAskAgain })
        return
      case 'unavailable':
        this.set({ ...this.state, status: 'unavailable', image: null })
        return
    }
  }

  /** Releases the owned image file. Called on screen exit and by the identity boundary. */
  async release(): Promise<void> {
    const image = this.state.image
    this.token += 1
    if (image === null) return
    this.set({ ...this.state, status: 'idle', image: null })
    await this.deleteQuietly(image.uri)
  }

  reset(): void {
    const image = this.state.image
    this.token += 1
    this.state = INITIAL
    this.emitter.emit()
    if (image !== null) void this.deleteQuietly(image.uri)
  }

  private async deleteQuietly(uri: string): Promise<void> {
    try {
      await this.port.deleteFile(uri)
    } catch {
      this.state = { ...this.state, leaked: [...this.state.leaked, uri] }
      this.emitter.emit()
    }
  }
}
