import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * P151 — OCR engine lifecycle regressions. `tesseract.js` is mocked at the module boundary (the ONE
 * thing `ScannerOcrEngine` imports dynamically) with a fake whose live-worker count is tracked, so
 * every assertion below is about resources actually released, not about call bookkeeping alone.
 *
 * Reproduces P130-10: leaving the scanner while the OCR worker was still cold-starting used to leave
 * one fully initialised Tesseract worker alive per exit, because `dispose()` could only terminate a
 * worker that already existed and `prepare()` stored whatever it received after the fact.
 */

interface TrackedWorker {
  recognize: ReturnType<
    typeof vi.fn<(image: unknown) => Promise<{ data: { text: string; confidence: number } }>>
  >
  setParameters: ReturnType<typeof vi.fn<(params: Record<string, string>) => Promise<unknown>>>
  terminate: ReturnType<typeof vi.fn<() => Promise<unknown>>>
  live: boolean
}

const liveWorkers = new Set<TrackedWorker>()
let createdWorkers = 0

function trackedWorker(): TrackedWorker {
  const worker: TrackedWorker = {
    recognize: vi
      .fn<(image: unknown) => Promise<{ data: { text: string; confidence: number } }>>()
      .mockResolvedValue({ data: { text: 'PIKACHU', confidence: 92 } }),
    setParameters: vi
      .fn<(params: Record<string, string>) => Promise<unknown>>()
      .mockResolvedValue(undefined),
    terminate: vi.fn<() => Promise<unknown>>().mockImplementation(() => {
      worker.live = false
      liveWorkers.delete(worker)
      return Promise.resolve(undefined)
    }),
    live: true,
  }
  liveWorkers.add(worker)
  createdWorkers += 1
  return worker
}

const createWorkerMock = vi.fn<(...args: unknown[]) => Promise<TrackedWorker>>()

vi.mock('tesseract.js', () => ({
  createWorker: (...args: unknown[]) => createWorkerMock(...args),
  OEM: { LSTM_ONLY: 1 },
}))

