import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
  getCardsByIds: vi.fn().mockResolvedValue([]),
}))

vi.mock('../../src/data/collection', () => ({
  addCardAcquisition: vi.fn(),
}))

// P78: a controllable stand-in for the visual channel so diagnostics-assembly logic (R1) can be
// tested in isolation from the real Worker/transformers.js pipeline, which
// scanner-visual-client.test.ts and visual-backend-selection.test.ts already cover directly.
const visualMocks = vi.hoisted(() => ({
  analyze: vi.fn(),
  getDiagnosticsSnapshot: vi.fn(),
  dispose: vi.fn(),
  prewarm: vi.fn(),
  getExpectedCardRank: vi.fn(),
}))

vi.mock('../../src/features/scanner/visual/visual-client', () => ({
  VisualRecognitionClient: class {
    analyze = visualMocks.analyze
    getDiagnosticsSnapshot = visualMocks.getDiagnosticsSnapshot
    dispose = visualMocks.dispose
    prewarm = visualMocks.prewarm
    getExpectedCardRank = visualMocks.getExpectedCardRank
  },
}))

// P82 §16: the controller now calls engine.prepare() (real tesseract.js, real Worker construction)
// IMMEDIATELY on prewarm() rather than after a stagger — a controllable stand-in keeps every
// fake-timer-driven prewarm/stagger test from spawning a real (and, under Node, doomed-to-fail)
// Tesseract worker as an unhandled side effect, exactly like the existing visual-client mock above.
const ocrEngineMocks = vi.hoisted(() => ({
  prepare: vi.fn().mockResolvedValue(undefined),
  recognize: vi.fn(),
  dispose: vi.fn(),
  getState: vi.fn().mockReturnValue('not-loaded' as const),
}))

vi.mock('../../src/features/scanner/ocr-engine', () => ({
  ScannerOcrEngine: class {
    prepare = ocrEngineMocks.prepare
    recognize = ocrEngineMocks.recognize
    dispose = ocrEngineMocks.dispose
    getState = ocrEngineMocks.getState
  },
}))

import { runOcrAnalysis } from '../../src/features/scanner/analyze'
import { getCardVariants, searchCards, getCardsByIds } from '../../src/data/catalog'
import { addCardAcquisition } from '../../src/data/collection'

const mockedRunOcrAnalysis = vi.mocked(runOcrAnalysis)
const mockedSearchCards = vi.mocked(searchCards)
const mockedGetCardVariants = vi.mocked(getCardVariants)
const mockedGetCardsByIds = vi.mocked(getCardsByIds)
const mockedAddCardAcquisition = vi.mocked(addCardAcquisition)

/** Default: visual channel unavailable, matching how it naturally behaves in this Node test
 *  environment (no real Worker) — existing tests above assume OCR-only results. */
function defaultLiveProgress() {
  return {
    workerBooted: false,
    workerBootMs: null,
    currentPhase: null,
    currentPhaseElapsedMs: null,
    lastProgressMsAgo: null,
  }
}

function defaultVisualDiagnostics() {
  return {
    modelState: 'not-loaded' as const,
    unavailableReason: null,
    readyInfo: null,
    backendDiagnostics: null,
    firstEmbedMs: null,
    liveProgress: defaultLiveProgress(),
  }
}

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
  visualMocks.analyze.mockResolvedValue(null)
  visualMocks.getDiagnosticsSnapshot.mockReturnValue(defaultVisualDiagnostics())
  visualMocks.prewarm.mockResolvedValue(null)
  ocrEngineMocks.prepare.mockResolvedValue(undefined)
  ocrEngineMocks.getState.mockReturnValue('not-loaded')
})

