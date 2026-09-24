import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createRealScannerController,
  ScannerAnalysisAbortedError,
} from '../../src/features/scanner/controller'
import { scannerSessionStore } from '../../src/features/scanner/session-store'

/**
 * P151 — request ordering and cancellation semantics of the REAL controller.
 *
 * Contract under test (documented in docs/SCANNER_RESEARCH.md "P151"): LATEST-SCAN-WINS. Starting a
 * scan aborts the previous one; disposing aborts the current one; a caller abort aborts it. An
 * aborted scan stops at its next checkpoint, rejects with ScannerAnalysisAbortedError and NEVER
 * touches controller-level shared state (diagnostics, match context, debug image URLs). No scan
 * cancelled or superseded here ever causes a collection write — the only writer is commitBatch.
 *
 * Every ordering is driven by explicit deferred promises; nothing depends on timing.
 */

const debugState = vi.hoisted(() => ({ on: false }))
vi.mock('../../src/features/scanner/debug-flag', () => ({
  isScannerDebugEnabled: () => debugState.on,
}))
vi.mock('../../src/features/scanner/analyze', () => ({
  runOcrAnalysis: vi.fn(),
  releaseOcrCanvases: vi.fn(),
}))
vi.mock('../../src/data/catalog', () => ({
  searchCards: vi.fn(),
  getCardVariants: vi.fn(),
  getCardsByIds: vi.fn(),
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
import { getCardsByIds, searchCards } from '../../src/data/catalog'
import { addCardAcquisition } from '../../src/data/collection'

const mockedRunOcrAnalysis = vi.mocked(runOcrAnalysis)
const mockedSearchCards = vi.mocked(searchCards)
const mockedGetCardsByIds = vi.mocked(getCardsByIds)
const mockedAddCardAcquisition = vi.mocked(addCardAcquisition)

function capture() {
  return {
    blob: new Blob(['synthetic'], { type: 'image/jpeg' }),
    width: 500,
    height: 700,
    cardRect: { left: 0, top: 0, width: 500, height: 700 },
  }
}

function visualSnapshot() {
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

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

/** Live blob-URL accounting: created minus revoked. The debug image store is the only place the
 *  controller allocates any. */
let liveUrls: Set<string>
let urlCounter = 0

beforeEach(() => {
  vi.clearAllMocks()
  debugState.on = false
  scannerSessionStore.clearAll()
  visualMocks.analyze.mockResolvedValue(null)
  visualMocks.getDiagnosticsSnapshot.mockReturnValue(visualSnapshot())
  visualMocks.prewarm.mockResolvedValue(null)
  ocrEngineMocks.prepare.mockResolvedValue(undefined)
  ocrEngineMocks.getState.mockReturnValue('not-loaded')
  mockedSearchCards.mockResolvedValue({ results: [], totalCount: 0 })
  mockedGetCardsByIds.mockResolvedValue([])
  installScanRouting()
  liveUrls = new Set()
  urlCounter = 0
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
    urlCounter += 1
    const url = `blob:p151-${String(urlCounter)}`
    liveUrls.add(url)
    return url
  })
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url: string) => {
    liveUrls.delete(url)
  })
})

