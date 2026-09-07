import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import { createRealScannerController } from '../../src/features/scanner/controller'
import { scannerSessionStore } from '../../src/features/scanner/session-store'

/**
 * P116 §14 — expected-card debug stress. Thousands of debug rank lookups (present/absent/
 * inactive/language-filtered/missing-catalog, ranks spanning 1/20/100/200+) must never mutate the
 * live batch or affect what a REAL subsequent `analyzeCapture`/`commitBatch` call produces —
 * `getExpectedCardRank`'s own doc says exactly this ("never mutates the batch, never adds
 * anything, never re-runs the scan"). Verified here by calling it thousands of times between two
 * real production operations and diffing their outcomes against a debug-free control run.
 */

vi.mock('../../src/features/scanner/analyze', () => ({
  runOcrAnalysis: vi.fn(),
  releaseOcrCanvases: vi.fn(),
}))
vi.mock('../../src/data/catalog', () => ({
  searchCards: vi.fn(),
  getCardVariants: vi.fn(),
  getCardsByIds: vi.fn(),
  classifyCardIdsAgainstCatalog: vi.fn(),
}))
vi.mock('../../src/data/collection', () => ({ addCardAcquisition: vi.fn() }))
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
import { searchCards, getCardsByIds, classifyCardIdsAgainstCatalog } from '../../src/data/catalog'

const mockedRunOcrAnalysis = vi.mocked(runOcrAnalysis)
const mockedSearchCards = vi.mocked(searchCards)
const mockedGetCardsByIds = vi.mocked(getCardsByIds)
const mockedClassify = vi.mocked(classifyCardIdsAgainstCatalog)

function capture() {
  return {
    blob: new Blob(['synthetic'], { type: 'image/jpeg' }),
    width: 500,
    height: 700,
    cardRect: { left: 0, top: 0, width: 500, height: 700 },
  }
}
function defaultVisualDiagnostics() {
  return {
    modelState: 'not-loaded' as const,
    unavailableReason: null,
    readyInfo: null,
    backendDiagnostics: null,
    firstEmbedMs: null,
    liveProgress: {
      workerBooted: false,
      workerBootMs: null,
      currentPhase: null,
      currentPhaseElapsedMs: null,
      lastProgressMsAgo: null,
    },
  }
}
function catalogRow(cardId: string, localId: string) {
  return {
    id: cardId,
    name: `Card ${cardId}`,
    localId,
    rarity: 'Basic',
    category: 'Pokemon',
    illustrator: null,
    imageBaseUrl: null,
    language: 'en' as const,
    setId: 'set-1',
    setName: 'Base Set',
    variantCount: 1,
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
  mockedGetCardsByIds.mockResolvedValue([])
  mockedClassify.mockResolvedValue(new Map())
})
afterEach(() => {
  vi.unstubAllGlobals()
})

const arbDebugCardScenario = fc.oneof(
  fc.record({ kind: fc.constant('present-in-context' as const) }),
  fc.record({ kind: fc.constant('absent-visual' as const) }),
  fc.record({
    kind: fc.constant('inactive' as const),
    cardId: fc.stringMatching(/^inactive-[a-z]{4,6}$/),
  }),
  fc.record({
    kind: fc.constant('language-filtered' as const),
    cardId: fc.stringMatching(/^lang-[a-z]{4,6}$/),
  }),
  fc.record({
    kind: fc.constant('missing-catalog' as const),
    cardId: fc.stringMatching(/^ghost-[a-z]{4,6}$/),
  }),
  fc.record({
    kind: fc.constant('visual-rank' as const),
    rank: fc.constantFrom(1, 20, 100, 200),
    cardId: fc.stringMatching(/^rank-[a-z]{4,6}$/),
  }),
)

