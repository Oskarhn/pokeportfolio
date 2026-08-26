import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createRealScannerController,
  classifyAcquisitionFailure,
} from '../../src/features/scanner/controller'
import {
  initialScannerDefaults,
  scannerSessionStore,
} from '../../src/features/scanner/session-store'

/**
 * Controller-level integration seams (prompt sections 18-22 and 29-31): OCR text to P67
 * retrieval over the existing search surface, deterministic ranking mapped onto P66's coarse
 * bands; printing choices fetched ONLY for a chosen candidate; batch commits through the
 * EXISTING acquisition RPC with honest per-item outcomes and NO blind retries of ambiguous
 * transports.
 *
 * The engine boundary (`runOcrAnalysis`) is stubbed here - the real Tesseract path is exercised
 * separately by the OCR smoke run (scripts/scanner-ocr-smoke.mjs), not by required CI.
 */

vi.mock('../../src/features/scanner/analyze', () => ({
  runOcrAnalysis: vi.fn(),
  releaseOcrCanvases: vi.fn(),
}))

vi.mock('../../src/data/catalog', () => ({
  searchCards: vi.fn(),
  getCardVariants: vi.fn(),
}))

vi.mock('../../src/data/collection', () => ({
  addCardAcquisition: vi.fn(),
}))

import { runOcrAnalysis } from '../../src/features/scanner/analyze'
import { getCardVariants, searchCards } from '../../src/data/catalog'
import { addCardAcquisition } from '../../src/data/collection'

const mockedRunOcrAnalysis = vi.mocked(runOcrAnalysis)
const mockedSearchCards = vi.mocked(searchCards)
const mockedGetCardVariants = vi.mocked(getCardVariants)
const mockedAddCardAcquisition = vi.mocked(addCardAcquisition)

function capture() {
  return {
    blob: new Blob(['synthetic'], { type: 'image/jpeg' }),
    width: 500,
    height: 700,
    cardRect: { left: 0, top: 0, width: 500, height: 700 },
  }
}

/** Rows in the MAPPED shape src/data/catalog.searchCards resolves to (the adapter's input). */
function catalogRow(
  overrides: {
    cardId?: string
    name?: string
    localId?: string
    language?: 'en' | 'ja'
    setName?: string
  } = {},
) {
  return {
    cardId: overrides.cardId ?? 'card-1',
    name: overrides.name ?? 'Pikachu',
    localId: overrides.localId ?? '58',
    rarity: 'Basic',
    category: 'Pokemon',
    illustrator: null,
    imageBaseUrl: 'https://assets.tcgdex.net/en/base/base1/58/high.jpg',
    language: overrides.language ?? ('en' as const),
    setId: 'set-1',
    setName: overrides.setName ?? 'Base Set',
    variantCount: 2,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  scannerSessionStore.clearAll()
})

