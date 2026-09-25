import type { IdentityAuthority } from '../../auth/identity-authority'
import type { Failure } from '../../net/failure'
import { runUnderIdentity } from '../../state/lease-run'
import { Emitter, type Resettable } from '../../state/registry'
import { resolveVariant, type VariantResolution } from './p165-domain/price-check/identity'
import {
  PriceLookupError,
  RETRYABLE_FAILURES,
  isAbortError,
  type CardIdentity,
  type LookupFailureReason,
  type PriceCheckResult,
  type PriceSourceKind,
  type VariantIdentity,
} from './model'
import type { PriceLookupService } from './price-lookup'

/**
 * Price Check for ONE card: load the card, settle WHICH variant, then read the price of exactly
 * that variant. The variant rule is P165's `resolveVariant` (vendored, unchanged): one ACTIVE
 * variant is confirmed as `only_variant`; several are `choice_required` and NOTHING is looked up
 * until the person chooses (not the first, not the priced one, not the most expensive); a requested
 * variant id that is not a variant of THIS card is a `mismatch` and never falls back.
 *
 * STALE ANSWERS. Three independent guards, any one of which drops a late answer:
 *   - the lookup KEY (source:card:variant) must still be the current one (variant/source switch);
 *   - the AbortController of that lookup must not be aborted (cancel(), navigation away, reset());
 *   - the IDENTITY LEASE taken when it started must still be current (A -> B, A -> signed out).
 * Card loads are guarded by a sequence number plus the identity lease.
 *
 * READ-ONLY. The store's collaborators are a card reader and the PriceLookupService. "Add to
 * collection" produces a navigation INTENT for the host; it performs no request of any kind.
 */

export interface CardWithVariants {
  readonly card: CardIdentity
  readonly variants: readonly VariantIdentity[]
}

export type CardReader = (cardId: string) => Promise<CardWithVariants | null>

export interface LookupState {
  readonly status: 'idle' | 'loading' | 'ready' | 'error'
  /** `${source}:${cardId}:${variantId}` this lookup is for. */
  readonly key: string | null
  readonly result: PriceCheckResult | null
  readonly failure: LookupFailureReason | null
  readonly retryable: boolean
}

export interface PriceCheckFlowState {
  readonly source: PriceSourceKind
  readonly card: {
    readonly status: 'idle' | 'loading' | 'ready' | 'not_found' | 'error'
    readonly cardId: string | null
    readonly data: CardWithVariants | null
    readonly failure: Failure | null
  }
  readonly requestedVariantId: string | null
  readonly resolution: VariantResolution | null
  readonly lookup: LookupState
}

export interface AddToCollectionIntent {
  readonly kind: 'add_to_collection'
  readonly cardId: string
  readonly variantId: string
  /** The acquisition itself needs the person's explicit confirmation in the collection flow. */
  readonly requiresConfirmation: true
}

const IDLE_LOOKUP: LookupState = {
  status: 'idle',
  key: null,
  result: null,
  failure: null,
  retryable: false,
}

export const DEFAULT_PRICE_SOURCE: PriceSourceKind = 'search_prices'

function initial(source: PriceSourceKind): PriceCheckFlowState {
  return {
    source,
    card: { status: 'idle', cardId: null, data: null, failure: null },
    requestedVariantId: null,
    resolution: null,
    lookup: IDLE_LOOKUP,
  }
}

export function lookupKey(source: PriceSourceKind, cardId: string, variantId: string): string {
  return `${source}:${cardId}:${variantId}`
}

export class PriceCheckFlowStore implements Resettable {
  private state: PriceCheckFlowState = initial(DEFAULT_PRICE_SOURCE)
  private cardSeq = 0
  private controller: AbortController | null = null
  private readonly emitter = new Emitter()
  /** Late answers dropped by a guard (observable in tests and on the device harness). */
  droppedLate = 0

  constructor(
    private readonly readCard: CardReader,
    private readonly prices: PriceLookupService,
    private readonly authority: IdentityAuthority,
  ) {}

  subscribe = this.emitter.subscribe
  getSnapshot = (): PriceCheckFlowState => this.state

  private set(next: PriceCheckFlowState): void {
    this.state = next
    this.emitter.emit()
  }

  private abortInFlight(): void {
    this.controller?.abort()
    this.controller = null
  }

  /** Identity boundary (A -> B, sign-out): synchronous, before the next identity renders. */
  reset(): void {
    this.abortInFlight()
    this.cardSeq += 1
    this.set(initial(DEFAULT_PRICE_SOURCE))
  }