beforeEach(() => {
  createWorkerMock.mockReset()
  liveWorkers.clear()
  createdWorkers = 0
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

async function importEngine() {
  return import('../../src/features/scanner/ocr-engine')
}

/** A `createWorker` result the test resolves/rejects by hand — the barrier that makes the
 *  "dispose() lands while the worker is still loading" ordering deterministic. */
function deferredWorker(): {
  promise: Promise<TrackedWorker>
  resolve: () => TrackedWorker
  reject: (error: Error) => void
} {
  let resolveInner!: (worker: TrackedWorker) => void
  let rejectInner!: (error: Error) => void
  const promise = new Promise<TrackedWorker>((resolve, reject) => {
    resolveInner = resolve
    rejectInner = reject
  })
  return {
    promise,
    resolve: () => {
      const worker = trackedWorker()
      resolveInner(worker)
      return worker
    },
    reject: rejectInner,
  }
}

describe('P151 — dispose() during prepare() (P130-10)', () => {
  it('terminates a worker that finishes loading AFTER dispose(), and rejects prepare() as disposed', async () => {
    const { ScannerOcrEngine, ScannerEngineDisposedError } = await importEngine()
    const engine = new ScannerOcrEngine()
    const pending = deferredWorker()
    createWorkerMock.mockReturnValueOnce(pending.promise)

    const prepared = engine.prepare()
    const outcome = prepared.then(
      () => 'resolved' as const,
      (error: unknown) => error,
    )
    expect(engine.getState()).toBe('loading')

    engine.dispose()
    const worker = pending.resolve()
    const result = await outcome

    expect(result).toBeInstanceOf(ScannerEngineDisposedError)
    expect(worker.terminate).toHaveBeenCalledTimes(1)
    expect(liveWorkers.size).toBe(0)
    expect(engine.getState()).toBe('not-loaded')
    expect(engine.started).toBe(false)
  })

  it('concurrent prepare() callers share the same disposed rejection instead of resolving against a dead engine', async () => {
    const { ScannerOcrEngine, ScannerEngineDisposedError } = await importEngine()
    const engine = new ScannerOcrEngine()
    const pending = deferredWorker()
    createWorkerMock.mockReturnValueOnce(pending.promise)

    const first = engine.prepare().then(
      () => 'resolved' as const,
      (error: unknown) => error,
    )
    const second = engine.prepare().then(
      () => 'resolved' as const,
      (error: unknown) => error,
    )
    engine.dispose()
    pending.resolve()

    const [a, b] = await Promise.all([first, second])
    expect(a).toBeInstanceOf(ScannerEngineDisposedError)
    expect(b).toBeInstanceOf(ScannerEngineDisposedError)
    expect(createWorkerMock).toHaveBeenCalledTimes(1)
    expect(liveWorkers.size).toBe(0)
  })

  it('a load failure that arrives after dispose() neither leaks nor reports a failed reader', async () => {
    const { ScannerOcrEngine } = await importEngine()
    const engine = new ScannerOcrEngine()
    const pending = deferredWorker()
    createWorkerMock.mockReturnValueOnce(pending.promise)

    const outcome = engine.prepare().then(
      () => 'resolved' as const,
      (error: unknown) => error,
    )
    engine.dispose()
    pending.reject(new Error('network died'))
    await outcome
    expect(liveWorkers.size).toBe(0)
    await expect(engine.prepare()).rejects.toMatchObject({ name: 'ScannerEngineDisposedError' })
  })

  it('a worker that resolved BEFORE dispose() is terminated exactly once, and dispose() is idempotent', async () => {
    const { ScannerOcrEngine } = await importEngine()
    const engine = new ScannerOcrEngine()
    const worker = trackedWorker()
    createWorkerMock.mockResolvedValueOnce(worker)
    await engine.prepare()
    expect(liveWorkers.size).toBe(1)

    engine.dispose()
    engine.dispose()
    expect(worker.terminate).toHaveBeenCalledTimes(1)
    expect(liveWorkers.size).toBe(0)
  })

  it('100 open/close cycles across every dispose-vs-load ordering leave ZERO live workers', async () => {
    const { ScannerOcrEngine } = await importEngine()
    // 0: dispose while loading, load succeeds afterwards (the P130-10 shape)
    // 1: load succeeds, then dispose
    // 2: dispose while loading, load fails afterwards
    // 3: load fails, then dispose
    // 4: dispose twice while loading, load succeeds
    for (let cycle = 0; cycle < 100; cycle += 1) {
      const engine = new ScannerOcrEngine()
      const pending = deferredWorker()
      createWorkerMock.mockReturnValueOnce(pending.promise)
      const outcome = engine.prepare().then(
        () => 'resolved' as const,
        () => 'rejected' as const,
      )
      switch (cycle % 5) {
        case 0:
          engine.dispose()
          pending.resolve()
          break
        case 1:
          pending.resolve()
          await outcome
          engine.dispose()
          break
        case 2:
          engine.dispose()
          pending.reject(new Error('late failure'))
          break
        case 3:
          pending.reject(new Error('early failure'))
          await outcome
          engine.dispose()
          break
        default:
          engine.dispose()
          engine.dispose()
          pending.resolve()
      }
      await outcome
      expect(liveWorkers.size).toBe(0)
    }
    expect(createdWorkers).toBeGreaterThan(0)
    expect(liveWorkers.size).toBe(0)
  })
})

describe('P151 — a hung recognition must not wedge the serialized queue', () => {
  it('times a single hung recognize() out, discards that worker, and lets the next scan rebuild one', async () => {
    vi.useFakeTimers()
    const { ScannerOcrEngine, ScannerEngineTimeoutError, OCR_RECOGNIZE_TIMEOUT_MS } =
      await importEngine()
    const engine = new ScannerOcrEngine()
    const hung = trackedWorker()
    hung.recognize.mockImplementation(() => new Promise(() => {})) // never settles
    createWorkerMock.mockResolvedValueOnce(hung)
    await engine.prepare()

    const first = engine.recognize({} as HTMLCanvasElement).then(
      () => 'resolved' as const,
      (error: unknown) => error,
    )
    // A second call queued BEHIND the hung one — used to wait forever.
    const second = engine.recognize({} as HTMLCanvasElement).then(
      () => 'resolved' as const,
      (error: unknown) => error,
    )

    await vi.advanceTimersByTimeAsync(OCR_RECOGNIZE_TIMEOUT_MS)
    expect(await first).toBeInstanceOf(ScannerEngineTimeoutError)
    // The queued call fails fast against the discarded worker rather than hanging on it.
    expect(await second).toMatchObject({ name: 'ScannerEngineError' })
    expect(hung.terminate).toHaveBeenCalledTimes(1)
    expect(hung.recognize).toHaveBeenCalledTimes(1)
    expect(engine.getState()).toBe('not-loaded')

    // Recovery: the next scan's prepare() builds a fresh worker and recognition works again.
    const fresh = trackedWorker()
    createWorkerMock.mockResolvedValueOnce(fresh)
    await engine.prepare()
    expect(engine.getState()).toBe('ready')
    await expect(engine.recognize({} as HTMLCanvasElement)).resolves.toMatchObject({
      text: 'PIKACHU',
    })
    expect(createdWorkers).toBe(2)
    engine.dispose()
    expect(liveWorkers.size).toBe(0)
  })

  it('a normal recognize() clears its timeout timer (no timer accumulates per call)', async () => {
    vi.useFakeTimers()
    const { ScannerOcrEngine } = await importEngine()
    const engine = new ScannerOcrEngine()
    createWorkerMock.mockResolvedValueOnce(trackedWorker())
    await engine.prepare()
    for (let i = 0; i < 50; i += 1) {
      await engine.recognize({} as HTMLCanvasElement)
    }
    expect(vi.getTimerCount()).toBe(0)
    engine.dispose()
  })

  it('dispose() while a recognize() is in flight rejects it as disposed and does not double-terminate on the later timeout', async () => {
    vi.useFakeTimers()
    const { ScannerOcrEngine, OCR_RECOGNIZE_TIMEOUT_MS } = await importEngine()
    const engine = new ScannerOcrEngine()
    const worker = trackedWorker()
    worker.recognize.mockImplementation(() => new Promise(() => {}))
    createWorkerMock.mockResolvedValueOnce(worker)
    await engine.prepare()

    const call = engine.recognize({} as HTMLCanvasElement).then(
      () => 'resolved' as const,
      (error: unknown) => error,
    )
    engine.dispose()
    expect(await call).toMatchObject({ name: 'ScannerEngineDisposedError' })
    await vi.advanceTimersByTimeAsync(OCR_RECOGNIZE_TIMEOUT_MS * 2)
    expect(worker.terminate).toHaveBeenCalledTimes(1)
  })
})
