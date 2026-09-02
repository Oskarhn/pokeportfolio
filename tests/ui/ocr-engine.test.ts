import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * F-13 (P89): dedicated ScannerOcrEngine suite — before this, the only test file referencing
 * ScannerOcrEngine fully mocked the whole class away (tests/ui/scanner-controller.test.ts), so
 * `prepare()`'s claimed race-safety, `getState()`'s state machine, `recognize()`'s sequencing
 * and `dispose()`'s claimed in-flight safety were asserted only in code comments, never
 * exercised. `tesseract.js` itself is mocked at the module boundary (the ONE thing this class
 * imports dynamically) with an injected fake worker, so everything ABOVE that boundary — the
 * class's own state machine and concurrency discipline — runs for real.
 */

interface FakeWorker {
  recognize: ReturnType<
    typeof vi.fn<(image: unknown) => Promise<{ data: { text: string; confidence: number } }>>
  >
  setParameters: ReturnType<typeof vi.fn<(params: Record<string, string>) => Promise<unknown>>>
  terminate: ReturnType<typeof vi.fn<() => Promise<unknown>>>
}

function fakeWorker(): FakeWorker {
  return {
    recognize: vi
      .fn<(image: unknown) => Promise<{ data: { text: string; confidence: number } }>>()
      .mockResolvedValue({ data: { text: 'PIKACHU', confidence: 92 } }),
    setParameters: vi
      .fn<(params: Record<string, string>) => Promise<unknown>>()
      .mockResolvedValue(undefined),
    terminate: vi.fn<() => Promise<unknown>>().mockResolvedValue(undefined),
  }
}

const createWorkerMock = vi.fn<(...args: unknown[]) => Promise<FakeWorker>>()

vi.mock('tesseract.js', () => ({
  createWorker: (...args: unknown[]) => createWorkerMock(...args),
  OEM: { LSTM_ONLY: 1 },
}))

