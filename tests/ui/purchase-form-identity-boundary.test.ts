import { describe, expect, it, vi } from 'vitest'
import { createInitialPurchaseFormFields } from '../../src/features/purchases/purchase-form-state'
import { EntityKeyChangeTracker } from '../../src/platform/entity-key-change-tracker'
import {
  ManualCardResolutionCache,
  resolveManualCardId,
  type ManualCardCreator,
} from '../../src/features/purchases/manual-card-resolution'

/**
 * P140 — automated regressions for P130-04/05 as they apply to `PurchaseFormPage`, plus the
 * identity-switch isolation gap P138 left untested (its own MANUAL_CARD_RETRY_TEST/
 * ACCOUNT_SWITCH_KEY_TEST entries, output_138.txt).
 *
 * No React renderer exists in this repository (see `sale-form-entity-isolation.test.ts`'s own
 * doc) — this harness mirrors `PurchaseFormPage.tsx`'s ACTUAL state and effect bodies verbatim,
 * using the real, production `createInitialPurchaseFormFields`, `EntityKeyChangeTracker` and
 * `resolveManualCardId`/`ManualCardResolutionCache`, never a re-implementation of their
 * semantics — exactly the pattern `sale-form-entity-isolation.test.ts` established for P109.
 *
 * `observeIdentity(userId)` reproduces `PurchaseFormPage.tsx`'s
 * `useEntityKeyReset(userId ?? '', () => { patch({ idempotencyKey: crypto.randomUUID() });
 * resolvedManualCards.current.clear() })` call exactly — including that the real hook's effect
 * re-runs (and therefore re-observes) on every render, which this harness models by requiring the
 * caller to call `observeIdentity` once per simulated render/retry (a test that never calls it for
 * an intervening render is, correctly, testing "the component never re-rendered between attempt 1
 * and attempt 2" — the ordinary case for a synchronous retry click).
 */
class PurchaseFormHarness {
  fields = createInitialPurchaseFormFields(() => '2026-01-01')
  readonly manualCards = new ManualCardResolutionCache()
  private readonly tracker = new EntityKeyChangeTracker()

  /** Mirrors PurchaseFormPage.tsx's `useEntityKeyReset(userId ?? '', ...)` effect body. */
  observeIdentity(userId: string | null): void {
    if (this.tracker.observe(userId ?? '')) {
      this.fields = { ...this.fields, idempotencyKey: crypto.randomUUID(), error: null }
      this.manualCards.clear()
    }
  }

  get idempotencyKey(): string {
    return this.fields.idempotencyKey
  }

  /** Mirrors the mutationFn's per-line manual-card resolution step exactly. */
  async resolveManualCard(
    lineId: string,
    trimmedName: string,
    creator: ManualCardCreator,
  ): Promise<string> {
    return resolveManualCardId(this.manualCards, lineId, trimmedName, creator)
  }
}

function creatorReturning(ids: string[]): {
  creator: ManualCardCreator
  createManualCard: (input: { name: string }) => Promise<{ id: string }>
} {
  let call = 0
  const createManualCard = vi.fn((): Promise<{ id: string }> => {
    const id = ids[call]
    call += 1
    if (id === undefined)
      throw new Error('creatorReturning: not enough ids configured for this many calls')
    return Promise.resolve({ id })
  })
  return { creator: { createManualCard }, createManualCard }
}

describe('P130-04 — PurchaseFormPage idempotencyKey lifetime (P140 automated regression)', () => {
  it('attempt 1 uses K; an ambiguous-failure retry for the SAME mounted intent uses K again', () => {
    const form = new PurchaseFormHarness()
    form.observeIdentity('user-a') // mount, under A
    const keyAttempt1 = form.idempotencyKey

    // Simulated ambiguous failure: "TypeError: Failed to fetch" after the request may already
    // have reached the server (P130-04's own evidence shape) — the component re-renders (error
    // banner shown) but nothing about the mounted intent changed.
    form.observeIdentity('user-a')
    const keyAttempt2 = form.idempotencyKey

    expect(keyAttempt2).toBe(keyAttempt1)
  })

  it("a genuinely new intent (a fresh mount, matching P138's own documented contract — success navigates away) uses K2 != K", () => {
    const formAttempt1 = new PurchaseFormHarness()
    formAttempt1.observeIdentity('user-a')
    const k1 = formAttempt1.idempotencyKey

    const formAttempt2 = new PurchaseFormHarness() // fresh mount after navigate-away on success
    formAttempt2.observeIdentity('user-a')
    const k2 = formAttempt2.idempotencyKey

    expect(k2).not.toBe(k1)
  })
})

