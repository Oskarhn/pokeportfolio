import { describe, expect, it } from 'vitest'
import { EntityKeyChangeTracker } from '../../src/platform/entity-key-change-tracker'

/**
 * P140 — automated regressions for P130-04's `clientRequestKey` lifetime on `AddToCollectionPage`
 * and `AddSealedProductPage`, plus the identity-switch isolation gap P138 left untested for these
 * two pages (output_138.txt's own ACCOUNT_SWITCH_KEY_TEST entry: "investigated... not added").
 *
 * No React renderer exists in this repository — these harnesses mirror each page's ACTUAL
 * `useState`/`useEntityKeyReset` wiring verbatim, using the real, production
 * `EntityKeyChangeTracker` (the same class `useEntityKeyReset` is built on), never a
 * re-implementation of its semantics.
 */

/** Mirrors `AddToCollectionPage.tsx`'s own composite key:
 *  `${userId ?? ''}|${variantId ?? ''}|${manualCardId ?? ''}`. */
class AddToCollectionHarness {
  clientRequestKey = crypto.randomUUID()
  private readonly tracker = new EntityKeyChangeTracker()

  render(
    userId: string | null,
    variantId: string | undefined,
    manualCardId: string | undefined,
  ): void {
    const key = `${userId ?? ''}|${variantId ?? ''}|${manualCardId ?? ''}`
    if (this.tracker.observe(key)) {
      this.clientRequestKey = crypto.randomUUID()
    }
  }
}

/** Mirrors `AddSealedProductPage.tsx`'s own composite key: `${userId ?? ''}|${selectedProductId ?? ''}`. */
class AddSealedHarness {
  clientRequestKey = crypto.randomUUID()
  private readonly tracker = new EntityKeyChangeTracker()

  render(userId: string | null, selectedProductId: string | undefined): void {
    const key = `${userId ?? ''}|${selectedProductId ?? ''}`
    if (this.tracker.observe(key)) {
      this.clientRequestKey = crypto.randomUUID()
    }
  }
}

describe('P130-04 — AddToCollectionPage clientRequestKey lifetime (P140 automated regression)', () => {
  it('attempt 1 uses K; a retry of the SAME mounted intent (same variantId, same user) uses K again', () => {
    const form = new AddToCollectionHarness()
    form.render('user-a', 'variant-1', undefined)
    const k1 = form.clientRequestKey
    form.render('user-a', 'variant-1', undefined) // re-render after an ambiguous-failure retry
    expect(form.clientRequestKey).toBe(k1)
  })

  it('a new deliberate intent — a different card, same mount, no unmount (no remountDeps on /add) — uses K2 != K', () => {
    const form = new AddToCollectionHarness()
    form.render('user-a', 'variant-1', undefined)
    const k1 = form.clientRequestKey
    form.render('user-a', 'variant-2', undefined) // /add?variantId=variant-2, same component instance
    expect(form.clientRequestKey).not.toBe(k1)
  })

  it('switching from a catalog variant to a manual card target (same mount) is also a new intent', () => {
    const form = new AddToCollectionHarness()
    form.render('user-a', 'variant-1', undefined)
    const k1 = form.clientRequestKey
    form.render('user-a', undefined, 'manual-card-9')
    expect(form.clientRequestKey).not.toBe(k1)
  })

  it('identity switch (same card target) rotates the key even without any entity change', () => {
    const form = new AddToCollectionHarness()
    form.render('user-a', 'variant-1', undefined)
    const keyA = form.clientRequestKey
    form.render('user-b', 'variant-1', undefined) // same target, different signed-in identity
    expect(form.clientRequestKey).not.toBe(keyA)
  })

  it('a re-render with fully identical (user, variant, manualCard) is a no-op', () => {
    const form = new AddToCollectionHarness()
    form.render('user-a', 'variant-1', undefined)
    const k1 = form.clientRequestKey
    form.render('user-a', 'variant-1', undefined)
    form.render('user-a', 'variant-1', undefined)
    expect(form.clientRequestKey).toBe(k1)
  })
})

describe('P130-04 — AddSealedProductPage clientRequestKey lifetime (P140 automated regression)', () => {
  it('attempt 1 uses K; a retry of the SAME mounted intent uses K again', () => {
    const form = new AddSealedHarness()
    form.render('user-a', 'product-1')
    const k1 = form.clientRequestKey
    form.render('user-a', 'product-1')
    expect(form.clientRequestKey).toBe(k1)
  })

  it('"Choose a different product" (same mount, selectedProductId changes) is a new deliberate intent: K2 != K', () => {
    const form = new AddSealedHarness()
    form.render('user-a', 'product-1')
    const k1 = form.clientRequestKey
    form.render('user-a', undefined) // back to the picker
    form.render('user-a', 'product-2') // a different product, same component instance
    expect(form.clientRequestKey).not.toBe(k1)
  })

  it('identity switch (same product target) rotates the key', () => {
    const form = new AddSealedHarness()
    form.render('user-a', 'product-1')
    const keyA = form.clientRequestKey
    form.render('user-b', 'product-1')
    expect(form.clientRequestKey).not.toBe(keyA)
  })
})

describe('P140 §10 — identity A -> B isolation matrix for both Add pages', () => {
  it("AddToCollectionPage: A -> B -> A is three distinct keys, never a resurrection of A's first key", () => {
    const form = new AddToCollectionHarness()
    form.render('user-a', 'variant-1', undefined)
    const keyA1 = form.clientRequestKey
    form.render('user-b', 'variant-1', undefined)
    const keyB = form.clientRequestKey
    form.render('user-a', 'variant-1', undefined)
    const keyA2 = form.clientRequestKey

    expect(keyB).not.toBe(keyA1)
    expect(keyA2).not.toBe(keyB)
    expect(keyA2).not.toBe(keyA1)
  })

  it('AddSealedProductPage: A -> B -> A is three distinct keys', () => {
    const form = new AddSealedHarness()
    form.render('user-a', 'product-1')
    const keyA1 = form.clientRequestKey
    form.render('user-b', 'product-1')
    const keyB = form.clientRequestKey
    form.render('user-a', 'product-1')
    const keyA2 = form.clientRequestKey

    expect(keyB).not.toBe(keyA1)
    expect(keyA2).not.toBe(keyB)
    expect(keyA2).not.toBe(keyA1)
  })

  it("a same-user re-render (e.g. token refresh) never rotates either page's key", () => {
    const addForm = new AddToCollectionHarness()
    addForm.render('user-a', 'variant-1', undefined)
    const addKey = addForm.clientRequestKey
    addForm.render('user-a', 'variant-1', undefined)
    expect(addForm.clientRequestKey).toBe(addKey)

    const sealedForm = new AddSealedHarness()
    sealedForm.render('user-a', 'product-1')
    const sealedKey = sealedForm.clientRequestKey
    sealedForm.render('user-a', 'product-1')
    expect(sealedForm.clientRequestKey).toBe(sealedKey)
  })
})