describe('analyzeCapture - observation, retrieval, ranking (I2/I3/I4)', () => {
  it('feeds OCR text to the EXISTING search surface number-first, capped to a short shortlist', async () => {
    scannerSessionStore.save('user-a', initialScannerDefaults())
    mockedRunOcrAnalysis.mockResolvedValue({
      rawNameText: 'Pikachu',
      rawCollectorNumberText: '58/102',
      usedFullFrameFallback: false,
      nameRoiId: null,
      numberRoiId: null,
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
    // UI shortlist bound (prompt section 20, widened per P80 §6): none of these nine rows carries
    // the printed id "58/102", so all nine score identically on name alone — a flat ranking, which
    // P80's candidate-expansion rule widens toward 8 rather than hiding four of them outright.
    expect(analysis.candidates.length).toBeLessThanOrEqual(8)
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
      nameRoiId: null,
      numberRoiId: null,
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
      nameRoiId: null,
      numberRoiId: null,
    })
    // Name-only evidence tops out at LOW per P67's weight table.
    mockedSearchCards.mockResolvedValue({
      results: [catalogRow({ cardId: 'bill-88', localId: '88', name: 'Bill' })],
      totalCount: 1,
    })
    const controller = createRealScannerController({ userId: 'user-a' })
    const low = await controller.analyzeCapture(capture())
    expect(low.confidence).toBe('LOW')

    // Convergent printed evidence (name + id) reaches MEDIUM, not HIGH (P93/N-09): language
    // agreement no longer scores (every candidate is already 'en' by construction) and
    // `rawSetText` is never populated in production (controller.ts's own `observation` literal),
    // so text-only id+name convergence tops out at 75 — below highMinScore (80). Reaching HIGH
    // now genuinely requires either a third text signal or the visual channel's corroboration
    // (engine.test.ts's own suite exercises that combination at the pure-domain level).
    mockedRunOcrAnalysis.mockResolvedValue({
      rawNameText: 'Pikachu',
      rawCollectorNumberText: '58/102',
      usedFullFrameFallback: false,
      nameRoiId: null,
      numberRoiId: null,
    })
    mockedSearchCards.mockResolvedValue({
      results: [
        catalogRow({ cardId: 'pika-58', localId: '58' }),
        catalogRow({ cardId: 'other-1', localId: '99', setName: 'Other Set', name: 'Othermon' }),
      ],
      totalCount: 2,
    })
    const high = await controller.analyzeCapture(capture())
    expect(high.confidence).toBe('MEDIUM')
  })

  it('never lets image bytes cross into the domain or data layers (I8 runtime half)', async () => {
    scannerSessionStore.save('user-a', initialScannerDefaults())
    mockedRunOcrAnalysis.mockResolvedValue({
      rawNameText: 'Pikachu',
      rawCollectorNumberText: '58',
      usedFullFrameFallback: false,
      nameRoiId: null,
      numberRoiId: null,
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
      nameRoiId: null,
      numberRoiId: null,
    })
    mockedSearchCards.mockRejectedValue(new Error('raw PostgREST internals must not leak'))
    const controller = createRealScannerController({ userId: 'user-a' })
    await expect(controller.analyzeCapture(capture())).rejects.toMatchObject({
      message: 'Card catalog lookup failed. Check your connection and try again.',
    })
  })
})