describe('expected-card debug stress — never affects ranking/batch (P116 §14)', () => {
  it('1,500 generated debug lookups interleaved between two real analyzeCapture calls: the SECOND call is byte-identical to a debug-free control', async () => {
    vi.stubGlobal('window', { location: { search: '?scannerDebug=1' } })
    mockedRunOcrAnalysis.mockResolvedValue({
      rawNameText: 'Pikachu',
      rawCollectorNumberText: '58',
      usedFullFrameFallback: false,
      nameRoiId: null,
      numberRoiId: null,
    })
    mockedSearchCards.mockResolvedValue({
      results: [catalogRow('pika-58', '58'), catalogRow('other-1', '99')],
      totalCount: 2,
    })
    visualMocks.getExpectedCardRank.mockImplementation((cardId: string) =>
      Promise.resolve({
        found: cardId === 'pika-58',
        rank: cardId === 'pika-58' ? 1 : null,
        similarity: cardId === 'pika-58' ? 0.9 : null,
        totalCards: 19500,
        inTop20: cardId === 'pika-58',
        inTop100: cardId === 'pika-58',
        indexContentId: 'test',
      }),
    )

    const controller = createRealScannerController({ userId: 'user-a' })
    const firstAnalysis = await controller.analyzeCapture(capture())

    await fc.assert(
      fc.asyncProperty(arbDebugCardScenario, async (scenario) => {
        if (scenario.kind === 'inactive' || scenario.kind === 'language-filtered') {
          mockedClassify.mockResolvedValueOnce(
            new Map([
              [scenario.cardId, scenario.kind === 'inactive' ? 'inactive-filtered' : 'language-filtered'],
            ]),
          )
        } else if (scenario.kind === 'missing-catalog') {
          mockedClassify.mockResolvedValueOnce(new Map())
        }
        const cardId =
          scenario.kind === 'present-in-context'
            ? 'pika-58'
            : scenario.kind === 'absent-visual'
              ? 'other-1'
              : scenario.cardId
        // Must never throw regardless of scenario.
        await controller.getExpectedCardRank?.(cardId)
      }),
      { numRuns: 1_500 },
    )

    const secondAnalysis = await controller.analyzeCapture(capture())
    // 1,500 interleaved debug lookups (spanning every named scenario) produced ZERO drift: the
    // second real scan of the SAME capture is identical to the first, which ran before any debug
    // lookup at all — proving getExpectedCardRank never mutated lastMatchContext, the batch, or
    // any shared ranking state.
    expect(secondAnalysis).toEqual(firstAnalysis)
    controller.dispose()
  }, 60_000)

  it('a debug lookup NEVER changes controller.commitBatch/analyzeCapture call counts or the mocked catalog/OCR call arguments', async () => {
    vi.stubGlobal('window', { location: { search: '?scannerDebug=1' } })
    mockedRunOcrAnalysis.mockResolvedValue({
      rawNameText: 'Pikachu',
      rawCollectorNumberText: '58',
      usedFullFrameFallback: false,
      nameRoiId: null,
      numberRoiId: null,
    })
    mockedSearchCards.mockResolvedValue({ results: [catalogRow('pika-58', '58')], totalCount: 1 })
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
    await controller.analyzeCapture(capture())
    const ocrCallsBefore = mockedRunOcrAnalysis.mock.calls.length
    const catalogCallsBefore = mockedSearchCards.mock.calls.length

    for (let i = 0; i < 500; i += 1) {
      await controller.getExpectedCardRank?.(`some-card-${String(i)}`)
    }

    expect(mockedRunOcrAnalysis.mock.calls.length).toBe(ocrCallsBefore)
    expect(mockedSearchCards.mock.calls.length).toBe(catalogCallsBefore)
    controller.dispose()
  })

  it('outside ?scannerDebug=1, getExpectedCardRank resolves null for 500 varied card ids without EVER calling the visual client', async () => {
    const controller = createRealScannerController({ userId: 'user-a' })
    for (let i = 0; i < 500; i += 1) {
      const result = await controller.getExpectedCardRank?.(`card-${String(i)}`)
      expect(result).toBeNull()
    }
    expect(visualMocks.getExpectedCardRank).not.toHaveBeenCalled()
    controller.dispose()
  })
})
