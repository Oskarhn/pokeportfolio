import { beforeEach, describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import {
  createRealScannerController,
  ScannerAnalysisAbortedError,
} from '../../src/features/scanner/controller'
import { scannerSessionStore } from '../../src/features/scanner/session-store'

/**
 * P116 §3 — analysis A/B/C race matrix. P113 did zero new analysis races (prompt's own framing).
 *
 * Mirrors the REAL production staleness mechanism exactly: `ScannerPage.tsx`'s `handleUsePhoto`
 * (F-05/P89) pins one `AbortController` per `analyzeCapture` call and bumps `analysisGenerationRef`
 * on every retake/route-exit/unmount/account-switch/new-capture; a settling promise whose
 * generation no longer matches is a documented no-op. `analyzeCapture` itself (controller.ts) checks
 * `signal?.aborted` at three real pipeline checkpoints — after rectify, after the OCR+visual
 * `Promise.all`, after catalog retrieval — throwing `ScannerAnalysisAbortedError`. This file drives
 * the REAL `createRealScannerController`/`analyzeCapture` through THREE overlapping "captures" (A
 * starts, B replaces A, C replaces B — a rapid retake-retake-retake or scan-next-scan-next burst),
 * resolving each capture's OCR/catalog mocks at every meaningful relative ordering, and proves: a
 * replaced (aborted) generation's result NEVER reaches the generation-guarded "current" slot a
 * ScannerPage-shaped caller would apply it to, and exactly one (the winning, unaborted) generation's
 * result — success OR error OR the implicit "still pending" — is ever treated as current.
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
function ocrResult(name: string) {
  return {
    rawNameText: name,
    rawCollectorNumberText: '1',
    usedFullFrameFallback: false,
    nameRoiId: null,
    numberRoiId: null,
  }
}
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

/** One in-flight "capture" (A, B, or C): its own deferred OCR/catalog mocks, its own
 *  AbortController, and an `applied` promise mirroring EXACTLY what `ScannerPage.tsx`'s
 *  `handleUsePhoto` does with the real result — `analyzeCapture`'s own abort check is only
 *  best-effort (it can legitimately finish before an abort() call that arrives after its last
 *  checkpoint); the REAL, guaranteed staleness protection is the caller's generation-ref
 *  comparison at settle time (F-05/P89: "if THIS call's generation no longer matches when the
 *  promise settles... a guaranteed no-op instead of clobbering"). Both layers are modeled here. */
interface InFlightCapture {
  readonly label: 'A' | 'B' | 'C'
  readonly abort: AbortController
  readonly ocr: ReturnType<typeof deferred<ReturnType<typeof ocrResult>>>
  readonly catalog: ReturnType<typeof deferred<{ results: never[]; totalCount: number }>>
  readonly myGeneration: number
  readonly settled: Promise<
    | { kind: 'applied' }
    | { kind: 'resolved-but-superseded' }
    | { kind: 'aborted' }
    | { kind: 'other-error' }
  >
}

function startCapture(
  controller: ReturnType<typeof createRealScannerController>,
  label: InFlightCapture['label'],
  generationRef: { current: number },
): InFlightCapture {
  const ocr = deferred<ReturnType<typeof ocrResult>>()
  const catalog = deferred<{ results: never[]; totalCount: number }>()
  mockedRunOcrAnalysis.mockReturnValueOnce(ocr.promise)
  mockedSearchCards.mockReturnValueOnce(catalog.promise)
  const abort = new AbortController()
  // Exactly ScannerPage.tsx's own sequence: bump the shared generation counter THE INSTANT this
  // capture starts, before analyzeCapture is even called.
  generationRef.current += 1
  const myGeneration = generationRef.current
  const settled = controller
    .analyzeCapture(capture(), abort.signal)
    .then((): { kind: 'applied' } | { kind: 'resolved-but-superseded' } =>
      myGeneration === generationRef.current
        ? { kind: 'applied' }
        : { kind: 'resolved-but-superseded' },
    )
    .catch((error: unknown): { kind: 'aborted' } | { kind: 'other-error' } =>
      error instanceof ScannerAnalysisAbortedError ? { kind: 'aborted' } : { kind: 'other-error' },
    )
  return { label, abort, ocr, catalog, myGeneration, settled }
}

type ResolveOrder = 'AthenB' | 'BthenA'

const arbResolveOrder = fc.constantFrom<ResolveOrder>('AthenB', 'BthenA')
const arbReplaceTiming = fc.constantFrom<'immediately' | 'after-ocr' | 'after-catalog'>(
  'immediately',
  'after-ocr',
  'after-catalog',
)

describe('analysis A/B/C race matrix (P116 §3)', () => {
  it('50,000 generated three-way replacement schedules (A starts, B replaces A, C replaces B, at every meaningful stage timing): a replaced generation is NEVER applied as current state, exactly one generation ever wins, C always outlives every replacement', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbReplaceTiming,
        arbReplaceTiming,
        arbResolveOrder,
        async (bReplaceTiming, cReplaceTiming, resolveOrder) => {
          const controller = createRealScannerController({ userId: 'user-a' })
          const generationRef = { current: 0 }
          const a = startCapture(controller, 'A', generationRef)

          async function advanceTo(
            capture: InFlightCapture,
            timing: 'immediately' | 'after-ocr' | 'after-catalog',
          ): Promise<void> {
            if (timing === 'immediately') return
            capture.ocr.resolve(ocrResult(capture.label))
            await Promise.resolve()
            await Promise.resolve()
            if (timing === 'after-catalog') {
              capture.catalog.resolve({ results: [], totalCount: 0 })
              await Promise.resolve()
              await Promise.resolve()
            }
          }

          // B replaces A — the real ScannerPage sequence: bump generation, new
          // AbortController, abort the old one.
          await advanceTo(a, bReplaceTiming)
          a.abort.abort()
          const b = startCapture(controller, 'B', generationRef)

          await advanceTo(b, cReplaceTiming)
          b.abort.abort()
          const c = startCapture(controller, 'C', generationRef)

          // C is the sole survivor: let its own pipeline complete for real, in the order the
          // property picked (OCR then catalog, or catalog "started" first — Promise.all means
          // both were issued together regardless; this only changes which resolves FIRST).
          if (resolveOrder === 'AthenB') {
            c.ocr.resolve(ocrResult('C'))
            c.catalog.resolve({ results: [], totalCount: 0 })
          } else {
            c.catalog.resolve({ results: [], totalCount: 0 })
            c.ocr.resolve(ocrResult('C'))
          }
          // Unblock anything still pending on A/B's own deferreds too (a real stale network
          // response DOES eventually arrive) — must never affect anything at this point.
          a.ocr.resolve(ocrResult('A'))
          a.catalog.resolve({ results: [], totalCount: 0 })
          b.ocr.resolve(ocrResult('B'))
          b.catalog.resolve({ results: [], totalCount: 0 })

          const [aOutcome, bOutcome, cOutcome] = await Promise.all([
            a.settled,
            b.settled,
            c.settled,
          ])

          // The two-layer guarantee (F-05/P89): A and B were both superseded before C started —
          // whichever way their own pipeline actually settled (a real ScannerAnalysisAbortedError
          // when the abort landed before their last checkpoint, or a legitimately-completed
          // result when it landed after), NEITHER may ever be treated as the caller's "current"
          // state. C — the sole generation nothing ever supersedes in this schedule — must
          // always settle as genuinely applied, never merely aborted or superseded.
          expect(aOutcome.kind).not.toBe('applied')
          expect(bOutcome.kind).not.toBe('applied')
          expect(cOutcome.kind).toBe('applied')

          controller.dispose()
        },
      ),
      { numRuns: 50_000 },
    )
  }, 120_000)
})