  /** Leaving the screen: stop the price request and make sure no late answer is published. */
  cancel(): void {
    this.abortInFlight()
    this.cardSeq += 1
    if (this.state.lookup.status === 'loading' || this.state.card.status === 'loading') {
      this.set({
        ...this.state,
        card:
          this.state.card.status === 'loading'
            ? { ...this.state.card, status: 'idle' }
            : this.state.card,
        lookup: IDLE_LOOKUP,
      })
    }
  }

  async openCard(cardId: string, variantId?: string): Promise<void> {
    this.abortInFlight()
    const seq = (this.cardSeq += 1)
    this.set({
      ...this.state,
      card: { status: 'loading', cardId, data: null, failure: null },
      requestedVariantId: variantId ?? null,
      resolution: null,
      lookup: IDLE_LOOKUP,
    })
    const outcome = await runUnderIdentity(this.authority, () => this.readCard(cardId))
    if (outcome.kind === 'stale' || seq !== this.cardSeq) {
      this.droppedLate += 1
      return
    }
    if (outcome.kind === 'failed') {
      this.set({
        ...this.state,
        card: { status: 'error', cardId, data: null, failure: outcome.failure },
      })
      return
    }
    if (outcome.value === null) {
      this.set({ ...this.state, card: { status: 'not_found', cardId, data: null, failure: null } })
      return
    }
    const resolution = resolveVariant(outcome.value.variants, variantId)
    this.set({
      ...this.state,
      card: { status: 'ready', cardId, data: outcome.value, failure: null },
      resolution,
    })
    if (resolution.status === 'confirmed') await this.lookup(outcome.value.card, resolution.variant)
  }

  /** The person picked a variant. Never inferred, never defaulted. */
  async chooseVariant(variantId: string): Promise<void> {
    const data = this.state.card.data
    if (data === null) return
    const resolution = resolveVariant(data.variants, variantId)
    this.abortInFlight()
    this.set({ ...this.state, requestedVariantId: variantId, resolution, lookup: IDLE_LOOKUP })
    if (resolution.status === 'confirmed') await this.lookup(data.card, resolution.variant)
  }

  async setSource(source: PriceSourceKind): Promise<void> {
    if (source === this.state.source) return
    this.abortInFlight()
    this.set({ ...this.state, source, lookup: IDLE_LOOKUP })
    const { card, resolution } = this.state
    if (card.data !== null && resolution?.status === 'confirmed') {
      await this.lookup(card.data.card, resolution.variant)
    }
  }

  async retry(): Promise<void> {
    const { card, resolution } = this.state
    if (card.data === null || resolution?.status !== 'confirmed') return
    await this.lookup(card.data.card, resolution.variant)
  }

  addToCollectionIntent(): AddToCollectionIntent | null {
    const { card, resolution } = this.state
    if (card.data === null || resolution?.status !== 'confirmed') return null
    return {
      kind: 'add_to_collection',
      cardId: card.data.card.cardId,
      variantId: resolution.variant.variantId,
      requiresConfirmation: true,
    }
  }

  private async lookup(card: CardIdentity, variant: VariantIdentity): Promise<void> {
    this.abortInFlight()
    const controller = new AbortController()
    this.controller = controller
    const source = this.state.source
    const key = lookupKey(source, card.cardId, variant.variantId)
    const lease = this.authority.begin(this.authority.userId)
    this.set({
      ...this.state,
      lookup: { status: 'loading', key, result: null, failure: null, retryable: false },
    })
    try {
      const result = await this.prices.lookup(source, card, variant, controller.signal)
      if (this.isStale(controller, lease, key)) return
      this.set({
        ...this.state,
        lookup: { status: 'ready', key, result, failure: null, retryable: false },
      })
    } catch (error) {
      if (this.isStale(controller, lease, key) || isAbortError(error)) return
      const reason = error instanceof PriceLookupError ? error.reason : 'unknown'
      this.set({
        ...this.state,
        lookup: {
          status: 'error',
          key,
          result: null,
          failure: reason,
          retryable: RETRYABLE_FAILURES.has(reason),
        },
      })
    } finally {
      if (this.controller === controller) this.controller = null
    }
  }

  private isStale(
    controller: AbortController,
    lease: { isCurrent(): boolean },
    key: string,
  ): boolean {
    const stale = controller.signal.aborted || !lease.isCurrent() || this.state.lookup.key !== key
    if (stale) this.droppedLate += 1
    return stale
  }
}
