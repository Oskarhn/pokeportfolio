import type { IdentityAuthority } from '../auth/identity-authority'
import type { Failure } from '../net/failure'
import { resolveVariant } from '../price-check/resolve-variant'
import type {
  CardSearchHit,
  CardWithVariants,
  PriceCheckPort,
  PriceLookup,
  VariantResolution,
} from '../price-check/types'
import { runUnderIdentity } from './lease-run'
import { Emitter, type Resettable } from './registry'

/**
 * Price Check: search a card, settle WHICH variant, then read the price of exactly that variant.
 *
 * READ-ONLY. The only collaborator is a {@link PriceCheckPort}, none of whose methods can write, and
 * this file imports nothing from the ledger data modules (asserted by tests/unit/price-check-read-only
 * .test.ts, together with a request log of every flow). Price Check never creates a holding, purchase,
 * sale or manual-card definition.
 *
 * USER-SCOPED. The query text and the chosen variant are unsaved work: they survive a same-user token
 * refresh (which never reaches this store) and are cleared by the identity boundary on A -> B or
 * sign-out. Responses for a superseded search, card or variant are dropped by key, on top of the
 * identity lease.
 */

export interface PriceCheckState {
  /** Draft: what the person has typed. */
  query: string
  search: {
    status: 'idle' | 'loading' | 'ready' | 'empty' | 'error'
    hits: readonly CardSearchHit[]
    failure: Failure | null
  }
  card: {
    status: 'idle' | 'loading' | 'ready' | 'not_found' | 'error'
    data: CardWithVariants | null
    failure: Failure | null
  }
  /** Draft: the variant the person chose (or arrived with). */
  requestedVariantId: string | null
  resolution: VariantResolution | null
  lookup: {
    status: 'idle' | 'loading' | 'ready' | 'error'
    /** `${cardId}:${variantId}` this lookup is for. */
    key: string | null
    result: PriceLookup | null
    failure: Failure | null
  }
}

const INITIAL: PriceCheckState = {
  query: '',
  search: { status: 'idle', hits: [], failure: null },
  card: { status: 'idle', data: null, failure: null },
  requestedVariantId: null,
  resolution: null,
  lookup: { status: 'idle', key: null, result: null, failure: null },
}

export const MIN_QUERY_LENGTH = 2

export class PriceCheckStore implements Resettable {
  private state: PriceCheckState = INITIAL
  private searchSeq = 0
  private cardSeq = 0
  private readonly emitter = new Emitter()

  constructor(
    private port: PriceCheckPort,
    private readonly authority: IdentityAuthority,
  ) {}

  subscribe = this.emitter.subscribe

  getSnapshot = (): PriceCheckState => this.state

  /** Switch the price source (released snapshots <-> synthetic P153 fixture). Clears results. */
  useSource(port: PriceCheckPort): void {
    this.port = port
    this.searchSeq += 1
    this.cardSeq += 1
    this.set({ ...INITIAL, query: this.state.query })
  }

  get sourceKind(): PriceCheckPort['sourceKind'] {
    return this.port.sourceKind
  }

  private set(next: PriceCheckState): void {
    this.state = next
    this.emitter.emit()
  }

  reset(): void {
    this.searchSeq += 1
    this.cardSeq += 1
    this.set(INITIAL)
  }

  setQuery(query: string): void {
    this.set({ ...this.state, query })
  }

  async search(): Promise<void> {
    const query = this.state.query.trim()
    if (query.length < MIN_QUERY_LENGTH) {
      this.set({ ...this.state, search: { status: 'idle', hits: [], failure: null } })
      return
    }
    const seq = (this.searchSeq += 1)
    this.set({ ...this.state, search: { status: 'loading', hits: [], failure: null } })
    const outcome = await runUnderIdentity(this.authority, () => this.port.searchCards(query))
    if (outcome.kind === 'stale' || seq !== this.searchSeq) return
    if (outcome.kind === 'failed') {
      this.set({ ...this.state, search: { status: 'error', hits: [], failure: outcome.failure } })
      return
    }
    this.set({
      ...this.state,
      search: {
        status: outcome.value.length === 0 ? 'empty' : 'ready',
        hits: outcome.value,
        failure: null,
      },
    })
  }

