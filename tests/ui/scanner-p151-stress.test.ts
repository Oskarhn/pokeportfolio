import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createRealScannerController,
  ScannerAnalysisAbortedError,
} from '../../src/features/scanner/controller'
import { decodeImageFile } from '../../src/features/scanner/capture'
import { scannerSessionStore } from '../../src/features/scanner/session-store'

/**
 * P151 stress harness — FAST, SYNTHETIC lifecycle stress.
 *
 *   pnpm test                      runs a SMOKE size (20 iterations per mode) with the rest of the suite
 *   pnpm scanner:stress            FULL size: 100 iterations per mode (~35 s)
 *   pnpm scanner:stress --scale 10 ~1,000 iterations per mode
 *   pnpm scanner:stress -t "mode 4"   one mode only
 *
 * (`P151_STRESS=1` selects the full size; `P151_STRESS_SCALE` multiplies it.)
 *
 * What is REAL here: the controller, `runOcrAnalysis`, the canvas pool, the cancellation plumbing,
 * `decodeImageFile`, the OCR engine class's queue/timeout logic is covered in its own file. What is
 * FAKE: Tesseract, the visual worker, the catalog, the canvas surface (Node has none). So this proves
 * orchestration — no leaked worker/URL/timer, no stale publication, no unbounded work — NOT
 * recognition quality and NOT real-browser memory. The calibrated real-model runs are the
 * browser-side `scripts/scanner-p151/browser-bench.mjs` and tests/e2e/scanner-lifecycle-p151.spec.ts.
 */

const SCALE = Math.max(1, Number(process.env.P151_STRESS_SCALE ?? '1'))
/** Per-mode budget: each scan runs the real card-rectification CPU work on a fake canvas (~20 ms). */
const MODE_TIMEOUT_MS = 120_000 * SCALE
const FULL = process.env.P151_STRESS === '1'
const N = FULL ? 100 * SCALE : 20
// A burst of overlapping scans is not reachable from the UI (the state machine serializes them), and
// every scan runs its card-rectification CPU work before it can observe being superseded — so the
// burst is smaller than the sequential modes to keep the run fast.
const BURST = FULL ? 30 * SCALE : 10

vi.setConfig({ testTimeout: MODE_TIMEOUT_MS })

const debugState = vi.hoisted(() => ({ on: false }))
vi.mock('../../src/features/scanner/debug-flag', () => ({
  isScannerDebugEnabled: () => debugState.on,
}))

// --- fake canvas surface (Node has none): real CanvasPool + real runOcrAnalysis run on top of it ---
vi.mock('../../src/features/scanner/canvas-compat', () => {
  function makeCanvas(width: number, height: number) {
    const element = {
      width: Math.max(1, Math.round(width)),
      height: Math.max(1, Math.round(height)),
    }
    const context = {
      fillStyle: '',
      fillRect: () => undefined,
      drawImage: () => undefined,
      getImageData: (_x: number, _y: number, w: number, h: number) => ({
        data: new Uint8ClampedArray(w * h * 4).fill(128),
        width: w,
        height: h,
      }),
      createImageData: (w: number, h: number) => ({
        data: new Uint8ClampedArray(w * h * 4),
        width: w,
        height: h,
      }),
      putImageData: () => undefined,
    }
    return { element, context }
  }
  return {
    createCompatCanvas: makeCanvas,
    canvasToBlob: () => Promise.resolve(new Blob(['roi'])),
  }
})

vi.mock('../../src/data/catalog', () => ({
  searchCards: vi.fn(),
  getCardVariants: vi.fn(),
  getCardsByIds: vi.fn().mockResolvedValue([]),
  classifyCardIdsAgainstCatalog: vi.fn().mockResolvedValue(new Map()),
}))
vi.mock('../../src/data/collection', () => ({ addCardAcquisition: vi.fn() }))
// The real controller imports the leased client for its commit path (not exercised here).
vi.mock('../../src/data/leased-db', () => ({
  leasedDb: (lease: unknown) => ({ identityLease: lease }),
}))

