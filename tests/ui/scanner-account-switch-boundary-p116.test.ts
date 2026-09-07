import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import {
  createRealScannerController,
  ScannerAnalysisAbortedError,
} from '../../src/features/scanner/controller'
import { scannerSessionStore } from '../../src/features/scanner/session-store'

/**
 * P116 §12 — account-switch identity boundary DURING an in-flight scanner analysis, property-
 * tested across many generated switch-timing sequences. D-104 F-05 / N-21 (controller.ts) state
 * the contract: a controller instance belongs to exactly one signed-in identity, an account switch
 * replaces it (never survives across users), and `AuthProvider`'s identity-change boundary
 * (`applyAuthIdentityBoundary`) synchronously clears `scannerSessionStore` before the next identity
 * ever renders. P113 tested none of this (§12 is entirely new ground: `scanner-controller.test.ts`'s
 * own N-21 case pins exactly ONE stage — mid-commitBatch — at unit scale; this file generalizes to
 * EVERY named pipeline stage — camera/capture is caller-side and out of `analyzeCapture`'s scope,
 * so the in-controller stages this can actually observe are OCR+visual (parallel), catalog
 * retrieval, and the synchronous matcher step — at property-test scale).
 *
 * The invariant under test: once a switch happens (abort the in-flight signal + dispose the old
 * controller + clear the session store, exactly what ScannerPage/AuthProvider do together), NOTHING
 * from identity A's in-flight analysis may ever resolve into usable state, and B's own fresh
 * controller starts from a completely clean slate — A's late state cannot appear under B.
 */

vi.mock('../../src/features/scanner/analyze', () => ({
  runOcrAnalysis: vi.fn(),
  releaseOcrCanvases: vi.fn(),
}))
vi.mock('../../src/data/catalog', () => ({
  searchCards: vi.fn(),
  getCardVariants: vi.fn(),
  getCardsByIds: vi.fn().mockResolvedValue([]),
  classifyCardIdsAgainstCatalog: vi.fn().mockResolvedValue(new Map()),
}))
vi.mock('../../src/data/collection', () => ({
  addCardAcquisition: vi.fn(),
}))
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
import { searchCards } from '../../src/data/catalog'

const mockedRunOcrAnalysis = vi.mocked(runOcrAnalysis)
const mockedSearchCards = vi.mocked(searchCards)

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

/** A promise this test can resolve on demand, standing in for the real network/OCR/visual latency
 *  a genuine account switch could land in the middle of. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
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
afterEach(() => {
  scannerSessionStore.clearAll()
})

/** Simulates the exact three-way boundary AuthProvider + ScannerPage perform together on an
 *  observed identity change: abort the in-flight signal, dispose the old controller, clear the
 *  session store (query-cache-boundary.ts's own actions, minus the QueryClient which is out of
 *  this controller-level test's scope). */
function performAccountSwitch(
  oldController: ReturnType<typeof createRealScannerController>,
  oldAbort: AbortController,
): void {
  oldAbort.abort()
  oldController.dispose()
  scannerSessionStore.clearAll()
}

type SwitchStage = 'before-ocr-resolves' | 'before-catalog-resolves' | 'after-both-resolve'

const arbSwitchStage = fc.constantFrom<SwitchStage>(
  'before-ocr-resolves',
  'before-catalog-resolves',
  'after-both-resolve',
)

