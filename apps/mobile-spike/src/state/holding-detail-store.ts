import type { IdentityAuthority } from '../auth/identity-authority'
import type { CollectionPort, HoldingDetail } from '../collection/types'
import type { Failure } from '../net/failure'
import { runUnderIdentity } from './lease-run'
import { Emitter, type Resettable } from './registry'

export interface HoldingDetailState {
  status: 'idle' | 'loading' | 'ready' | 'not_found' | 'error'
  holdingId: string | null
  detail: HoldingDetail | null
  failure: Failure | null
}

const INITIAL: HoldingDetailState = { status: 'idle', holdingId: null, detail: null, failure: null }

/**
 * One holding's detail. User-scoped (registered with the identity boundary) and keyed by `holdingId`:
 * an answer for a holding that is no longer the requested one is dropped, so navigating quickly from
 * one holding to another never shows the first one's numbers under the second one's title.
 */
export class HoldingDetailStore implements Resettable {
  private state: HoldingDetailState = INITIAL
  private readonly emitter = new Emitter()

  constructor(
    private readonly port: CollectionPort,
    private readonly authority: IdentityAuthority,
  ) {}

  subscribe = this.emitter.subscribe

  getSnapshot = (): HoldingDetailState => this.state

  private set(next: HoldingDetailState): void {
    this.state = next
    this.emitter.emit()
  }

  reset(): void {
    this.set(INITIAL)
  }

  async load(holdingId: string): Promise<void> {
    this.set({ status: 'loading', holdingId, detail: null, failure: null })
    const outcome = await runUnderIdentity(this.authority, () => this.port.getDetail(holdingId))
    if (outcome.kind === 'stale' || this.state.holdingId !== holdingId) return
    if (outcome.kind === 'failed') {
      this.set({ status: 'error', holdingId, detail: null, failure: outcome.failure })
      return
    }
    if (outcome.value === null) {
      this.set({ status: 'not_found', holdingId, detail: null, failure: null })
      return
    }
    this.set({ status: 'ready', holdingId, detail: outcome.value, failure: null })
  }
}
