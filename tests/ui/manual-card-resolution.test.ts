import { describe, expect, it, vi } from 'vitest'
import {
  ManualCardResolutionCache,
  resolveManualCardId,
} from '../../src/features/purchases/manual-card-resolution'

/**
 * P140 automated regression for P130-05 (fixed client-side in P138, never given an automated
 * test there — see output_138.txt's own MANUAL_CARD_RETRY_TEST/BLOCKERS entries). Tests the REAL
 * production module `PurchaseFormPage.tsx` imports and calls (`manual-card-resolution.ts`), not a
 * re-implementation — a regression here is a regression in the page's actual behavior.
 */

function creatorReturning(ids: string[]): {
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
  return { createManualCard }
}

describe('ManualCardResolutionCache / resolveManualCardId (P130-05 automated regression)', () => {
  it('same line, same (trimmed) name, retried: createManualCard is called exactly once and the retry returns the SAME id', async () => {
    const cache = new ManualCardResolutionCache()
    const creator = creatorReturning(['manual-card-x', 'manual-card-SHOULD-NOT-BE-USED'])

    const first = await resolveManualCardId(cache, 'line-1', 'Charizard (Japanese)', creator)
    // Simulated retry after an ambiguous failure — the SAME logical intent, same line, same name.
    const retry = await resolveManualCardId(cache, 'line-1', 'Charizard (Japanese)', creator)

    expect(first).toBe('manual-card-x')
    expect(retry).toBe('manual-card-x')
    expect(creator.createManualCard).toHaveBeenCalledTimes(1)
  })

  it('the manual card name is edited before retrying: a fresh definition is resolved (never silently reuses the stale id)', async () => {
    const cache = new ManualCardResolutionCache()
    const creator = creatorReturning(['manual-card-old-name', 'manual-card-new-name'])

    const beforeEdit = await resolveManualCardId(cache, 'line-1', 'Charizrd', creator) // typo
    const afterEdit = await resolveManualCardId(cache, 'line-1', 'Charizard', creator) // corrected

    expect(beforeEdit).toBe('manual-card-old-name')
    expect(afterEdit).toBe('manual-card-new-name')
    expect(afterEdit).not.toBe(beforeEdit)
    expect(creator.createManualCard).toHaveBeenCalledTimes(2)

    // Retrying the CORRECTED name reuses the corrected id, not the stale one.
    const retryAfterEdit = await resolveManualCardId(cache, 'line-1', 'Charizard', creator)
    expect(retryAfterEdit).toBe('manual-card-new-name')
    expect(creator.createManualCard).toHaveBeenCalledTimes(2)
  })

  it('two separate lines with the IDENTICAL manual card name are never conflated — each resolves its own id', async () => {
    const cache = new ManualCardResolutionCache()
    const creator = creatorReturning(['manual-card-line-1', 'manual-card-line-2'])

    const line1Id = await resolveManualCardId(cache, 'line-1', 'Pikachu Promo', creator)
    const line2Id = await resolveManualCardId(cache, 'line-2', 'Pikachu Promo', creator)

    expect(line1Id).toBe('manual-card-line-1')
    expect(line2Id).toBe('manual-card-line-2')
    expect(line1Id).not.toBe(line2Id)
    expect(creator.createManualCard).toHaveBeenCalledTimes(2)

    // Retrying either line independently still resolves its OWN id, not the other line's.
    const line1Retry = await resolveManualCardId(cache, 'line-1', 'Pikachu Promo', creator)
    const line2Retry = await resolveManualCardId(cache, 'line-2', 'Pikachu Promo', creator)
    expect(line1Retry).toBe('manual-card-line-1')
    expect(line2Retry).toBe('manual-card-line-2')
    expect(creator.createManualCard).toHaveBeenCalledTimes(2)
  })

  it('clear() discards every resolution — a NEW resolve() for a previously-cached (line, name) creates a fresh definition rather than reusing the discarded id', async () => {
    const cache = new ManualCardResolutionCache()
    const creator = creatorReturning(['manual-card-under-a', 'manual-card-under-b'])

    const underA = await resolveManualCardId(cache, 'line-1', 'Charizard', creator)
    expect(underA).toBe('manual-card-under-a')
    expect(cache.size()).toBe(1)

    cache.clear() // P140: the identity-switch reset calls this
    expect(cache.size()).toBe(0)

    const underB = await resolveManualCardId(cache, 'line-1', 'Charizard', creator)
    expect(underB).toBe('manual-card-under-b')
    expect(underB).not.toBe(underA)
    expect(creator.createManualCard).toHaveBeenCalledTimes(2)
  })

  it('a name with different surrounding whitespace is treated by the CALLER-trimmed value passed in — the cache itself does not re-trim', async () => {
    // PurchaseFormPage.tsx always passes an already-trimmed name (`draft.manualCardName.trim()`);
    // this documents that the cache is a plain string key, not a defensive re-trimmer, so a caller
    // regression that stops trimming would be visible as a cache-miss, not a silent double-trim.
    const cache = new ManualCardResolutionCache()
    const creator = creatorReturning(['a', 'b'])
    await resolveManualCardId(cache, 'line-1', 'Charizard', creator)
    const second = await resolveManualCardId(cache, 'line-1', ' Charizard ', creator)
    expect(second).toBe('b')
    expect(creator.createManualCard).toHaveBeenCalledTimes(2)
  })
})