// --- fakes with resource accounting ---------------------------------------------------------------
const world = vi.hoisted(() => ({
  liveEngines: new Set<object>(),
  liveVisualClients: new Set<object>(),
  recognizeInFlight: 0,
  maxRecognizeInFlight: 0,
  recognizeCalls: 0,
  script: 'clean',
  recognizeDelay: null as null | (() => Promise<void>),
}))

vi.mock('../../src/features/scanner/ocr-engine', () => ({
  ScannerOcrEngine: class {
    private disposed = false
    constructor() {
      world.liveEngines.add(this)
    }
    prepare = () => (this.disposed ? Promise.reject(new Error('disposed')) : Promise.resolve())
    getState = () => 'ready' as const
    recognize = async (_canvas: unknown, segmentation: string = 'single-line') => {
      world.recognizeCalls += 1
      world.recognizeInFlight += 1
      world.maxRecognizeInFlight = Math.max(world.maxRecognizeInFlight, world.recognizeInFlight)
      try {
        if (world.recognizeDelay !== null) await world.recognizeDelay()
        else await Promise.resolve()
        if (world.script === 'empty') return { text: '', confidence: 0 }
        return segmentation === 'single-line' && world.recognizeCalls % 2 === 1
          ? { text: 'PIKACHU', confidence: 95 }
          : { text: '58/102', confidence: 90 }
      } finally {
        world.recognizeInFlight -= 1
      }
    }
    dispose = () => {
      this.disposed = true
      world.liveEngines.delete(this)
    }
  },
}))
vi.mock('../../src/features/scanner/visual/visual-client', () => ({
  VisualRecognitionClient: class {
    constructor() {
      world.liveVisualClients.add(this)
    }
    analyze = (bitmap: { close: () => void }) => {
      bitmap.close()
      return Promise.resolve(null)
    }
    getDiagnosticsSnapshot = () => ({
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
    })
    prewarm = () => Promise.resolve(null)
    getExpectedCardRank = () => Promise.resolve(null)
    dispose = () => {
      world.liveVisualClients.delete(this)
    }
  },
}))

import { searchCards } from '../../src/data/catalog'
import { addCardAcquisition } from '../../src/data/collection'

let liveUrls: Set<string>
let bitmapsOpen: number

function capture(tag = 'x') {
  return {
    blob: new Blob([tag], { type: 'image/jpeg' }),
    width: 200,
    height: 280,
    cardRect: { left: 0, top: 0, width: 200, height: 280 },
  }
}

const pikachuRows = [
  {
    cardId: 'card-pikachu-58',
    name: 'Pikachu',
    localId: '58',
    rarity: null,
    category: null,
    illustrator: null,
    imageBaseUrl: null,
    language: 'en',
    setId: 's1',
    setName: 'Base Set',
    variantCount: 2,
  },
  {
    cardId: 'card-other-99',
    name: 'Other',
    localId: '99',
    rarity: null,
    category: null,
    illustrator: null,
    imageBaseUrl: null,
    language: 'en',
    setId: 's1',
    setName: 'Base Set',
    variantCount: 1,
  },
]

beforeEach(() => {
  vi.clearAllMocks()
  debugState.on = false
  world.liveEngines.clear()
  world.liveVisualClients.clear()
  world.recognizeInFlight = 0
  world.maxRecognizeInFlight = 0
  world.recognizeCalls = 0
  world.script = 'clean'
  world.recognizeDelay = null
  bitmapsOpen = 0
  liveUrls = new Set()
  let counter = 0
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
    counter += 1
    const url = `blob:stress-${String(counter)}`
    liveUrls.add(url)
    return url
  })
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url: string) => {
    liveUrls.delete(url)
  })
  Object.defineProperty(globalThis, 'createImageBitmap', {
    value: vi.fn(() => {
      bitmapsOpen += 1
      let closed = false
      return Promise.resolve({
        width: 500,
        height: 700,
        close: () => {
          if (!closed) {
            closed = true
            bitmapsOpen -= 1
          }
        },
      })
    }),
    configurable: true,
  })
  scannerSessionStore.clearAll()
  vi.mocked(searchCards).mockResolvedValue({ results: pikachuRows, totalCount: 2 } as never)
})