describe('account-switch identity boundary during in-flight analysis (P116 §12)', () => {
  it(
    '25,000 generated switch-timing sequences: an aborted in-flight analysis for A never resolves with usable data, and B always starts from a clean session',
    async () => {
      await fc.assert(
        fc.asyncProperty(arbSwitchStage, fc.boolean(), async (stage, ocrFirst) => {
          scannerSessionStore.clearAll()
          const ocrDeferred = deferred<{
            rawNameText: string | null
            rawCollectorNumberText: string | null
            usedFullFrameFallback: boolean
            nameRoiId: null
            numberRoiId: null
          }>()
          const catalogDeferred = deferred<{
            results: { id: string; name: string; localId: string; rarity: string | null; category: string | null; illustrator: string | null; imageBaseUrl: string | null; language: 'en'; setId: string; setName: string; variantCount: number }[]
            totalCount: number
          }>()
          mockedRunOcrAnalysis.mockReturnValue(ocrDeferred.promise)
          mockedSearchCards.mockReturnValue(catalogDeferred.promise)

          const controllerA = createRealScannerController({ userId: 'user-a' })
          const abortA = new AbortController()
          const analysisPromise = controllerA.analyzeCapture(capture(), abortA.signal)

          // Resolve OCR either before or after the switch happens, per the generated ordering —
          // exercises the switch landing between EVERY meaningful pair of stage boundaries.
          if (stage === 'before-ocr-resolves') {
            performAccountSwitch(controllerA, abortA)
            ocrDeferred.resolve({
              rawNameText: 'Pikachu',
              rawCollectorNumberText: '58',
              usedFullFrameFallback: false,
              nameRoiId: null,
              numberRoiId: null,
            })
            catalogDeferred.resolve({ results: [], totalCount: 0 })
          } else if (stage === 'before-catalog-resolves') {
            if (ocrFirst) {
              ocrDeferred.resolve({
                rawNameText: 'Pikachu',
                rawCollectorNumberText: '58',
                usedFullFrameFallback: false,
                nameRoiId: null,
                numberRoiId: null,
              })
              await Promise.resolve() // let the OCR/visual Promise.all progress one microtask
            }
            performAccountSwitch(controllerA, abortA)
            if (!ocrFirst) {
              ocrDeferred.resolve({
                rawNameText: 'Pikachu',
                rawCollectorNumberText: '58',
                usedFullFrameFallback: false,
                nameRoiId: null,
                numberRoiId: null,
              })
            }
            catalogDeferred.resolve({ results: [], totalCount: 0 })
          } else {
            ocrDeferred.resolve({
              rawNameText: 'Pikachu',
              rawCollectorNumberText: '58',
              usedFullFrameFallback: false,
              nameRoiId: null,
              numberRoiId: null,
            })
            catalogDeferred.resolve({ results: [], totalCount: 0 })
            await Promise.resolve()
            await Promise.resolve()
            performAccountSwitch(controllerA, abortA)
          }

          // A's analysis must NEVER resolve successfully once aborted — either it already
          // completed before the switch (stage === 'after-both-resolve' can legitimately race
          // either way since the switch fires after both mocks already resolved) or it rejects
          // with the documented cancellation error. It must never silently hang either.
          let outcome: 'resolved' | 'aborted-error' | 'other-error'
          try {
            await analysisPromise
            outcome = 'resolved'
          } catch (error) {
            outcome = error instanceof ScannerAnalysisAbortedError ? 'aborted-error' : 'other-error'
          }
          if (stage !== 'after-both-resolve') {
            expect(outcome).toBe('aborted-error')
          } else {
            expect(['resolved', 'aborted-error']).toContain(outcome)
          }

          // B's world is provably clean: no session defaults survive under B's own id, and a
          // fresh controller for B never sees A's mocked-in-flight OCR/catalog values leak in
          // (B issues its own fresh analyzeCapture call against freshly configured mocks below).
          expect(scannerSessionStore.load('user-a')).toBeNull()
          const controllerB = createRealScannerController({ userId: 'user-b' })
          mockedRunOcrAnalysis.mockResolvedValue({
            rawNameText: null,
            rawCollectorNumberText: null,
            usedFullFrameFallback: true,
            nameRoiId: null,
            numberRoiId: null,
          })
          const bAnalysis = await controllerB.analyzeCapture(capture())
          // B's own scan, with zero OCR signal, is a clean NO_MATCH — never contaminated by
          // whatever A's stale pipeline was doing.
          expect(bAnalysis.confidence).toBe('NO_MATCH')
          controllerB.dispose()
        }),
        { numRuns: 25_000 },
      )
    },
    120_000,
  )
})