afterEach(() => {
  delete (globalThis as Record<string, unknown>).createImageBitmap
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/** One scan whose every await is a barrier the test releases by hand. */
interface ScanHandle {
  readonly label: string
  readonly abort: AbortController
  readonly ocr: ReturnType<typeof deferred<ReturnType<typeof ocrResult>>>
  readonly enrich: ReturnType<typeof deferred<never[]>>
  readonly outcome: Promise<'ok' | 'aborted' | 'error'>
  /** The AbortSignal the controller handed to runOcrAnalysis for this scan. */
  readonly ocrSignal: () => AbortSignal | undefined
}

/** Scans are identified by the identity of the Blob they were started with: the controller only
 *  reaches runOcrAnalysis / the visual client / the catalog AFTER earlier awaits (and a scan that
 *  was aborted earlier never reaches them at all), so a call-order queue of mock return values would
 *  hand one scan another scan's barrier. */
interface ScanInternals extends ScanHandle {
  signal: AbortSignal | undefined
}
const scansByBlob = new Map<Blob, ScanInternals>()
const scansByLabel = new Map<string, ScanInternals>()

function installScanRouting(): void {
  scansByBlob.clear()
  scansByLabel.clear()
  mockedRunOcrAnalysis.mockImplementation((cap, _engine, _pool, _debug, signal) => {
    const scan = scansByBlob.get(cap.blob)
    if (scan === undefined) throw new Error('unrouted scan')
    scan.signal = signal
    return scan.ocr.promise
  })
  Object.defineProperty(globalThis, 'createImageBitmap', {
    value: vi.fn((blob: Blob) =>
      Promise.resolve({ blob, width: 500, height: 700, close: vi.fn() }),
    ),
    configurable: true,
  })
  visualMocks.analyze.mockImplementation((bitmap: { blob: Blob }) => {
    const scan = scansByBlob.get(bitmap.blob)
    return Promise.resolve({
      hits: [{ cardId: `visual-${scan?.label ?? '?'}`, similarity: 0.9 }],
      backend: 'wasm',
      embedMs: 1,
      searchMs: 1,
      embeddingNorm: 1,
    })
  })
  mockedGetCardsByIds.mockImplementation(((ids: string[]) => {
    const label = (ids[0] ?? '').replace('visual-', '')
    const scan = scansByLabel.get(label)
    return scan === undefined ? Promise.resolve([]) : scan.enrich.promise
  }) as never)
}

function startScan(
  controller: ReturnType<typeof createRealScannerController>,
  label: string,
): ScanHandle {
  const cap = capture()
  const abort = new AbortController()
  const scan = {
    label,
    abort,
    ocr: deferred<ReturnType<typeof ocrResult>>(),
    enrich: deferred<never[]>(),
    signal: undefined as AbortSignal | undefined,
  } as unknown as ScanInternals
  Object.defineProperty(scan, 'ocrSignal', { value: () => scan.signal })
  scansByBlob.set(cap.blob, scan)
  scansByLabel.set(label, scan)
  const outcome = controller.analyzeCapture(cap, abort.signal).then(
    () => 'ok' as const,
    (error: unknown) => (error instanceof ScannerAnalysisAbortedError ? 'aborted' : 'error'),
  )
  Object.defineProperty(scan, 'outcome', { value: outcome })
  return scan
}

/** Waits (on state, not on a fixed delay) until the scan has actually entered the OCR stage. */
async function untilInOcrStage(scan: ScanHandle): Promise<void> {
  for (let i = 0; i < 200 && scan.ocrSignal() === undefined; i += 1) await flush()
  if (scan.ocrSignal() === undefined) throw new Error(`scan ${scan.label} never reached OCR`)
}

/** Lets already-resolved awaits inside the pipeline advance to their next barrier. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('P151 — latest scan wins', () => {
  it('starting scan B aborts scan A WITHOUT the caller aborting it, and A never reaches shared state', async () => {
    debugState.on = true
    const controller = createRealScannerController({ userId: 'user' })
    const a = startScan(controller, 'A')
    await flush()
    expect(a.ocrSignal()?.aborted).toBe(false)

    const b = startScan(controller, 'B') // note: a.abort.abort() is deliberately NOT called
    expect(a.ocrSignal()?.aborted).toBe(true)

    b.ocr.resolve(ocrResult('B-CARD'))
    await flush()
    b.enrich.resolve([])
    expect(await b.outcome).toBe('ok')
    const publishedByB = controller.getLastDiagnostics?.()
    expect(publishedByB?.ocrNameSignal).toBe('B-CARD')
    const bImages = controller.getLastDebugImages?.()
    expect(bImages).not.toBeNull()

    // A finally reaches its last await AFTER B already published.
    a.ocr.resolve(ocrResult('A-CARD'))
    await flush()
    a.enrich.resolve([])
    expect(await a.outcome).toBe('aborted')

    expect(controller.getLastDiagnostics?.()?.ocrNameSignal).toBe('B-CARD')
    expect(controller.getLastDebugImages?.()).toBe(bImages)
    // B's debug image URLs are still live (A's late publish used to revoke them and replace them).
    expect(liveUrls.has(bImages?.rectifiedUrl ?? '')).toBe(true)
    expect(liveUrls.size).toBe(1)
    controller.dispose()
    expect(liveUrls.size).toBe(0)
  })

  it('B finishing first and A finishing later, in both orders, always leaves exactly B published', async () => {
    for (const order of ['A-before-B-publish', 'A-after-B-publish'] as const) {
      const controller = createRealScannerController({ userId: 'user' })
      const a = startScan(controller, 'A')
      await flush()
      const b = startScan(controller, 'B')
      a.ocr.resolve(ocrResult('A-CARD'))
      b.ocr.resolve(ocrResult('B-CARD'))
      await flush()
      if (order === 'A-before-B-publish') {
        a.enrich.resolve([])
        await flush()
        b.enrich.resolve([])
      } else {
        b.enrich.resolve([])
        await flush()
        a.enrich.resolve([])
      }
      expect(await a.outcome).toBe('aborted')
      expect(await b.outcome).toBe('ok')
      expect(controller.getLastDiagnostics?.()?.ocrNameSignal).toBe('B-CARD')
      controller.dispose()
    }
  })

  it('a burst of 100 rapid scans: exactly the last one publishes, every earlier one is aborted, none writes to the collection', async () => {
    debugState.on = true
    const controller = createRealScannerController({ userId: 'user' })
    const scans: ScanHandle[] = []
    for (let i = 0; i < 100; i += 1) scans.push(startScan(controller, `S${String(i)}`))
    // Every scan but the last was aborted the moment its successor started: either it never got as
    // far as the OCR stage at all (signal undefined) or the signal it holds is already aborted.
    for (const scan of scans.slice(0, -1)) expect(scan.ocrSignal()?.aborted ?? true).toBe(true)
    const last = scans.at(-1)
    if (last === undefined) throw new Error('no scans')
    await untilInOcrStage(last)
    expect(last.ocrSignal()?.aborted).toBe(false)

    // Stale scans complete in a scrambled order, the survivor somewhere in the middle.
    const order = [...scans.keys()].sort((x, y) => ((x * 37) % 101) - ((y * 37) % 101))
    for (const index of order) {
      const scan = scans[index]
      if (scan === undefined) continue
      scan.ocr.resolve(ocrResult(scan.label))
      await flush()
      scan.enrich.resolve([])
    }
    const outcomes = await Promise.all(scans.map((scan) => scan.outcome))
    expect(outcomes.filter((outcome) => outcome === 'ok')).toHaveLength(1)
    expect(outcomes.at(-1)).toBe('ok')
    expect(outcomes.filter((outcome) => outcome === 'aborted')).toHaveLength(99)
    expect(controller.getLastDiagnostics?.()?.ocrNameSignal).toBe('S99')
    expect(liveUrls.size).toBe(1)
    expect(mockedAddCardAcquisition).not.toHaveBeenCalled()
    controller.dispose()
    expect(liveUrls.size).toBe(0)
  })
})

describe('P151 — cancellation reaches every stage', () => {
  it('a caller abort is forwarded to the OCR stage (so the pipeline can stop between recognitions)', async () => {
    const controller = createRealScannerController({ userId: 'user' })
    const scan = startScan(controller, 'A')
    await flush()
    expect(scan.ocrSignal()?.aborted).toBe(false)
    scan.abort.abort()
    expect(scan.ocrSignal()?.aborted).toBe(true)
    scan.ocr.resolve(ocrResult('A'))
    scan.enrich.resolve([])
    expect(await scan.outcome).toBe('aborted')
    controller.dispose()
  })

  it('an already-aborted caller signal never starts the pipeline stages that follow', async () => {
    const controller = createRealScannerController({ userId: 'user' })
    const abort = new AbortController()
    abort.abort()
    await expect(controller.analyzeCapture(capture(), abort.signal)).rejects.toBeInstanceOf(
      ScannerAnalysisAbortedError,
    )
    expect(mockedRunOcrAnalysis).not.toHaveBeenCalled()
    controller.dispose()
  })

  it('dispose() aborts the in-flight scan, which then publishes nothing and leaks no debug image URLs', async () => {
    debugState.on = true
    const controller = createRealScannerController({ userId: 'user' })
    const scan = startScan(controller, 'A')
    await untilInOcrStage(scan)
    scan.ocr.resolve(ocrResult('A-CARD'))
    await flush()
    controller.dispose()
    expect(scan.ocrSignal()?.aborted).toBe(true)

    scan.enrich.resolve([]) // the stale scan's last await settles AFTER dispose
    expect(await scan.outcome).toBe('aborted')
    expect(liveUrls.size).toBe(0)
    expect(controller.getLastDiagnostics?.()).toBeNull()
    expect(controller.getLastDebugImages?.()).toBeNull()
  })

  it('analyzeCapture() on a disposed controller rejects at once without running any stage', async () => {
    const controller = createRealScannerController({ userId: 'user' })
    controller.dispose()
    await expect(controller.analyzeCapture(capture())).rejects.toBeInstanceOf(
      ScannerAnalysisAbortedError,
    )
    expect(mockedRunOcrAnalysis).not.toHaveBeenCalled()
  })

  it('prewarm() after dispose() arms no timer and never starts a visual worker', async () => {
    vi.useFakeTimers()
    const controller = createRealScannerController({ userId: 'user' })
    controller.dispose()
    controller.prewarm?.()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(visualMocks.prewarm).not.toHaveBeenCalled()
    expect(ocrEngineMocks.prepare).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('P151 — cancelled scans never cause downstream collection writes', () => {
  it('cancel, supersede and dispose in every combination leave addCardAcquisition uncalled', async () => {
    const controller = createRealScannerController({ userId: 'user' })
    const a = startScan(controller, 'A')
    const b = startScan(controller, 'B') // supersedes A
    const c = startScan(controller, 'C') // supersedes B
    b.abort.abort() // explicit cancel of an already-superseded scan
    for (const scan of [a, b, c]) {
      scan.ocr.resolve(ocrResult(scan.label))
      await flush()
      scan.enrich.resolve([])
    }
    controller.dispose() // disposes while C may still be finishing
    await Promise.all([a.outcome, b.outcome, c.outcome])
    expect(mockedAddCardAcquisition).not.toHaveBeenCalled()
  })

  it('commitBatch() after dispose() issues zero writes (a stale controller cannot write under another identity)', async () => {
    const controller = createRealScannerController({ userId: 'user' })
    controller.dispose()
    const result = await controller.commitBatch([
      {
        candidateId: 'c1',
        variantId: 'v1',
        quantity: 1,
        condition: 'NM',
        requestKey: 'k1',
      },
      {
        candidateId: 'c2',
        variantId: 'v2',
        quantity: 2,
        condition: 'NM',
        requestKey: 'k2',
      },
    ])
    expect(result.addedCount).toBe(0)
    expect(mockedAddCardAcquisition).not.toHaveBeenCalled()
  })
})