afterEach(() => {
  delete (globalThis as Record<string, unknown>).createImageBitmap
  vi.useRealTimers()
  vi.restoreAllMocks()
})

async function outcome(promise: Promise<unknown>): Promise<'ok' | 'aborted' | 'error'> {
  try {
    await promise
    return 'ok'
  } catch (error) {
    return error instanceof ScannerAnalysisAbortedError ? 'aborted' : 'error'
  }
}

describe('P151 stress — mode 1: repeated scans through the real pipeline', () => {
  it(`${String(N)} sequential scans all succeed, and nothing accumulates`, async () => {
    debugState.on = true // exercises the debug image URL store too
    const controller = createRealScannerController({ userId: 'user' })
    for (let i = 0; i < N; i += 1) {
      const analysis = await controller.analyzeCapture(capture(`s${String(i)}`))
      expect(analysis.candidates.length).toBeGreaterThan(0)
      // Exactly ONE scan's debug image SET (raw crop, rectified, name ROI, number ROI = 4 URLs)
      // is alive at any time: replace-and-revoke, never accumulate across scans.
      expect(liveUrls.size).toBeLessThanOrEqual(4)
    }
    expect(bitmapsOpen).toBe(0)
    controller.dispose()
    expect(liveUrls.size).toBe(0)
    expect(world.liveEngines.size).toBe(0)
    expect(world.liveVisualClients.size).toBe(0)
    expect(vi.mocked(addCardAcquisition)).not.toHaveBeenCalled()
  })
})

describe('P151 stress — mode 2: mixed valid / invalid frames', () => {
  it(`${String(N)} alternating readable, unreadable and hostile inputs: every one settles, no false match, next valid scan still works`, async () => {
    const controller = createRealScannerController({ userId: 'user' })
    const hostilePng = (w: number, h: number) =>
      new File(
        [
          new Uint8Array([
            0x89,
            0x50,
            0x4e,
            0x47,
            0x0d,
            0x0a,
            0x1a,
            0x0a,
            0,
            0,
            0,
            13,
            0x49,
            0x48,
            0x44,
            0x52,
            (w >>> 24) & 255,
            (w >>> 16) & 255,
            (w >>> 8) & 255,
            w & 255,
            (h >>> 24) & 255,
            (h >>> 16) & 255,
            (h >>> 8) & 255,
            h & 255,
            8,
            6,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
          ]),
        ],
        'bomb.png',
        { type: 'image/png' },
      )
    let readable = 0
    for (let i = 0; i < N; i += 1) {
      switch (i % 4) {
        case 0: {
          world.script = 'clean'
          const analysis = await controller.analyzeCapture(capture())
          expect(analysis.confidence).not.toBe('NO_MATCH')
          readable += 1
          break
        }
        case 1: {
          // Nothing readable at all: the worst-case pipeline must end in an honest NO_MATCH, never a
          // fabricated card. (The catalog double still answers a text search, but with no OCR text
          // there is no query to send.)
          world.script = 'empty'
          vi.mocked(searchCards).mockResolvedValueOnce({ results: [], totalCount: 0 })
          const analysis = await controller.analyzeCapture(capture())
          expect(analysis.confidence).toBe('NO_MATCH')
          expect(analysis.candidates).toEqual([])
          break
        }
        case 2: {
          const error = await decodeImageFile(hostilePng(60_000, 60_000)).then(
            () => null,
            (e: unknown) => e as Error,
          )
          expect(error?.name).toBe('ScannerFileTooLargeError')
          break
        }
        default: {
          const error = await decodeImageFile(hostilePng(10_000, 100)).then(
            () => null,
            (e: unknown) => e as Error,
          )
          expect(error?.name).toBe('ScannerDecodeError')
        }
      }
    }
    expect(readable).toBe(N / 4)
    // The two hostile modes never reached the decoder (this stub is only called by analyses).
    expect(bitmapsOpen).toBe(0)
    controller.dispose()
  })
})

