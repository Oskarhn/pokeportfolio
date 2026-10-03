import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runOcrAnalysis, type OcrEnginePort } from '../../src/features/scanner/analyze'
import { ScannerAnalysisAbortedError } from '../../src/features/scanner/analysis-abort'
import type { ScannerCapture } from '../../src/features/scanner/contract'

/**
 * P151 — cooperative cancellation of the OCR stage. `runOcrAnalysis` is up to a dozen SERIALIZED
 * `recognize()` calls in the worst case (every ROI layout x contrast/binarize/multi-line passes, then
 * the full-card fallback). It had no way to observe an abort: a cancelled or superseded scan ran every
 * one of them while the next scan queued behind it. Deterministic barriers (deferred recognitions)
 * replace timing.
 */

function makeCanvas() {
  return {
    element: { width: 0, height: 0 },
    context: {
      fillStyle: '',
      fillRect: vi.fn(),
      drawImage: vi.fn(),
      getImageData: vi.fn((_x: number, _y: number, w: number, h: number) => ({
        data: new Uint8ClampedArray(w * h * 4),
        width: w,
        height: h,
      })),
      createImageData: vi.fn((w: number, h: number) => ({
        data: new Uint8ClampedArray(w * h * 4),
        width: w,
        height: h,
      })),
      putImageData: vi.fn(),
    },
  }
}

/** A pool whose `withLock` REALLY serializes (unlike the pass-through fake in scanner-analyze.test),
 *  so the "queued behind another scan for the shared canvases" ordering is exercised for real. */
function makePool() {
  const canvases = new Map<string, ReturnType<typeof makeCanvas>>()
  let queue: Promise<unknown> = Promise.resolve()
  return {
    take: vi.fn((slot: string, width: number, height: number) => {
      let canvas = canvases.get(slot)
      if (canvas === undefined) {
        canvas = makeCanvas()
        canvases.set(slot, canvas)
      }
      if (canvas.element.width < width) canvas.element.width = Math.round(width)
      if (canvas.element.height < height) canvas.element.height = Math.round(height)
      return canvas
    }),
    release: vi.fn(),
    withLock: vi.fn(<T>(work: () => Promise<T>): Promise<T> => {
      const run = queue.catch(() => undefined).then(work)
      queue = run.then(
        () => undefined,
        () => undefined,
      )
      return run
    }),
  }
}

function makeBitmap() {
  return { width: 500, height: 700, close: vi.fn() }
}

function makeCapture(): ScannerCapture {
  return {
    blob: new Blob(['synthetic'], { type: 'image/jpeg' }),
    width: 520,
    height: 720,
    cardRect: { left: 10, top: 20, width: 500, height: 700 },
  }
}

const bitmaps: ReturnType<typeof makeBitmap>[] = []

beforeEach(() => {
  bitmaps.length = 0
  Object.defineProperty(globalThis, 'createImageBitmap', {
    value: vi.fn(() => {
      const bitmap = makeBitmap()
      bitmaps.push(bitmap)
      return Promise.resolve(bitmap)
    }),
    configurable: true,
  })
})

afterEach(() => {
  delete (globalThis as Record<string, unknown>).createImageBitmap
})

/** A barrier: `promise` settles once `resolve()` is called. */
function gate(): { promise: Promise<undefined>; resolve: () => void } {
  let open!: () => void
  const promise = new Promise<undefined>((r) => {
    open = () => {
      r(undefined)
    }
  })
  return { promise, resolve: open }
}

const EMPTY = { text: '', confidence: 0 }

/** An engine whose recognitions all read nothing (the WORST case: every pass runs, then the full-card
 *  fallback). `gate` optionally holds a chosen call number until the test releases it. */
function makeEngine(hold?: { onCall: number; released: Promise<undefined>; reached: () => void }) {
  let calls = 0
  const engine = {
    prepare: vi.fn(() => Promise.resolve()),
    recognize: vi.fn(async () => {
      calls += 1
      if (hold !== undefined && calls === hold.onCall) {
        hold.reached()
        await hold.released
      }
      return EMPTY
    }),
  } satisfies OcrEnginePort
  return engine
}