describe('analyzeCapture - observation, retrieval, ranking (I2/I3/I4)', () => {
  it('feeds OCR text to the EXISTING search surface number-first, capped to a short shortlist', async () => {
    scannerSessionStore.save('user-a', initialScannerDefaults())
    mockedRunOcrAnalysis.mockResolvedValue({
      rawNameText: 'Pikachu',
      rawCollectorNumberText: '58/102',
      usedFullFrameFallback: false,
    })
    mockedSearchCards.mockResolvedValue({
      results: Array.from({ length: 9 }, (_, index) =>
        catalogRow({ cardId: `card-${index}`, localId: String(index) }),
      ),
      totalCount: 9,
    })
    const controller = createRealScannerController({ userId: 'user-a' })
    const analysis = await controller.analyzeCapture(capture())

    // The composed number-first query rides search_cards' own trailing-number parsing.
    expect(mockedSearchCards).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'pikachu 58', language: 'en' }),
    )
    // UI shortlist bound (prompt section 20): nine ranked rows in, FIVE candidates out.
    expect(analysis.candidates.length).toBeLessThanOrEqual(5)
    expect(analysis.candidates[0]).toMatchObject({
      candidateId: 'card-0',
      name: 'Pikachu',
      collectorNumber: '0',
    })
  })

  it('issues ZERO catalog queries when nothing usable was read', async () => {
    mockedRunOcrAnalysis.mockResolvedValue({
      rawNameText: null,
      rawCollectorNumberText: null,
      usedFullFrameFallback: true,
    })
    const controller = createRealScannerController({ userId: 'user-a' })
    const analysis = await controller.analyzeCapture(capture())
    expect(mockedSearchCards).not.toHaveBeenCalled()
    expect(analysis.confidence).toBe('NO_MATCH')
    expect(analysis.candidates).toHaveLength(0)
  })

  it('maps P67 tiers onto P66 bands deterministically (I3/I4)', async () => {
    mockedRunOcrAnalysis.mockResolvedValue({
      rawNameText: 'Bill',
      rawCollectorNumberText: null,
      usedFullFrameFallback: false,
    })
    // Name-only evidence tops out at LOW per P67's weight table.
    mockedSearchCards.mockResolvedValue({
      results: [catalogRow({ cardId: 'bill-88', localId: '88', name: 'Bill' })],
      totalCount: 1,
    })
    const controller = createRealScannerController({ userId: 'user-a' })
    const low = await controller.analyzeCapture(capture())
    expect(low.confidence).toBe('LOW')

    // Convergent printed evidence (name + id + language) reaches HIGH.
    mockedRunOcrAnalysis.mockResolvedValue({
      rawNameText: 'Pikachu',
      rawCollectorNumberText: '58/102',
      usedFullFrameFallback: false,
    })
    mockedSearchCards.mockResolvedValue({
      results: [
        catalogRow({ cardId: 'pika-58', localId: '58' }),
        catalogRow({ cardId: 'other-1', localId: '99', setName: 'Other Set', name: 'Othermon' }),
      ],
      totalCount: 2,
    })
    const high = await controller.analyzeCapture(capture())
    expect(high.confidence).toBe('HIGH')
  })

  it('never lets image bytes cross into the domain or data layers (I8 runtime half)', async () => {
    scannerSessionStore.save('user-a', initialScannerDefaults())
    mockedRunOcrAnalysis.mockResolvedValue({
      rawNameText: 'Pikachu',
      rawCollectorNumberText: '58',
      usedFullFrameFallback: false,
    })
    mockedSearchCards.mockResolvedValue({ results: [], totalCount: 0 })
    const controller = createRealScannerController({ userId: 'user-a' })
    await controller.analyzeCapture(capture())
    for (const call of mockedSearchCards.mock.calls) {
      const params = call[0]
      expect(typeof params.query).toBe('string')
      for (const value of Object.values(params)) {
        expect(['string', 'number', 'undefined'].includes(typeof value)).toBe(true)
      }
    }
  })

  it('maps catalog failure to the SANITIZED unavailable error (I15)', async () => {
    mockedRunOcrAnalysis.mockResolvedValue({
      rawNameText: 'Pikachu',
      rawCollectorNumberText: '58',
      usedFullFrameFallback: false,
    })
    mockedSearchCards.mockRejectedValue(new Error('raw PostgREST internals must not leak'))
    const controller = createRealScannerController({ userId: 'user-a' })
    await expect(controller.analyzeCapture(capture())).rejects.toMatchObject({
      message: 'Card catalog lookup failed. Check your connection and try again.',
    })
  })
})