describe('P151 stress — mode 3: open / close (controller lifecycle) with work in flight', () => {
  it(`${String(N)} create → prewarm → scan → dispose cycles leave no engine, visual client or timer alive`, async () => {
    vi.useFakeTimers()
    for (let i = 0; i < N; i += 1) {
      const controller = createRealScannerController({ userId: `user-${String(i)}` })
      controller.prewarm?.()
      const scan = controller.analyzeCapture(capture())
      // Dispose at a varying point relative to the scan and to the prewarm stagger timer.
      if (i % 3 === 0) await vi.advanceTimersByTimeAsync(0)
      if (i % 3 === 1) await vi.advanceTimersByTimeAsync(2_000)
      controller.dispose()
      const result = await outcome(scan)
      expect(['ok', 'aborted']).toContain(result)
    }
    await vi.advanceTimersByTimeAsync(10_000)
    expect(world.liveEngines.size).toBe(0)
    expect(world.liveVisualClients.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    expect(bitmapsOpen).toBe(0)
    expect(vi.mocked(addCardAcquisition)).not.toHaveBeenCalled()
  })
})

describe('P151 stress — mode 4: cancel / restart', () => {
  it(`${String(N)} cancel-then-restart cycles: only the restarted scan finishes, and a cancelled scan stops within ONE further recognition`, async () => {
    const controller = createRealScannerController({ userId: 'user' })
    let worstAfterAbort = 0
    let totalAfterAbort = 0
    for (let i = 0; i < N; i += 1) {
      // A reads nothing (worst case: ~a dozen passes unless something stops it) ...
      world.script = 'empty'
      const abortA = new AbortController()
      const a = controller.analyzeCapture(capture('a'), abortA.signal)
      // ... A gets some way into its pipeline (0..11 macrotask hops), then is cancelled and the
      // user immediately scans again; everything from here on reads cleanly.
      for (let hop = 0; hop < i % 12; hop += 1) await new Promise((r) => setTimeout(r, 0))
      const callsAtAbort = world.recognizeCalls
      world.script = 'clean'
      abortA.abort()
      const b = controller.analyzeCapture(capture('b'))
      const [aResult, bResult] = await Promise.all([outcome(a), outcome(b)])
      expect(bResult).toBe('ok')
      // A may already have finished before the abort landed; never anything but ok/aborted.
      expect(['ok', 'aborted']).toContain(aResult)
      // After the abort: at most ONE straggler recognition from A, plus B's own clean 2-call scan.
      const after = world.recognizeCalls - callsAtAbort
      worstAfterAbort = Math.max(worstAfterAbort, after)
      totalAfterAbort += after
    }
    expect(worstAfterAbort).toBeLessThanOrEqual(3)
    expect(totalAfterAbort).toBeLessThanOrEqual(3 * N)
    expect(bitmapsOpen).toBe(0)
    controller.dispose()
    expect(vi.mocked(addCardAcquisition)).not.toHaveBeenCalled()
  })
})

describe('P151 stress — mode 5: bounded concurrency', () => {
  it(`a burst of ${String(BURST)} simultaneous scans keeps recognition strictly serial, completes exactly one, and does no OCR work for the rest`, async () => {
    world.script = 'empty'
    const controller = createRealScannerController({ userId: 'user' })
    const scans = Array.from({ length: BURST }, (_, i) =>
      controller.analyzeCapture(capture(`c${String(i)}`)),
    )
    const results = await Promise.all(scans.map((scan) => outcome(scan)))
    expect(results.filter((r) => r === 'ok')).toHaveLength(1)
    expect(results.at(-1)).toBe('ok')
    expect(results.filter((r) => r === 'aborted')).toHaveLength(BURST - 1)
    // Never two recognitions in flight at once, and the abandoned N-1 scans did not run their
    // pipelines: total recognitions stay near ONE scan's worth, not N scans' worth.
    expect(world.maxRecognizeInFlight).toBe(1)
    const oneScan = (() => world.recognizeCalls)()
    expect(oneScan).toBeLessThan(40)
    expect(bitmapsOpen).toBe(0)
    controller.dispose()
  })
})