describe('P151 — runOcrAnalysis observes an AbortSignal between recognitions', () => {
  it('baseline: with nothing readable and no signal, the pipeline runs MANY recognitions (the cost an abandoned scan used to pay in full)', async () => {
    const engine = makeEngine()
    await runOcrAnalysis(makeCapture(), engine, makePool() as never)
    expect(engine.recognize.mock.calls.length).toBeGreaterThan(8)
  })

  it('a signal aborted BEFORE the run starts does no work at all (no engine.prepare, no decode)', async () => {
    const controller = new AbortController()
    controller.abort()
    const engine = makeEngine()
    await expect(
      runOcrAnalysis(makeCapture(), engine, makePool() as never, false, controller.signal),
    ).rejects.toBeInstanceOf(ScannerAnalysisAbortedError)
    expect(engine.prepare).not.toHaveBeenCalled()
    expect(engine.recognize).not.toHaveBeenCalled()
    expect(bitmaps).toHaveLength(0)
  })

  it('aborting while the FIRST recognition is in flight stops the pipeline after exactly that one call, and still closes the bitmap', async () => {
    const controller = new AbortController()
    const released = gate()
    const reached = gate()
    const engine = makeEngine({
      onCall: 1,
      released: released.promise,
      reached: () => {
        reached.resolve()
      },
    })
    const run = runOcrAnalysis(makeCapture(), engine, makePool() as never, false, controller.signal)
    const outcome = run.then(
      () => 'resolved' as const,
      (error: unknown) => error,
    )

    await reached.promise // recognition #1 is now in flight
    controller.abort()
    released.resolve()

    expect(await outcome).toBeInstanceOf(ScannerAnalysisAbortedError)
    expect(engine.recognize).toHaveBeenCalledTimes(1)
    expect(bitmaps).toHaveLength(1)
    expect(bitmaps[0]?.close).toHaveBeenCalledTimes(1)
  })

  it('aborting at every recognition boundary stops within one further call, never running the remaining passes', async () => {
    const worstCase = makeEngine()
    await runOcrAnalysis(makeCapture(), worstCase, makePool() as never)
    const fullCost = worstCase.recognize.mock.calls.length

    for (const abortAfter of [1, 2, 3, 5, fullCost - 1]) {
      const controller = new AbortController()
      let seen = 0
      const engine: OcrEnginePort & { recognize: ReturnType<typeof vi.fn> } = {
        prepare: vi.fn(() => Promise.resolve()),
        recognize: vi.fn(() => {
          seen += 1
          if (seen === abortAfter) controller.abort()
          return Promise.resolve(EMPTY)
        }),
      }
      await expect(
        runOcrAnalysis(makeCapture(), engine, makePool() as never, false, controller.signal),
      ).rejects.toBeInstanceOf(ScannerAnalysisAbortedError)
      expect(engine.recognize.mock.calls.length).toBe(abortAfter)
      expect(engine.recognize.mock.calls.length).toBeLessThan(fullCost)
    }
  })

  it('a run that was aborted while QUEUED behind another scan for the shared canvases never starts its pipeline', async () => {
    const pool = makePool()
    const released = gate()
    const reached = gate()
    const engineA = makeEngine({
      onCall: 1,
      released: released.promise,
      reached: () => {
        reached.resolve()
      },
    })
    const engineB = makeEngine()
    const controllerB = new AbortController()

    const a = runOcrAnalysis(makeCapture(), engineA, pool as never)
    await reached.promise // A holds the canvas lock, mid-recognition
    const b = runOcrAnalysis(makeCapture(), engineB, pool as never, false, controllerB.signal)
    const bOutcome = b.then(
      () => 'resolved' as const,
      (error: unknown) => error,
    )
    // B decoded its bitmap and is now waiting for the lock. Abandon it.
    await Promise.resolve()
    controllerB.abort()
    released.resolve()

    await a
    expect(await bOutcome).toBeInstanceOf(ScannerAnalysisAbortedError)
    expect(engineB.recognize).not.toHaveBeenCalled()
    expect(bitmaps).toHaveLength(2)
    for (const bitmap of bitmaps) expect(bitmap.close).toHaveBeenCalledTimes(1)
  })

  it('an engine failure is still an ordinary failure, not misreported as a cancellation', async () => {
    const engine: OcrEnginePort = {
      prepare: vi.fn(() => Promise.reject(new Error('cold start failed'))),
      recognize: vi.fn(),
    }
    await expect(
      runOcrAnalysis(
        makeCapture(),
        engine,
        makePool() as never,
        false,
        new AbortController().signal,
      ),
    ).rejects.not.toBeInstanceOf(ScannerAnalysisAbortedError)
  })
})