beforeEach(() => {
  createWorkerMock.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

/** Flushes every currently pending microtask (unlike a fixed count of `await Promise.resolve()`,
 *  which is fragile to exactly how many `await`s a call chain happens to contain) — real
 *  (non-fake) timers process the whole microtask queue before a macrotask runs. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

async function importEngine() {
  // Fresh module instance per test avoids any cross-test module-level state (none exists today,
  // but ScannerOcrEngine instances themselves are always fresh per `new` anyway — this just keeps
  // the createWorkerMock wiring simple and matches this suite's own reset-per-test discipline).
  return import('../../src/features/scanner/ocr-engine')
}

describe('ScannerOcrEngine — state machine (F-13)', () => {
  it('starts not-loaded, with started=false', async () => {
    const { ScannerOcrEngine } = await importEngine()
    const engine = new ScannerOcrEngine()
    expect(engine.getState()).toBe('not-loaded')
    expect(engine.started).toBe(false)
  })

  it('moves not-loaded -> loading -> ready across a successful prepare()', async () => {
    const { ScannerOcrEngine } = await importEngine()
    const engine = new ScannerOcrEngine()
    let resolveCreate!: (worker: FakeWorker) => void
    createWorkerMock.mockReturnValue(
      new Promise((resolve) => {
        resolveCreate = resolve
      }),
    )
    const prepared = engine.prepare()
    expect(engine.getState()).toBe('loading')
    expect(engine.started).toBe(true)
    resolveCreate(fakeWorker())
    await prepared
    expect(engine.getState()).toBe('ready')
  })

  it('a failed prepare() moves to failed, and a later retry can still succeed', async () => {
    const { ScannerOcrEngine, ScannerEngineError } = await importEngine()
    const engine = new ScannerOcrEngine()
    createWorkerMock.mockRejectedValueOnce(new Error('cold-start network failure'))
    await expect(engine.prepare()).rejects.toBeInstanceOf(ScannerEngineError)
    expect(engine.getState()).toBe('failed')

    createWorkerMock.mockResolvedValueOnce(fakeWorker())
    await engine.prepare()
    expect(engine.getState()).toBe('ready')
  })

  it('prepare() twice concurrently shares ONE underlying createWorker call (race-safe)', async () => {
    const { ScannerOcrEngine } = await importEngine()
    const engine = new ScannerOcrEngine()
    let resolveCreate!: (worker: FakeWorker) => void
    createWorkerMock.mockReturnValue(
      new Promise((resolve) => {
        resolveCreate = resolve
      }),
    )
    const first = engine.prepare()
    const second = engine.prepare()
    resolveCreate(fakeWorker())
    await Promise.all([first, second])
    expect(createWorkerMock).toHaveBeenCalledTimes(1)
    expect(engine.getState()).toBe('ready')
  })

  it('prepare() after the worker is already ready is an immediate no-op', async () => {
    const { ScannerOcrEngine } = await importEngine()
    const engine = new ScannerOcrEngine()
    createWorkerMock.mockResolvedValueOnce(fakeWorker())
    await engine.prepare()
    createWorkerMock.mockClear()
    await engine.prepare()
    expect(createWorkerMock).not.toHaveBeenCalled()
  })

  it('recognize() before any prepare() throws ScannerEngineError, not a raw worker error', async () => {
    const { ScannerOcrEngine, ScannerEngineError } = await importEngine()
    const engine = new ScannerOcrEngine()
    const canvas = {} as HTMLCanvasElement
    await expect(engine.recognize(canvas)).rejects.toBeInstanceOf(ScannerEngineError)
  })

  it('prepare() after dispose() refuses with ScannerEngineDisposedError', async () => {
    const { ScannerOcrEngine, ScannerEngineDisposedError } = await importEngine()
    const engine = new ScannerOcrEngine()
    createWorkerMock.mockResolvedValueOnce(fakeWorker())
    await engine.prepare()
    engine.dispose()
    await expect(engine.prepare()).rejects.toBeInstanceOf(ScannerEngineDisposedError)
  })
})

describe('ScannerOcrEngine — recognize() (F-13)', () => {
  it('sets the segmentation mode then recognizes, returning honest text/confidence', async () => {
    const { ScannerOcrEngine } = await importEngine()
    const engine = new ScannerOcrEngine()
    const worker = fakeWorker()
    createWorkerMock.mockResolvedValueOnce(worker)
    await engine.prepare()
    const canvas = {} as HTMLCanvasElement
    const result = await engine.recognize(canvas, 'single-line')
    expect(worker.setParameters).toHaveBeenLastCalledWith({ tessedit_pageseg_mode: '7' })
    expect(worker.recognize).toHaveBeenCalledWith(canvas)
    expect(result).toEqual({ text: 'PIKACHU', confidence: 92 })
  })

  it('auto segmentation uses PSM 3', async () => {
    const { ScannerOcrEngine } = await importEngine()
    const engine = new ScannerOcrEngine()
    const worker = fakeWorker()
    createWorkerMock.mockResolvedValueOnce(worker)
    await engine.prepare()
    await engine.recognize({} as HTMLCanvasElement, 'auto')
    expect(worker.setParameters).toHaveBeenLastCalledWith({ tessedit_pageseg_mode: '3' })
  })

  it('missing text/confidence in the worker result falls back to honest empty/zero, never fabricated', async () => {
    const { ScannerOcrEngine } = await importEngine()
    const engine = new ScannerOcrEngine()
    const worker = fakeWorker()
    // Deliberately malformed — the real Tesseract response type always carries both fields;
    // this simulates a worker returning an incomplete/unexpected shape.
    worker.recognize.mockResolvedValue({ data: {} } as {
      data: { text: string; confidence: number }
    })
    createWorkerMock.mockResolvedValueOnce(worker)
    await engine.prepare()
    const result = await engine.recognize({} as HTMLCanvasElement)
    expect(result).toEqual({ text: '', confidence: 0 })
  })

  it('recognize() failure propagates to the caller', async () => {
    const { ScannerOcrEngine } = await importEngine()
    const engine = new ScannerOcrEngine()
    const worker = fakeWorker()
    worker.recognize.mockRejectedValue(new Error('worker crashed'))
    createWorkerMock.mockResolvedValueOnce(worker)
    await engine.prepare()
    await expect(engine.recognize({} as HTMLCanvasElement)).rejects.toThrow('worker crashed')
  })
})

describe('ScannerOcrEngine — dispose() (F-13/F-14)', () => {
  it('dispose() before any prepare() does not throw', async () => {
    const { ScannerOcrEngine } = await importEngine()
    const engine = new ScannerOcrEngine()
    expect(() => {
      engine.dispose()
    }).not.toThrow()
  })

  it('dispose() terminates the real worker exactly once, idempotently', async () => {
    const { ScannerOcrEngine } = await importEngine()
    const engine = new ScannerOcrEngine()
    const worker = fakeWorker()
    createWorkerMock.mockResolvedValueOnce(worker)
    await engine.prepare()
    engine.dispose()
    engine.dispose()
    expect(worker.terminate).toHaveBeenCalledTimes(1)
  })

  it('F-14: a recognize() call whose underlying worker.recognize() NEVER resolves still settles (rejects) once dispose() runs', async () => {
    const { ScannerOcrEngine, ScannerEngineDisposedError } = await importEngine()
    const engine = new ScannerOcrEngine()
    const worker = fakeWorker()
    // Simulates the exact unverified-upstream-behaviour risk F-14 flags: the underlying
    // tesseract.js job promise never settles once its worker is killed.
    worker.recognize.mockReturnValue(new Promise(() => {}))
    createWorkerMock.mockResolvedValueOnce(worker)
    await engine.prepare()

    const pending = engine.recognize({} as HTMLCanvasElement)
    // Give recognize() a chance to actually start (reach worker.recognize()) before disposing.
    await flush()
    engine.dispose()

    await expect(pending).rejects.toBeInstanceOf(ScannerEngineDisposedError)
  })

  it('F-14: dispose() bounds MULTIPLE concurrently in-flight recognize() calls at once', async () => {
    const { ScannerOcrEngine, ScannerEngineDisposedError } = await importEngine()
    const engine = new ScannerOcrEngine()
    const worker = fakeWorker()
    worker.recognize.mockReturnValue(new Promise(() => {}))
    createWorkerMock.mockResolvedValueOnce(worker)
    await engine.prepare()

    // F-15's serialization means these queue rather than truly overlap in worker.recognize()
    // calls, but BOTH must still be pending (neither settled) at the moment dispose() runs, and
    // BOTH must settle once it does — the disposal signal must reach every queued caller, not
    // just whichever is currently "active".
    const first = engine.recognize({} as HTMLCanvasElement)
    const second = engine.recognize({} as HTMLCanvasElement)
    // `first` is the only one actually running yet (F-15 serializes `second` behind it) — give
    // it a chance to reach worker.recognize() before disposing.
    await flush()
    engine.dispose()

    await expect(first).rejects.toBeInstanceOf(ScannerEngineDisposedError)
    // `second` never even started running its own worker call — it must be refused at the
    // moment it WOULD start (the disposed-check `recognize()` now performs on the queued path),
    // not left calling into an already-terminated worker.
    await expect(second).rejects.toBeInstanceOf(ScannerEngineDisposedError)
  })
})

describe('ScannerOcrEngine — recognize() concurrency lock (F-15)', () => {
  it('two concurrent recognize() calls are serialized and each result matches its OWN input', async () => {
    const { ScannerOcrEngine } = await importEngine()
    const engine = new ScannerOcrEngine()
    const worker = fakeWorker()
    const callOrder: string[] = []
    let resolveFirst!: (value: { data: { text: string; confidence: number } }) => void
    worker.recognize.mockImplementation((image: unknown) => {
      const source = image as { label?: string }
      callOrder.push(`recognize:${source.label}`)
      if (source.label === 'A') {
        return new Promise((resolve) => {
          resolveFirst = resolve
        })
      }
      return Promise.resolve({ data: { text: 'B-RESULT', confidence: 77 } })
    })
    worker.setParameters.mockImplementation((params: Record<string, string>) => {
      callOrder.push(`setParameters:${params.tessedit_pageseg_mode}`)
      return Promise.resolve()
    })
    createWorkerMock.mockResolvedValueOnce(worker)
    await engine.prepare()
    callOrder.length = 0 // drop the prepare()-time setParameters call

    const canvasA = { label: 'A' } as unknown as HTMLCanvasElement
    const canvasB = { label: 'B' } as unknown as HTMLCanvasElement
    const resultAPromise = engine.recognize(canvasA, 'single-line')
    const resultBPromise = engine.recognize(canvasB, 'auto')

    // Let call A reach worker.recognize() and start awaiting it (queued call B must NOT have
    // started yet — its own setParameters/recognize must not appear in callOrder here).
    await flush()
    expect(callOrder).toEqual(['setParameters:7', 'recognize:A'])

    resolveFirst({ data: { text: 'A-RESULT', confidence: 88 } })
    const [resultA, resultB] = await Promise.all([resultAPromise, resultBPromise])

    expect(resultA).toEqual({ text: 'A-RESULT', confidence: 88 })
    expect(resultB).toEqual({ text: 'B-RESULT', confidence: 77 })
    // Full serialization: B's setParameters/recognize only happen AFTER A's recognize resolved.
    expect(callOrder).toEqual(['setParameters:7', 'recognize:A', 'setParameters:3', 'recognize:B'])
  })

  it('a rejected recognize() call does not wedge the queue for the next call', async () => {
    const { ScannerOcrEngine } = await importEngine()
    const engine = new ScannerOcrEngine()
    const worker = fakeWorker()
    worker.recognize
      .mockRejectedValueOnce(new Error('first call failed'))
      .mockResolvedValueOnce({ data: { text: 'OK', confidence: 50 } })
    createWorkerMock.mockResolvedValueOnce(worker)
    await engine.prepare()

    const first = engine.recognize({} as HTMLCanvasElement)
    const second = engine.recognize({} as HTMLCanvasElement)
    await expect(first).rejects.toThrow('first call failed')
    await expect(second).resolves.toEqual({ text: 'OK', confidence: 50 })
  })
})