describe('P130-05 — PurchaseFormPage manual-card resolution retry identity (P140 automated regression)', () => {
  it('manual line M: attempt 1 resolves X; a retry of the SAME intent does NOT call createManualCard again and the purchase payload still uses X', async () => {
    const form = new PurchaseFormHarness()
    form.observeIdentity('user-a')
    const { creator, createManualCard } = creatorReturning([
      'manual-card-X',
      'SHOULD-NOT-BE-CREATED',
    ])

    const attempt1Id = await form.resolveManualCard('line-1', 'Charizard', creator)
    expect(attempt1Id).toBe('manual-card-X')

    // Ambiguous createPurchase outcome; user retries the SAME logical purchase (no navigation, no
    // identity change) — the component re-renders, but the mounted intent is unchanged.
    form.observeIdentity('user-a')
    const retryId = await form.resolveManualCard('line-1', 'Charizard', creator)

    expect(retryId).toBe('manual-card-X')
    expect(createManualCard).toHaveBeenCalledTimes(1)
  })

  it('editing the manual card name before retrying resolves a fresh definition', async () => {
    const form = new PurchaseFormHarness()
    form.observeIdentity('user-a')
    const { creator, createManualCard } = creatorReturning([
      'manual-card-typo',
      'manual-card-fixed',
    ])

    const beforeEdit = await form.resolveManualCard('line-1', 'Charizrd', creator)
    const afterEdit = await form.resolveManualCard('line-1', 'Charizard', creator)

    expect(beforeEdit).toBe('manual-card-typo')
    expect(afterEdit).toBe('manual-card-fixed')
    expect(createManualCard).toHaveBeenCalledTimes(2)
  })

  it("a new purchase intent (fresh mount) never leaks the previous mount's resolution cache", async () => {
    const formAttempt1 = new PurchaseFormHarness()
    formAttempt1.observeIdentity('user-a')
    const { creator: creator1 } = creatorReturning(['manual-card-first-purchase'])
    await formAttempt1.resolveManualCard('line-1', 'Charizard', creator1)

    const formAttempt2 = new PurchaseFormHarness() // fresh mount, a genuinely new purchase
    formAttempt2.observeIdentity('user-a')
    const { creator: creator2, createManualCard: createManualCard2 } = creatorReturning([
      'manual-card-second-purchase',
    ])
    const secondId = await formAttempt2.resolveManualCard('line-1', 'Charizard', creator2)

    expect(secondId).toBe('manual-card-second-purchase')
    expect(createManualCard2).toHaveBeenCalledTimes(1) // not silently reused from attempt 1
  })
})

describe("P140 §10/§6 — identity A -> B isolation for PurchaseFormPage's P138 state", () => {
  it('key rotates and the manual-card cache is cleared the moment the observed identity changes, mid-mount, with no unmount', async () => {
    const form = new PurchaseFormHarness()

    form.observeIdentity('user-a')
    const keyA = form.idempotencyKey
    const { creator: creatorA } = creatorReturning(['manual-card-under-a'])
    const manualIdA = await form.resolveManualCard('line-1', 'Charizard', creatorA)
    expect(manualIdA).toBe('manual-card-under-a')

    // The identity switch itself — no unmount, no navigation; the SAME harness instance (standing
    // in for the SAME mounted component instance P130-23 showed survives this) just observes a
    // new userId on its next render, exactly as `useEntityKeyReset`'s effect does in production.
    form.observeIdentity('user-b')

    expect(form.idempotencyKey).not.toBe(keyA)

    // B must never reuse A's resolved manual_card_id — even for the exact same (lineId, name) —
    // and a manual definition created under A must never be handed to B's submission.
    const { creator: creatorB, createManualCard: createManualCardB } = creatorReturning([
      'manual-card-under-b',
    ])
    const manualIdB = await form.resolveManualCard('line-1', 'Charizard', creatorB)
    expect(manualIdB).toBe('manual-card-under-b')
    expect(manualIdB).not.toBe(manualIdA)
    expect(createManualCardB).toHaveBeenCalledTimes(1) // a fresh definition, not A's reused id
  })

  it('A -> B -> A: returning to the original identity is a fresh boundary too (not a remembered A state)', () => {
    const form = new PurchaseFormHarness()
    form.observeIdentity('user-a')
    const keyA1 = form.idempotencyKey
    form.observeIdentity('user-b')
    const keyB = form.idempotencyKey
    form.observeIdentity('user-a')
    const keyA2 = form.idempotencyKey

    expect(keyB).not.toBe(keyA1)
    expect(keyA2).not.toBe(keyB)
    expect(keyA2).not.toBe(keyA1)
  })

  it('an identity "change" to the SAME user (e.g. a token refresh) is a no-op — key and cache survive', async () => {
    const form = new PurchaseFormHarness()
    form.observeIdentity('user-a')
    const keyBefore = form.idempotencyKey
    const { creator } = creatorReturning(['manual-card-a'])
    const idBefore = await form.resolveManualCard('line-1', 'Charizard', creator)

    form.observeIdentity('user-a') // same identity re-observed
    form.observeIdentity('user-a')

    expect(form.idempotencyKey).toBe(keyBefore)
    const idAfter = await form.resolveManualCard('line-1', 'Charizard', creator)
    expect(idAfter).toBe(idBefore)
  })
})