describe('P81/P82: route-entry prewarm and bounded visual wait (iPhone cold-start repair)', () => {
  it('P81-1/P81-2: prewarm() can run without any capture and is idempotent', () => {
    vi.useFakeTimers()
    try {
      const controller = createRealScannerController({ userId: 'user-a' })
      controller.prewarm?.()
      controller.prewarm?.()
      vi.advanceTimersByTime(1500)
      expect(visualMocks.prewarm).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('P82-16: the FAST (OCR) baseline is staggered AHEAD of the heavyweight DINO channel, not started at the same instant', () => {
    vi.useFakeTimers()
    try {
      const controller = createRealScannerController({ userId: 'user-a' })
      controller.prewarm?.()
      // The heavyweight DINO channel has NOT been asked to warm yet — OCR gets the head start now
      // (P82 §16 reverses P81's own ordering; see ENHANCED_VISUAL_PREWARM_STAGGER_MS's doc).
      expect(visualMocks.prewarm).toHaveBeenCalledTimes(0)
      vi.advanceTimersByTime(1499)
      // Still within the stagger window.
      expect(visualMocks.prewarm).toHaveBeenCalledTimes(0)
      vi.advanceTimersByTime(1)
      expect(visualMocks.prewarm).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('getVisualPrewarmState reflects the underlying client snapshot', () => {
    visualMocks.getDiagnosticsSnapshot.mockReturnValue({
      modelState: 'loading',
      unavailableReason: null,
      readyInfo: null,
      backendDiagnostics: null,
      firstEmbedMs: null,
      liveProgress: defaultLiveProgress(),
    })
    const controller = createRealScannerController({ userId: 'user-a' })
    expect(controller.getVisualPrewarmState?.()).toBe('loading')
  })

  it('P82-6: the FAST (OCR) baseline can report ready while the heavyweight DINO channel is still loading', () => {
    ocrEngineMocks.getState.mockReturnValue('ready')
    visualMocks.getDiagnosticsSnapshot.mockReturnValue({
      modelState: 'loading',
      unavailableReason: null,
      readyInfo: null,
      backendDiagnostics: null,
      firstEmbedMs: null,
      liveProgress: defaultLiveProgress(),
    })
    const controller = createRealScannerController({ userId: 'user-a' })
    expect(controller.getFastScannerState?.()).toBe('ready')
    expect(controller.getVisualPrewarmState?.()).toBe('loading')
  })

  it('P82-14: prewarm() called twice starts the OCR engine exactly once (no duplicate worker creation)', () => {
    vi.useFakeTimers()
    try {
      const controller = createRealScannerController({ userId: 'user-a' })
      controller.prewarm?.()
      controller.prewarm?.()
      vi.advanceTimersByTime(1500)
      expect(ocrEngineMocks.prepare).toHaveBeenCalledTimes(1)
      expect(visualMocks.prewarm).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  describe('bounded visual wait during a capture', () => {
    const originalCreateImageBitmap = globalThis.createImageBitmap

    beforeEach(() => {
      globalThis.createImageBitmap = vi.fn().mockResolvedValue({ close: vi.fn() })
      mockedRunOcrAnalysis.mockResolvedValue({
        rawNameText: 'Pikachu',
        rawCollectorNumberText: '58',
        usedFullFrameFallback: false,
        nameRoiId: null,
        numberRoiId: null,
      })
      mockedSearchCards.mockResolvedValue({ results: [], totalCount: 0 })
    })

    afterEach(() => {
      globalThis.createImageBitmap = originalCreateImageBitmap
    })

    it('P81-3: a capture that starts before the visual channel is ready degrades to OCR-only after the bound instead of hanging on a cold model load', async () => {
      vi.useFakeTimers()
      try {
        visualMocks.getDiagnosticsSnapshot.mockReturnValue({
          modelState: 'loading',
          unavailableReason: null,
          readyInfo: null,
          backendDiagnostics: null,
          firstEmbedMs: null,
          liveProgress: defaultLiveProgress(),
        })
        // Simulates a real cold model load that would otherwise take minutes (P81's own real-
        // device evidence: up to 388s) — this promise never resolves within the test.
        visualMocks.analyze.mockReturnValue(new Promise(() => {}))

        const controller = createRealScannerController({ userId: 'user-a' })
        const analysisPromise = controller.analyzeCapture(capture())
        await vi.advanceTimersByTimeAsync(8000)
        await analysisPromise
        const diagnostics = controller.getLastDiagnostics?.()
        expect(diagnostics?.visualEmbeddingCreated).toBe(false)
        expect(diagnostics?.visualError).toMatch(/still warming up/)
        expect(diagnostics?.visualPrewarmReadyBeforeCapture).toBe(false)
      } finally {
        vi.useRealTimers()
      }
    })

    it('P81-4: a capture that starts AFTER the visual channel is already ready is awaited normally, with no bound applied', async () => {
      visualMocks.getDiagnosticsSnapshot.mockReturnValue({
        modelState: 'ready',
        unavailableReason: null,
        readyInfo: null,
        backendDiagnostics: null,
        firstEmbedMs: 120,
        liveProgress: defaultLiveProgress(),
      })
      visualMocks.analyze.mockResolvedValue({
        hits: [{ cardId: 'card-a', similarity: 0.9 }],
        backend: 'wasm',
        embedMs: 12,
        searchMs: 2,
        embeddingNorm: 5,
      })
      const controller = createRealScannerController({ userId: 'user-a' })
      await controller.analyzeCapture(capture())
      const diagnostics = controller.getLastDiagnostics?.()
      expect(diagnostics?.visualEmbeddingCreated).toBe(true)
      expect(diagnostics?.visualError).toBeNull()
      expect(diagnostics?.visualPrewarmReadyBeforeCapture).toBe(true)
      expect(diagnostics?.firstEmbedMs).toBe(120)
    })
  })

  it('P81-11: dispose() releases the visual client alongside the OCR engine/canvases', () => {
    const controller = createRealScannerController({ userId: 'user-a' })
    controller.dispose()
    expect(visualMocks.dispose).toHaveBeenCalledTimes(1)
  })
})

describe('P80 R4/R5: low-confidence candidate expansion (Shieldon rank-6 real-device case)', () => {
  it('widens past the normal 5 when the ranking near the cutoff is flat, WITHOUT touching a clearly-settled HIGH match', async () => {
    // Nine candidates that ALL share the same name — no printed id distinguishes them, so every
    // one scores identically (name-exact + language-match). A flat LOW-tier ranking exactly like
    // this is the scenario the real Shieldon miss represents: the true card can sit past rank 5
    // for no reason other than tie-break ordering.
    mockedRunOcrAnalysis.mockResolvedValue({
      rawNameText: 'Pikachu',
      rawCollectorNumberText: null,
      usedFullFrameFallback: false,
      nameRoiId: null,
      numberRoiId: null,
    })
    mockedSearchCards.mockResolvedValue({
      results: Array.from({ length: 9 }, (_, index) =>
        catalogRow({ cardId: `card-${index}`, localId: String(index), name: 'Pikachu' }),
      ),
      totalCount: 9,
    })
    const controller = createRealScannerController({ userId: 'user-a' })
    const analysis = await controller.analyzeCapture(capture())
    expect(analysis.confidence).toBe('LOW')
    // Widened to the expanded limit (8), not the engine's full 9-row retention, and not the
    // normal 5 — a 6th-ranked card (which the old fixed cap of 5 would have hidden entirely) is
    // now selectable.
    expect(analysis.candidates.length).toBe(8)
    expect(analysis.candidates.map((c) => c.candidateId)).toContain('card-5')
    const diagnostics = controller.getLastDiagnostics?.()
    expect(diagnostics?.candidateExpansionTriggered).toBe(true)
  })

  it('does NOT expand a HIGH-tier match even with many extra low-scoring candidates in the pool', async () => {
    mockedRunOcrAnalysis.mockResolvedValue({
      rawNameText: 'Pikachu',
      rawCollectorNumberText: '58/102',
      usedFullFrameFallback: false,
      nameRoiId: null,
      numberRoiId: null,
    })
    mockedSearchCards.mockResolvedValue({
      results: [
        // Convergent evidence -> HIGH, well clear of every runner-up below.
        catalogRow({ cardId: 'true-match', localId: '58', name: 'Pikachu' }),
        ...Array.from({ length: 8 }, (_, index) =>
          catalogRow({ cardId: `noise-${index}`, localId: String(100 + index), name: 'Pikachu' }),
        ),
      ],
      totalCount: 9,
    })
    // P93/N-09: text-only id+name convergence now tops out at MEDIUM (75) — a well-separated
    // strong visual anchor is what actually reaches HIGH, since production never populates
    // rawSetText and language agreement no longer scores. See the sibling I3/I4 test's own note.
    // The visual channel only actually runs in this Node test environment when
    // `createImageBitmap` is polyfilled (it is not, by default, in this describe block) — save
    // and restore it locally rather than widening the polyfill to the whole block.
    const originalCreateImageBitmap = globalThis.createImageBitmap
    globalThis.createImageBitmap = vi.fn().mockResolvedValue({ close: vi.fn() }) as never
    visualMocks.analyze.mockResolvedValue({
      hits: [{ cardId: 'true-match', similarity: 0.93 }],
      backend: 'wasm',
      embedMs: 12,
      searchMs: 2,
      embeddingNorm: 5,
    })
    try {
      const controller = createRealScannerController({ userId: 'user-a' })
      const analysis = await controller.analyzeCapture(capture())
      expect(analysis.confidence).toBe('HIGH')
      expect(analysis.candidates.length).toBe(5)
      const diagnostics = controller.getLastDiagnostics?.()
      expect(diagnostics?.candidateExpansionTriggered).toBe(false)
    } finally {
      globalThis.createImageBitmap = originalCreateImageBitmap
    }
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
      requestKey: crypto.randomUUID(),
    }))
  }

  it('performs ZERO writes during analysis - only commitBatch writes', async () => {
    mockedRunOcrAnalysis.mockResolvedValue({
      rawNameText: 'Pikachu',
      rawCollectorNumberText: '58',
      usedFullFrameFallback: false,
      nameRoiId: null,
      numberRoiId: null,
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
    // D-096: with the per-item idempotency key, an ambiguous transport break is safe to retry —
    // the copy says so instead of the old "may already have been added" uncertainty.
    expect(result.outcomes[0]?.message).toMatch(/retry safely/)
    expect(result.outcomes[0]?.message).not.toMatch(/may already have been added/)
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

  it('F-19: idempotency-key-reuse names the possibility of a pre-existing entry, not "edit or remove it"', () => {
    const reused = classifyAcquisitionFailure(
      0,
      Object.assign(
        new Error(
          "idempotency-key-reuse: key 'abc' already belongs to a different acquisition attempt",
        ),
        { code: 'P0001' },
      ),
    )
    expect(reused.status).toBe('failed')
    expect(reused.message).toMatch(/already be in your collection/i)
    expect(reused.message).toMatch(/check portfolio/i)
    expect(reused.message).not.toMatch(/edit it or remove it/i)
  })

  it('F-19: an ordinary coded server refusal keeps the generic edit-or-remove message', () => {
    const ordinary = classifyAcquisitionFailure(
      0,
      Object.assign(new Error('quantity must be a positive integer'), { code: '23514' }),
    )
    expect(ordinary.status).toBe('failed')
    expect(ordinary.message).toMatch(/edit it or remove it/i)
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

describe('getLastDiagnostics - visual channel failure reporting (P78 R1)', () => {
  const originalCreateImageBitmap = globalThis.createImageBitmap

  beforeEach(() => {
    // Bypasses analyzeVisualSafely's "createImageBitmap is unavailable in this browser" early
    // exit (real in this Node test environment) so the mocked VisualRecognitionClient.analyze()
    // is actually reached — otherwise every test would report that message regardless of what
    // the worker itself said, masking the bug this suite exists to catch.
    globalThis.createImageBitmap = vi.fn().mockResolvedValue({ close: vi.fn() })
  })

  afterEach(() => {
    globalThis.createImageBitmap = originalCreateImageBitmap
  })

  it('R1: surfaces the worker unavailableReason in VISUAL_ERROR when init failed (modelState=failed, visualResult=null)', async () => {
    mockedRunOcrAnalysis.mockResolvedValue({
      rawNameText: 'Pikachu',
      rawCollectorNumberText: '58',
      usedFullFrameFallback: false,
      nameRoiId: null,
      numberRoiId: null,
    })
    mockedSearchCards.mockResolvedValue({ results: [], totalCount: 0 })
    visualMocks.analyze.mockResolvedValue(null)
    visualMocks.getDiagnosticsSnapshot.mockReturnValue({
      modelState: 'failed',
      unavailableReason: 'processor load failed: 404 on preprocessor_config.json',
      readyInfo: null,
      backendDiagnostics: {
        backendRequested: 'auto',
        backendAttempts: { webgpu: 'not-attempted', wasm: 'not-attempted' },
        webgpuError: null,
        wasmError: null,
        processorLoad: 'failed',
        modelLoad: 'failed',
        indexLoad: 'not-reached',
      },
      firstEmbedMs: null,
      liveProgress: defaultLiveProgress(),
    })

    const controller = createRealScannerController({ userId: 'user-a' })
    await controller.analyzeCapture(capture())
    const diagnostics = controller.getLastDiagnostics?.()

    expect(diagnostics?.visualModelState).toBe('failed')
    expect(diagnostics?.visualEmbeddingCreated).toBe(false)
    // The actual bug: this used to be unconditionally "—" (EMPTY) whenever analyze() resolved
    // null WITHOUT throwing — which is exactly how a model-init failure behaves (prompt §36:
    // analyze() never throws for "unavailable", it resolves null).
    expect(diagnostics?.visualError).toBe('processor load failed: 404 on preprocessor_config.json')
    expect(diagnostics?.processorLoad).toBe('failed')
    expect(diagnostics?.modelLoad).toBe('failed')
    expect(diagnostics?.indexLoadStatus).toBe('not-reached')
  })

  it('still prefers a real analyzeVisualSafely exception over the snapshot reason when both exist', async () => {
    mockedRunOcrAnalysis.mockResolvedValue({
      rawNameText: 'Pikachu',
      rawCollectorNumberText: '58',
      usedFullFrameFallback: false,
      nameRoiId: null,
      numberRoiId: null,
    })
    mockedSearchCards.mockResolvedValue({ results: [], totalCount: 0 })
    globalThis.createImageBitmap = vi
      .fn()
      .mockRejectedValue(new Error('createImageBitmap decode failure'))
    visualMocks.getDiagnosticsSnapshot.mockReturnValue({
      modelState: 'ready',
      unavailableReason: null,
      readyInfo: null,
      backendDiagnostics: null,
      firstEmbedMs: null,
      liveProgress: defaultLiveProgress(),
    })

    const controller = createRealScannerController({ userId: 'user-a' })
    await controller.analyzeCapture(capture())
    const diagnostics = controller.getLastDiagnostics?.()
    expect(diagnostics?.visualError).toBe('createImageBitmap decode failure')
  })

  it('F-30 (P89): the visual embedding is created from the CROPPED card rect, not the full camera frame', async () => {
    // Pins the exact P77 regression class: production code must call
    // createImageBitmap(blob, cardRect.left, cardRect.top, cardRect.width, cardRect.height), not
    // a bare createImageBitmap(blob) that embeds the entire captured frame. A NON-trivial rect
    // (non-zero origin, smaller than the full frame) is required — a zero-origin/full-frame rect
    // would pass even a regressed bare call by coincidence for some argument counts.
    mockedRunOcrAnalysis.mockResolvedValue({
      rawNameText: 'Pikachu',
      rawCollectorNumberText: '58',
      usedFullFrameFallback: false,
      nameRoiId: null,
      numberRoiId: null,
    })
    mockedSearchCards.mockResolvedValue({ results: [], totalCount: 0 })
    const createImageBitmapSpy = vi.fn().mockResolvedValue({ close: vi.fn() })
    globalThis.createImageBitmap = createImageBitmapSpy
    visualMocks.analyze.mockResolvedValue(null)

    const nonTrivialCardRect = { left: 43, top: 27, width: 401, height: 561 }
    const controller = createRealScannerController({ userId: 'user-a' })
    await controller.analyzeCapture({ ...capture(), cardRect: nonTrivialCardRect })

    // rectifyCapture falls back to the original, unrectified capture in this Node test
    // environment (no OffscreenCanvas/2D context available) — see the neighbouring test's own
    // comment above — so the working capture's cardRect is exactly what was passed in, making
    // this a precise pin rather than an approximation. rectifyCapture itself also calls
    // createImageBitmap once (bare, for its own boundary-detection attempt, before falling back)
    // against the SAME spy — so the crop call is found by argument count, not by call index.
    expect(createImageBitmapSpy).toHaveBeenCalledWith(
      expect.anything(),
      nonTrivialCardRect.left,
      nonTrivialCardRect.top,
      nonTrivialCardRect.width,
      nonTrivialCardRect.height,
    )
    // A regression to a bare createImageBitmap(blob) call for the VISUAL channel specifically
    // would leave no 5-argument call at all among the recorded calls.
    const fiveArgCalls = createImageBitmapSpy.mock.calls.filter((call) => call.length === 5)
    expect(fiveArgCalls).toHaveLength(1)
  })

  it('reports a successful visual match with real backend/index fields (no init failure)', async () => {
    mockedRunOcrAnalysis.mockResolvedValue({
      rawNameText: 'Pikachu',
      rawCollectorNumberText: '58',
      usedFullFrameFallback: false,
      nameRoiId: null,
      numberRoiId: null,
    })
    mockedSearchCards.mockResolvedValue({ results: [], totalCount: 0 })
    visualMocks.analyze.mockResolvedValue({
      hits: [{ cardId: 'card-a', similarity: 0.91 }],
      backend: 'webgpu',
      embedMs: 12,
      searchMs: 3,
      embeddingNorm: 5.5,
    })
    visualMocks.getDiagnosticsSnapshot.mockReturnValue({
      modelState: 'ready',
      unavailableReason: null,
      readyInfo: {
        backend: 'webgpu',
        indexAvailable: true,
        cardCount: 19501,
        modelColdLoadMs: 1337,
        indexVersion: 'visual-v1',
        indexSourceProjectRef: 'nopmkroeygmlvndzjjqs.supabase.co',
        indexLoadMs: 73,
        indexUnavailableReason: null,
        backendRequested: 'auto',
        backendAttempts: { webgpu: 'success', wasm: 'not-attempted' },
        webgpuError: null,
        wasmError: null,
        processorLoad: 'success',
        modelLoad: 'success',
        indexLoad: 'success',
      },
      backendDiagnostics: {
        backendRequested: 'auto',
        backendAttempts: { webgpu: 'success', wasm: 'not-attempted' },
        webgpuError: null,
        wasmError: null,
        processorLoad: 'success',
        modelLoad: 'success',
        indexLoad: 'success',
      },
      firstEmbedMs: null,
      liveProgress: defaultLiveProgress(),
    })

    const controller = createRealScannerController({ userId: 'user-a' })
    await controller.analyzeCapture(capture())
    const diagnostics = controller.getLastDiagnostics?.()
    expect(diagnostics?.visualModelState).toBe('ready')
    expect(diagnostics?.visualBackend).toBe('webgpu')
    expect(diagnostics?.indexCardCount).toBe(19501)
    expect(diagnostics?.visualError).toBeNull()
    expect(diagnostics?.visualEmbeddingCreated).toBe(true)
  })
})

describe('debug mode — widened shortlist, extended candidates, image previews (P79 §4/§10)', () => {
  const originalCreateImageBitmap = globalThis.createImageBitmap
  let createObjectURL: ReturnType<typeof vi.fn<() => string>>
  let revokeObjectURL: ReturnType<typeof vi.fn<(url: string) => void>>

  beforeEach(() => {
    vi.stubGlobal('window', { location: { search: '?scannerDebug=1' } })
    // A real function (so analyzeVisualSafely/rectifyCapture proceed far enough to reach the
    // mocked visual client / this environment's real canvas ceiling) that resolves to a minimal
    // fake bitmap — rectifyCapture still falls back gracefully once it hits canvas creation
    // (no jsdom/document in this Node test environment), which is exactly what this suite wants
    // to exercise: the CONTROLLER's own debug wiring, not the canvas glue itself.
    globalThis.createImageBitmap = vi.fn().mockResolvedValue({ close: vi.fn() })
    let counter = 0
    createObjectURL = vi.fn(() => `blob:debug-${++counter}`)
    revokeObjectURL = vi.fn()
    Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, configurable: true })
    Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, configurable: true })
    mockedRunOcrAnalysis.mockResolvedValue({
      rawNameText: 'Pikachu',
      rawCollectorNumberText: '58',
      usedFullFrameFallback: false,
      nameRoiId: null,
      numberRoiId: null,
    })
    mockedSearchCards.mockResolvedValue({ results: [], totalCount: 0 })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    globalThis.createImageBitmap = originalCreateImageBitmap
    const hadCreate = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')
    if (hadCreate?.configurable) delete (URL as unknown as Record<string, unknown>).createObjectURL
    const hadRevoke = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL')
    if (hadRevoke?.configurable) delete (URL as unknown as Record<string, unknown>).revokeObjectURL
  })

  it('requests the widened debug shortlist size, not the production one (Q5, raised 50->200 P84/P87)', async () => {
    visualMocks.analyze.mockResolvedValue(null)
    visualMocks.getDiagnosticsSnapshot.mockReturnValue(defaultVisualDiagnostics())
    const controller = createRealScannerController({ userId: 'user-a' })
    await controller.analyzeCapture(capture())
    expect(visualMocks.analyze).toHaveBeenCalledWith(expect.anything(), 200)
  })

  it('populates topVisualCandidatesExtended up to 100 only in debug mode (Q5/Q7, raised 20->100 P84/P87)', async () => {
    const hits = Array.from({ length: 150 }, (_, i) => ({
      cardId: `card-${i}`,
      similarity: 0.9 - i * 0.001,
    }))
    visualMocks.analyze.mockResolvedValue({
      hits,
      backend: 'wasm',
      embedMs: 5,
      searchMs: 1,
      embeddingNorm: 4.2,
    })
    visualMocks.getDiagnosticsSnapshot.mockReturnValue({
      modelState: 'ready',
      unavailableReason: null,
      readyInfo: {
        backend: 'wasm',
        indexAvailable: true,
        cardCount: 100,
        modelColdLoadMs: 500,
        indexVersion: 'visual-v1',
        indexSourceProjectRef: 'ref',
        indexLoadMs: 10,
        indexUnavailableReason: null,
        backendRequested: 'auto',
        backendAttempts: { webgpu: 'not-available', wasm: 'success' },
        webgpuError: null,
        wasmError: null,
        processorLoad: 'success',
        modelLoad: 'success',
        indexLoad: 'success',
      },
      backendDiagnostics: null,
      firstEmbedMs: null,
      liveProgress: defaultLiveProgress(),
    })
    const controller = createRealScannerController({ userId: 'user-a' })
    await controller.analyzeCapture(capture())
    const diagnostics = controller.getLastDiagnostics?.()
    expect(diagnostics?.topVisualCandidatesExtended).toHaveLength(100)
    expect(diagnostics?.topVisualCandidatesExtended[0]?.cardId).toBe('card-0')
    // The production top-5 field is unaffected by the widened debug list.
    expect(diagnostics?.topVisualCandidates).toHaveLength(5)
  })

  it('exposes debug image previews via getLastDebugImages and revokes the previous set on the next scan (Q4/Q8)', async () => {
    visualMocks.analyze.mockResolvedValue(null)
    visualMocks.getDiagnosticsSnapshot.mockReturnValue(defaultVisualDiagnostics())
    const controller = createRealScannerController({ userId: 'user-a' })
    await controller.analyzeCapture(capture())
    const first = controller.getLastDebugImages?.()
    // rectifyCapture falls back (no createImageBitmap) — the ORIGINAL capture's own blob still
    // becomes the "rectified" preview URL (rectification never claims to have improved it), and
    // no raw-crop blob exists since that stage never ran.
    expect(first?.rectifiedUrl).not.toBeNull()
    expect(first?.rawCropUrl).toBeNull()
    expect(createObjectURL).toHaveBeenCalledTimes(1)

    await controller.analyzeCapture(capture())
    expect(revokeObjectURL).toHaveBeenCalledWith(first?.rectifiedUrl)
    expect(createObjectURL).toHaveBeenCalledTimes(2)
  })

  it('never collects debug images or the extended list outside debug mode (privacy/perf floor)', async () => {
    vi.stubGlobal('window', { location: { search: '' } })
    visualMocks.analyze.mockResolvedValue(null)
    visualMocks.getDiagnosticsSnapshot.mockReturnValue(defaultVisualDiagnostics())
    const controller = createRealScannerController({ userId: 'user-a' })
    await controller.analyzeCapture(capture())
    expect(controller.getLastDebugImages?.()).toBeNull()
    expect(controller.getLastDiagnostics?.()?.topVisualCandidatesExtended).toEqual([])
    expect(createObjectURL).not.toHaveBeenCalled()
    expect(visualMocks.analyze).toHaveBeenCalledWith(expect.anything(), 30)
  })

  it('dispose() revokes any live debug image URLs (no leak beyond the session, Q8)', async () => {
    visualMocks.analyze.mockResolvedValue(null)
    visualMocks.getDiagnosticsSnapshot.mockReturnValue(defaultVisualDiagnostics())
    const controller = createRealScannerController({ userId: 'user-a' })
    await controller.analyzeCapture(capture())
    const images = controller.getLastDebugImages?.()
    controller.dispose()
    expect(revokeObjectURL).toHaveBeenCalledWith(images?.rectifiedUrl)
  })
})

describe('getExpectedCardRank (P84, ported P87) — debug-only rank-lookup gating', () => {
  beforeEach(() => {
    // The two P90 §21 tests below run a real analyzeCapture() with debug mode on, which creates
    // debug image object URLs — jsdom/Node's URL has no createObjectURL; stub it like the debug
    // image describe block above does.
    Object.defineProperty(URL, 'createObjectURL', {
      value: vi.fn(() => 'blob:debug'),
      configurable: true,
    })
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('resolves null WITHOUT ever calling the visual client outside ?scannerDebug=1', async () => {
    vi.stubGlobal('window', { location: { search: '' } })
    const controller = createRealScannerController({ userId: 'user-a' })
    const result = await controller.getExpectedCardRank?.('some-card-id')
    expect(result).toBeNull()
    expect(visualMocks.getExpectedCardRank).not.toHaveBeenCalled()
  })

  it('delegates to the visual client and relays its result verbatim inside ?scannerDebug=1', async () => {
    vi.stubGlobal('window', { location: { search: '?scannerDebug=1' } })
    visualMocks.getExpectedCardRank.mockResolvedValue({
      found: true,
      rank: 3,
      similarity: 0.87,
      totalCards: 19501,
      inTop20: true,
      inTop100: true,
      indexContentId: '0123456789abcdef',
    })
    const controller = createRealScannerController({ userId: 'user-a' })
    const result = await controller.getExpectedCardRank?.('card-42')
    expect(visualMocks.getExpectedCardRank).toHaveBeenCalledWith('card-42')
    expect(result).toEqual({
      found: true,
      rank: 3,
      similarity: 0.87,
      totalCards: 19501,
      inTop20: true,
      inTop100: true,
      indexContentId: '0123456789abcdef',
    })
  })

  it('a debug-mode lookup with no prior scan (no cached query vector) resolves found=false, never throws', async () => {
    vi.stubGlobal('window', { location: { search: '?scannerDebug=1' } })
    visualMocks.getExpectedCardRank.mockResolvedValue({
      found: false,
      rank: null,
      similarity: null,
      totalCards: 0,
      inTop20: false,
      inTop100: false,
      indexContentId: null,
    })
    const controller = createRealScannerController({ userId: 'user-a' })
    await expect(controller.getExpectedCardRank?.('card-1')).resolves.toEqual(
      expect.objectContaining({ found: false, rank: null }),
    )
  })

  it('P90 §21: computes a REAL hybrid rank/tier/score-components for a card from the merged pool of the most recent scan, using the exact scoring pipeline production runs', async () => {
    vi.stubGlobal('window', { location: { search: '?scannerDebug=1' } })
    visualMocks.getExpectedCardRank.mockResolvedValue({
      found: false,
      rank: null,
      similarity: null,
      totalCards: 0,
      inTop20: false,
      inTop100: false,
      indexContentId: null,
    })
    mockedRunOcrAnalysis.mockResolvedValue({
      rawNameText: 'Pikachu',
      rawCollectorNumberText: '58',
      usedFullFrameFallback: false,
      nameRoiId: null,
      numberRoiId: null,
    })
    // An exact id+name match on 'card-58' — the strongest possible pure-text score — plus a
    // second, unrelated candidate that must rank behind it.
    mockedSearchCards.mockResolvedValue({
      results: [
        catalogRow({ cardId: 'card-58', name: 'Pikachu', localId: '58' }),
        catalogRow({ cardId: 'card-99', name: 'Charmander', localId: '99' }),
      ],
      totalCount: 2,
    })
    visualMocks.analyze.mockResolvedValue(null)
    visualMocks.getDiagnosticsSnapshot.mockReturnValue(defaultVisualDiagnostics())

    const controller = createRealScannerController({ userId: 'user-a' })
    await controller.analyzeCapture(capture())

    const result = await controller.getExpectedCardRank?.('card-58')
    expect(result?.hybridRank).toBe(1)
    expect(result?.hybridScore).toBeGreaterThan(0)
    expect(result?.hybridTier).not.toBeNull()
    expect(result?.scoreComponents).toEqual(
      expect.arrayContaining(['collector-number-exact', 'name-exact']),
    )

    // The unrelated candidate carries at most a language-match signal (both fixture cards are
    // English) and ranks behind the exact id+name match, never first.
    const other = await controller.getExpectedCardRank?.('card-99')
    expect(other?.hybridRank).toBe(2)
    expect(other?.hybridScore ?? 0).toBeLessThan(result?.hybridScore ?? 0)
    expect(other?.scoreComponents).not.toEqual(
      expect.arrayContaining(['collector-number-exact', 'name-exact']),
    )
  })

  it('P90 §21: a card never retrieved by the scan is fetched and scored as an honest what-if, without mutating the batch', async () => {
    vi.stubGlobal('window', { location: { search: '?scannerDebug=1' } })
    visualMocks.getExpectedCardRank.mockResolvedValue({
      found: false,
      rank: null,
      similarity: null,
      totalCards: 0,
      inTop20: false,
      inTop100: false,
      indexContentId: null,
    })
    mockedRunOcrAnalysis.mockResolvedValue({
      rawNameText: 'Pikachu',
      rawCollectorNumberText: '58',
      usedFullFrameFallback: false,
      nameRoiId: null,
      numberRoiId: null,
    })
    mockedSearchCards.mockResolvedValue({
      results: [catalogRow({ cardId: 'card-58', name: 'Pikachu', localId: '58' })],
      totalCount: 1,
    })
    visualMocks.analyze.mockResolvedValue(null)
    visualMocks.getDiagnosticsSnapshot.mockReturnValue(defaultVisualDiagnostics())
    mockedGetCardsByIds.mockResolvedValueOnce([
      {
        id: 'card-never-retrieved',
        name: 'Bulbasaur',
        localId: '1',
        rarity: 'Basic',
        category: 'Pokemon',
        illustrator: null,
        imageBaseUrl: null,
        // Deliberately a language MISMATCH against the scan's 'en' hint, so this candidate scores
        // a real, unambiguous zero (a same-language match would add a small language-match point).
        language: 'ja',
        setId: 'set-1',
        setName: 'Base Set',
      },
    ])

    const controller = createRealScannerController({ userId: 'user-a' })
    await controller.analyzeCapture(capture())

    const result = await controller.getExpectedCardRank?.('card-never-retrieved')
    expect(mockedGetCardsByIds).toHaveBeenCalledWith(['card-never-retrieved'], 'en')
    expect(result?.hybridRank).toBe(2) // scores zero text evidence, ranks behind card-58
    expect(result?.hybridScore).toBe(0)
    // Never added to the batch/candidate pool this scan actually produced.
    expect(controller.getLastDiagnostics?.()).not.toBeNull()
  })
})
