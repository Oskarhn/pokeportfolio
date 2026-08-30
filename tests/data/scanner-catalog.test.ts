import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  retrieveScannerCandidates,
  ScannerCatalogUnavailableError,
} from '../../src/data/scanner/scanner-catalog'
import type { CatalogSearchPage } from '../../src/data/catalog'

/**
 * Data-adapter contract (P67 §11, §21, §24): bounded retrieval over the EXISTING search
 * surface, number-first composition, dedupe, zero provider calls without a usable signal,
 * and provider failures mapped to a sanitized error. The `search_cards` RPC itself is mocked
 * at the src/data/catalog boundary — no DB stack required.
 */

const mocks = vi.hoisted(() => ({
  searchCards:
    vi.fn<
      (input: {
        query: string
        language: string | null
        limit?: number
      }) => Promise<CatalogSearchPage>
    >(),
}))

vi.mock('../../src/data/catalog', () => ({
  searchCards: mocks.searchCards,
}))

afterEach(() => {
  vi.clearAllMocks()
})

function page(results: Partial<CatalogSearchPage['results'][number]>[]): CatalogSearchPage {
  return {
    results: results.map((r) => ({
      cardId: r.cardId ?? 'id',
      name: r.name ?? 'Pikachu',
      localId: r.localId ?? '58',
      rarity: null,
      category: null,
      illustrator: null,
      imageBaseUrl: null,
      language: r.language ?? 'en',
      setId: 'set',
      setName: r.setName ?? 'Base Set',
      variantCount: 1,
    })),
    totalCount: results.length,
  }
}

const NAME_AND_NUMBER = {
  rawNameText: 'Pikachu',
  rawCollectorNumberText: '58/102',
}

describe('retrieveScannerCandidates — query strategy and bounds', () => {
  it('issues a NUMBER-FIRST query ("pikachu 58") plus a bare-name fallback', async () => {
    mocks.searchCards.mockResolvedValue(page([]))
    await retrieveScannerCandidates(NAME_AND_NUMBER)
    expect(mocks.searchCards).toHaveBeenCalledTimes(2)
    const queries = mocks.searchCards.mock.calls.map((call) => call[0].query)
    expect(queries).toContain('pikachu 58')
    expect(queries).toContain('pikachu')
    for (const call of mocks.searchCards.mock.calls) {
      expect(call[0].limit).toBeLessThanOrEqual(40)
    }
  })

  it('normalizes the name before querying (the engine compares normalized forms)', async () => {
    mocks.searchCards.mockResolvedValue(page([]))
    await retrieveScannerCandidates({ ...NAME_AND_NUMBER, rawNameText: "Farfetch'd" })
    expect(mocks.searchCards.mock.calls[0]?.[0]?.query).toContain('farfetchd')
  })

  it('a number-only scan with no leading zero queries just the reconstructed id, prefix included', async () => {
    mocks.searchCards.mockResolvedValue(page([]))
    await retrieveScannerCandidates({ rawCollectorNumberText: 'TG1' })
    expect(mocks.searchCards).toHaveBeenCalledTimes(1)
    expect(mocks.searchCards.mock.calls[0]?.[0]?.query).toBe('TG1')
  })

  it('a number-only scan with a leading zero also tries the unpadded form (M1/P70)', async () => {
    mocks.searchCards.mockResolvedValue(page([]))
    await retrieveScannerCandidates({ rawCollectorNumberText: 'TG01' })
    expect(mocks.searchCards).toHaveBeenCalledTimes(2)
    const queries = mocks.searchCards.mock.calls.map((call) => call[0].query)
    expect(queries).toContain('TG01')
    expect(queries).toContain('TG1')
  })

  it('a number-only scan whose form is already unpadded issues no redundant retry', async () => {
    mocks.searchCards.mockResolvedValue(page([]))
    await retrieveScannerCandidates({ rawCollectorNumberText: '49' })
    expect(mocks.searchCards).toHaveBeenCalledTimes(1)
    expect(mocks.searchCards.mock.calls[0]?.[0]?.query).toBe('49')
  })

  it('a name-only scan issues exactly one query — no duplicate work', async () => {
    mocks.searchCards.mockResolvedValue(page([]))
    await retrieveScannerCandidates({ rawNameText: 'Charizard' })
    expect(mocks.searchCards).toHaveBeenCalledTimes(1)
    expect(mocks.searchCards.mock.calls[0]?.[0]?.query).toBe('charizard')
  })

  it('passes the language hint through when parseable, null otherwise', async () => {
    mocks.searchCards.mockResolvedValue(page([]))
    await retrieveScannerCandidates({ ...NAME_AND_NUMBER, languageHint: 'Japanese' })
    expect(mocks.searchCards.mock.calls.every((call) => call[0].language === 'ja')).toBe(true)

    mocks.searchCards.mockClear()
    await retrieveScannerCandidates({ ...NAME_AND_NUMBER, languageHint: 'klingon' })
    expect(mocks.searchCards.mock.calls.every((call) => call[0].language === null)).toBe(true)
  })

  it('deduplicates overlapping results from the two queries by card id', async () => {
    const row = { cardId: 'same-id', name: 'Pikachu', localId: '58' }
    mocks.searchCards.mockImplementation((input) =>
      Promise.resolve(
        page(input.query.includes(' ') ? [row] : [row, { cardId: 'other-id', name: 'Raichu' }]),
      ),
    )
    const candidates = await retrieveScannerCandidates(NAME_AND_NUMBER)
    expect(candidates.map((c) => c.cardId)).toEqual(['same-id', 'other-id'])
  })
})

describe('retrieveScannerCandidates — no-signal and failure mapping', () => {
  it('performs ZERO provider calls for an observation without usable signals', async () => {
    for (const observation of [{}, { rawNameText: '' }, { rawNameText: 'ab' }]) {
      await retrieveScannerCandidates(observation)
    }
    expect(mocks.searchCards).not.toHaveBeenCalled()
  })

  it('maps total provider failure to a sanitized error with no raw detail', async () => {
    mocks.searchCards.mockRejectedValue(
      new Error('PGRST301 · jwt expired · internal host names and stack traces'),
    )
    const attempt = retrieveScannerCandidates(NAME_AND_NUMBER)
    await expect(attempt).rejects.toThrow(ScannerCatalogUnavailableError)
    await attempt.catch((error: unknown) => {
      expect(error instanceof Error && error.message).not.toContain('jwt')
      expect(error instanceof Error && error.message).not.toContain('PGRST301')
    })
  })

  it('tolerates partial failure — one surviving query still yields candidates', async () => {
    mocks.searchCards.mockImplementation((input) =>
      input.query === 'pikachu'
        ? Promise.reject(new Error('network reset'))
        : Promise.resolve(page([{ cardId: 'survivor' }])),
    )
    const candidates = await retrieveScannerCandidates(NAME_AND_NUMBER)
    expect(candidates.map((c) => c.cardId)).toEqual(['survivor'])
  })

  it('an empty-but-successful result set is NOT an error', async () => {
    mocks.searchCards.mockResolvedValue(page([]))
    await expect(retrieveScannerCandidates(NAME_AND_NUMBER)).resolves.toEqual([])
  })
})