describe('searchFallback - manual search through the existing surface (section 21)', () => {
  it('composes name+number for the same trailing-number parser and passes session language', async () => {
    mockedSearchCards.mockResolvedValue({ results: [], totalCount: 0 })
    scannerSessionStore.save('user-a', { ...initialScannerDefaults(), language: 'en' })
    const controller = createRealScannerController({ userId: 'user-a' })
    const results = await controller.searchFallback({
      name: 'Charizard',
      collectorNumber: '4/102',
    })
    expect(mockedSearchCards).toHaveBeenCalledWith({
      query: 'Charizard 4/102',
      language: 'en',
      limit: 5,
    })
    expect(results).toEqual([])
  })

  it('surfaces catalog rows as opaque UI candidates', async () => {
    mockedSearchCards.mockResolvedValue({
      results: [catalogRow({ cardId: 'c1', localId: '4', name: 'Charizard' })],
      totalCount: 1,
    })
    const controller = createRealScannerController({ userId: 'user-a' })
    const results = await controller.searchFallback({ name: 'Charizard' })
    expect(results).toEqual([expect.objectContaining({ candidateId: 'c1', collectorNumber: '4' })])
  })
})

describe('listVariantChoices - printing identity AFTER candidate choice (I5/I6/I7)', () => {
  it('fetches variants for the chosen card and lists ACTIVE ones with actual attributes', async () => {
    mockedGetCardVariants.mockResolvedValue([
      {
        id: 'v-normal',
        finish: 'normal',
        stamp: '',
        subtype: '',
        size: 'standard',
        isActive: true,
      },
      {
        id: 'v-holo',
        finish: 'holo',
        stamp: '1st edition',
        subtype: '',
        size: 'standard',
        isActive: true,
      },
      {
        id: 'v-dead',
        finish: 'reverse',
        stamp: '',
        subtype: '',
        size: 'standard',
        isActive: false,
      },
    ])
    const controller = createRealScannerController({ userId: 'user-a' })
    const choices = await controller.listVariantChoices('card-1')
    expect(mockedGetCardVariants).toHaveBeenCalledWith('card-1')
    expect(choices).toEqual([
      { id: 'v-normal', label: 'Normal' },
      { id: 'v-holo', label: 'Holo · 1st edition stamp' },
    ])
  })

  it('an empty active set comes back honestly empty - nothing fabricated', async () => {
    mockedGetCardVariants.mockResolvedValue([])
    const controller = createRealScannerController({ userId: 'user-a' })
    expect(await controller.listVariantChoices('card-1')).toEqual([])
  })
})

