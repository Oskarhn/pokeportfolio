import { describe, expect, it } from 'vitest'
import { resolveVariant } from '../../../src/domain/price-check/identity'
import type { VariantFinish, VariantIdentity } from '../../../src/domain/price-check/types'

/**
 * P165 — "a card with several printings never gets a silently chosen one", stated as a property over
 * many shapes of variant list, not as three hand-picked examples. The expected answer is computed
 * independently of the implementation from the definition alone: a price belongs to ONE exact
 * variant, so it may be shown without a choice only when exactly one ACTIVE printing exists.
 */

const FINISHES: VariantFinish[] = ['normal', 'holo', 'reverse', 'other']

function variant(index: number, isActive: boolean): VariantIdentity {
  return {
    variantId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    finish: FINISHES[index % FINISHES.length] ?? 'normal',
    stamp: index % 3 === 0 ? 'stamp' : '',
    subtype: '',
    size: 'standard',
    isActive,
  }
}

/** Every combination of active/inactive flags for lists of 1 to 6 printings (126 shapes). */
function allShapes(): VariantIdentity[][] {
  const shapes: VariantIdentity[][] = []
  for (let size = 1; size <= 6; size += 1) {
    for (let mask = 0; mask < 2 ** size; mask += 1) {
      shapes.push(Array.from({ length: size }, (_, i) => variant(i, ((mask >> i) & 1) === 1)))
    }
  }
  return shapes
}

describe('variant resolution without an explicit request (P165)', () => {
  it('confirms a printing only when exactly one of them is active — for every shape of list', () => {
    const shapes = allShapes()
    expect(shapes).toHaveLength(126)
    for (const variants of shapes) {
      const active = variants.filter((v) => v.isActive)
      const result = resolveVariant(variants, undefined)
      if (active.length === 1) {
        expect(result).toEqual({
          status: 'confirmed',
          variant: active[0],
          basis: 'only_variant',
        })
      } else {
        // none active, or several: the person must choose, and every printing is offered
        expect(result.status).toBe('choice_required')
        expect(result).toMatchObject({ variants })
      }
    }
  })

  it('the order of the list never decides: no printing is preferred for being first, last or cheap', () => {
    for (const variants of allShapes()) {
      if (variants.filter((v) => v.isActive).length < 2) continue
      expect(resolveVariant(variants, undefined).status).toBe('choice_required')
      expect(resolveVariant([...variants].reverse(), undefined).status).toBe('choice_required')
    }
  })

  it('an explicit request is honoured only for a printing of THIS card', () => {
    const variants = [variant(0, true), variant(1, true), variant(2, false)]
    for (const chosen of variants) {
      expect(resolveVariant(variants, chosen.variantId)).toEqual({
        status: 'confirmed',
        variant: chosen,
        basis: 'chosen',
      })
    }
    const foreign = '00000000-0000-4000-8000-0000000000ff'
    expect(resolveVariant(variants, foreign)).toEqual({
      status: 'mismatch',
      requestedVariantId: foreign,
      variants,
    })
  })

  it('an EMPTY request is a request that matches nothing, not "no request": it never picks a printing', () => {
    // `?variant=` in a URL arrives as ''. Treating it as absent would silently choose for a single
    // active printing; treating it as a choice would be wrong too.
    const variants = [variant(0, true), variant(1, true)]
    expect(resolveVariant(variants, '')).toMatchObject({
      status: 'mismatch',
      requestedVariantId: '',
    })
    const single = [variant(0, true)]
    expect(resolveVariant(single, '')).toMatchObject({ status: 'mismatch' })
  })

  it('a card with no printings at all has nothing to price', () => {
    expect(resolveVariant([], undefined)).toEqual({ status: 'no_variants' })
    expect(resolveVariant([], 'anything')).toEqual({ status: 'no_variants' })
  })
})