  /** Opens a card. `variantId` (e.g. the variant of a holding) is honoured only if it belongs to it. */
  async openCard(cardId: string, variantId?: string): Promise<void> {
    const seq = (this.cardSeq += 1)
    this.set({
      ...this.state,
      card: { status: 'loading', data: null, failure: null },
      requestedVariantId: variantId ?? null,
      resolution: null,
      lookup: INITIAL.lookup,
    })
    const outcome = await runUnderIdentity(this.authority, () => this.port.loadCard(cardId))
    if (outcome.kind === 'stale' || seq !== this.cardSeq) return
    if (outcome.kind === 'failed') {
      this.set({ ...this.state, card: { status: 'error', data: null, failure: outcome.failure } })
      return
    }
    if (outcome.value === null) {
      this.set({ ...this.state, card: { status: 'not_found', data: null, failure: null } })
      return
    }
    const resolution = resolveVariant(outcome.value.variants, variantId)
    this.set({
      ...this.state,
      card: { status: 'ready', data: outcome.value, failure: null },
      resolution,
    })
    if (resolution.status === 'confirmed') {
      await this.lookup(cardId, resolution.variant.variantId)
    }
  }

  /** Opens the card a variant id belongs to (Card detail -> Price Check), with that variant chosen. */
  async openVariant(variantId: string): Promise<void> {
    const seq = (this.cardSeq += 1)
    this.set({
      ...this.state,
      card: { status: 'loading', data: null, failure: null },
      requestedVariantId: variantId,
      resolution: null,
      lookup: INITIAL.lookup,
    })
    const outcome = await runUnderIdentity(this.authority, () =>
      this.port.resolveVariant(variantId),
    )
    if (outcome.kind === 'stale' || seq !== this.cardSeq) return
    if (outcome.kind === 'failed') {
      this.set({ ...this.state, card: { status: 'error', data: null, failure: outcome.failure } })
      return
    }
    if (outcome.value === null) {
      this.set({ ...this.state, card: { status: 'not_found', data: null, failure: null } })
      return
    }
    await this.openCard(outcome.value.cardId, outcome.value.variantId)
  }

  /** The person picked a variant (never inferred, never defaulted). */
  async chooseVariant(variantId: string): Promise<void> {
    const data = this.state.card.data
    if (data === null) return
    const resolution = resolveVariant(data.variants, variantId)
    this.set({ ...this.state, requestedVariantId: variantId, resolution, lookup: INITIAL.lookup })
    if (resolution.status === 'confirmed') {
      await this.lookup(data.card.cardId, resolution.variant.variantId)
    }
  }

  async retryLookup(): Promise<void> {
    const { resolution, card } = this.state
    if (card.data === null || resolution?.status !== 'confirmed') return
    await this.lookup(card.data.card.cardId, resolution.variant.variantId)
  }

  private async lookup(cardId: string, variantId: string): Promise<void> {
    const key = `${cardId}:${variantId}`
    this.set({ ...this.state, lookup: { status: 'loading', key, result: null, failure: null } })
    const outcome = await runUnderIdentity(this.authority, () =>
      this.port.lookup(cardId, variantId),
    )
    // Dropped when the identity changed, OR when the person has since moved to another variant.
    if (outcome.kind === 'stale' || this.state.lookup.key !== key) return
    if (outcome.kind === 'failed') {
      this.set({
        ...this.state,
        lookup: { status: 'error', key, result: null, failure: outcome.failure },
      })
      return
    }
    this.set({
      ...this.state,
      lookup: { status: 'ready', key, result: outcome.value, failure: null },
    })
  }
}