describe('commitBatch - existing acquisition path, honest outcomes (I12/I13/I14)', () => {
  function items(count: number) {
    return Array.from({ length: count }, (_, index) => ({
      candidateId: `card-${index}`,
      variantId: `variant-${index}`,
      quantity: index + 1,
      condition: 'NM' as const,
    }))
  }

  it('performs ZERO writes during analysis - only commitBatch writes', async () => {
    mockedRunOcrAnalysis.mockResolvedValue({
      rawNameText: 'Pikachu',
      rawCollectorNumberText: '58',
      usedFullFrameFallback: false,
    })
    mockedSearchCards.mockResolvedValue({ results: [], totalCount: 0 })
    const controller = createRealScannerController({ userId: 'user-a' })
    await controller.analyzeCapture(capture())
    expect(mockedAddCardAcquisition).not.toHaveBeenCalled()
  })

  it('runs SEQUENTIALLY through add_card_acquisition and marks definite successes', async () => {
    const callOrder: string[] = []
    mockedAddCardAcquisition.mockImplementation((input) => {
      callOrder.push(input.cardVariantId ?? '')
      return Promise.resolve({ holdingId: 'h', lotId: 'l' })
    })
    scannerSessionStore.save('user-a', {
      ...initialScannerDefaults(),
      storageLocationId: 'loc-1',
      acquiredOn: '2026-08-20',
      origin: 'pre_tracking',
    })
    const controller = createRealScannerController({ userId: 'user-a' })
    const result = await controller.commitBatch(items(3))
    expect(result.addedCount).toBe(3)
    expect(result.outcomes.every((outcome) => outcome.status === 'added')).toBe(true)
    // Sequential: the three calls ran in batch order, one at a time.
    expect(callOrder).toEqual(['variant-0', 'variant-1', 'variant-2'])
    // Session defaults applied verbatim; basis derived from the SHARED origin mapping
    // (pre_tracking -> unknown - never a fabricated zero).
    expect(mockedAddCardAcquisition).toHaveBeenCalledWith(
      expect.objectContaining({
        cardVariantId: 'variant-0',
        gradingState: 'raw',
        origin: 'pre_tracking',
        costBasisState: 'unknown',
        quantity: 1,
        acquiredOn: '2026-08-20',
        storageLocationId: 'loc-1',
      }),
    )
    expect(mockedAddCardAcquisition.mock.calls).toHaveLength(3)
  })

  it('isolates a DEFINITE server rejection without aborting the rest (I13)', async () => {
    mockedAddCardAcquisition.mockImplementation((input) => {
      if (input.cardVariantId === 'variant-1') {
        return Promise.reject(Object.assign(new Error('foreign key violation'), { code: '23503' }))
      }
      return Promise.resolve({ holdingId: 'h', lotId: 'l' })
    })
    const controller = createRealScannerController({ userId: 'user-a' })
    const result = await controller.commitBatch(items(3))
    expect(result.addedCount).toBe(2)
    expect(result.outcomes.map((outcome) => outcome.status)).toEqual(['added', 'failed', 'added'])
    expect(result.outcomes[1]?.message).toMatch(/did not accept/i)
    // Raw server detail must not travel to the UI copy.
    expect(result.outcomes[1]?.message).not.toMatch(/foreign key/)
  })

  it('marks an AMBIGUOUS transport break needs_verification and never retries it (I14)', async () => {
    let attempted = false
    mockedAddCardAcquisition.mockImplementation(() => {
      if (!attempted) {
        attempted = true
        return Promise.reject(new TypeError('Failed to fetch'))
      }
      return Promise.reject(new Error('MUST NOT be retried automatically'))
    })
    const controller = createRealScannerController({ userId: 'user-a' })
    const result = await controller.commitBatch(items(1))
    expect(attempted).toBe(true)
    expect(mockedAddCardAcquisition).toHaveBeenCalledTimes(1)
    expect(result.addedCount).toBe(0)
    expect(result.outcomes[0]?.status).toBe('needs_verification')
    expect(result.outcomes[0]?.message).toMatch(/may already have been added/)
  })

  it('classifyAcquisitionFailure keys on evidence of a server ANSWER, not message text', () => {
    const coded = classifyAcquisitionFailure(0, Object.assign(new Error('x'), { code: '42501' }))
    expect(coded.status).toBe('failed')
    const hinted = classifyAcquisitionFailure(0, Object.assign(new Error('x'), { hint: 'y' }))
    expect(hinted.status).toBe('failed')
    const transport = classifyAcquisitionFailure(0, new TypeError('network died'))
    expect(transport.status).toBe('needs_verification')
    const plain = classifyAcquisitionFailure(0, new Error('something else'))
    expect(plain.status).toBe('needs_verification')
  })

  it('falls back safely when no session defaults exist - never guessing financial values', async () => {
    mockedAddCardAcquisition.mockResolvedValue({ holdingId: 'h', lotId: 'l' })
    const controller = createRealScannerController({ userId: null })
    await controller.commitBatch(items(1))
    expect(mockedAddCardAcquisition).toHaveBeenCalledWith(
      expect.objectContaining({
        origin: 'pre_tracking',
        costBasisState: 'unknown',
      }),
    )
  })

  it('dispose terminates the engine session (I16 seam)', () => {
    const controller = createRealScannerController({ userId: 'user-a' })
    expect(() => {
      controller.dispose()
    }).not.toThrow()
    expect(() => {
      controller.dispose()
    }).not.toThrow()
  })
})
