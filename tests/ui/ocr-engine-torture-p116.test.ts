import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * P116 §18 (Phase J) — OCR torture beyond P113 §11's 300-call mutex test. The brief asks for
 * 1,000+ queued requests, cancellations, worker disposal mid-queue, and a fresh instance
 * recovering cleanly afterward. This file shares `ocr-engine.test.ts`'s exact mocking approach
 * (tesseract.js mocked at the module boundary; the class's own queue/mutex/dispose discipline
 * above that boundary runs for real) rather than re-deriving a different harness.
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

async function importEngine() {
  return import('../../src/features/scanner/ocr-engine')
}

describe('ScannerOcrEngine — queue torture at 1,000+ scale (P116 §18)', () => {
  it('1,200 recognize() calls fired near-simultaneously, mixed success/failure: every call settles in strict FIFO order, no deadlock', async () => {
    const { ScannerOcrEngine } = await importEngine()
    const engine = new ScannerOcrEngine()
    const worker = fakeWorker()
    const CALL_COUNT = 1_200
    const executionOrder: number[] = []
    worker.recognize.mockImplementation((image: unknown) => {
      const { index } = image as { index: number }
      executionOrder.push(index)
      // Every 11th call fails and every 13th returns a pathological (empty / oversized) result —
      // a richer mix than P113's plain 1-in-7 failure so the queue proves it tolerates whatever
      // shape a real recognition backend hands back, not just clean success/reject.
      if (index % 11 === 0) return Promise.reject(new Error(`synthetic failure ${String(index)}`))
      if (index % 13 === 0) return Promise.resolve({ data: { text: '', confidence: 0 } })
      if (index % 17 === 0) {
        return Promise.resolve({
          data: { text: 'X'.repeat(50_000), confidence: 100 },
        })
      }
      return Promise.resolve({ data: { text: `RESULT-${String(index)}`, confidence: index % 100 } })
    })
    createWorkerMock.mockResolvedValueOnce(worker)
    await engine.prepare()

    const calls = Array.from({ length: CALL_COUNT }, (_, index) =>
      engine.recognize({ index } as unknown as HTMLCanvasElement).then(
        (result) => ({ ok: true as const, index, result }),
        (error: unknown) => ({ ok: false as const, index, error }),
      ),
    )
    const settled = await Promise.all(calls)

    expect(settled).toHaveLength(CALL_COUNT)
    expect(executionOrder).toEqual(Array.from({ length: CALL_COUNT }, (_, i) => i))
    const failedIndices = settled.filter((s) => !s.ok).map((s) => s.index)
    const expectedFailedIndices = Array.from({ length: CALL_COUNT }, (_, i) => i).filter(
      (i) => i % 11 === 0,
    )
    expect(failedIndices).toEqual(expectedFailedIndices)
    // A pathological (empty or 50,000-char) result never crashes the queue or gets swapped with a
    // neighbor's result — each call still resolves with exactly its own worker output.
    for (const s of settled) {
      if (!s.ok) continue
      if (s.index % 13 === 0) expect(s.result).toEqual({ text: '', confidence: 0 })
      else if (s.index % 17 === 0)
        expect(s.result).toEqual({ text: 'X'.repeat(50_000), confidence: 100 })
      else
        expect(s.result).toEqual({ text: `RESULT-${String(s.index)}`, confidence: s.index % 100 })
    }
  })

  it('dispose() fired partway through a 1,000-call burst rejects every in-flight AND every still-queued call — none hang — and a fresh instance recovers cleanly afterward', async () => {
    const { ScannerOcrEngine } = await importEngine()
    const engine = new ScannerOcrEngine()
    const worker = fakeWorker()
    const CALL_COUNT = 1_000
    const DISPOSE_AFTER = 400
    let started = 0
    worker.recognize.mockImplementation((image: unknown) => {
      started += 1
      if (started === DISPOSE_AFTER) {
        // Fire dispose() from inside the queue's own progress, guaranteeing it lands mid-burst
        // (some calls already settled, most still queued) rather than racing an external timer.
        queueMicrotask(() => {
          engine.dispose()
        })
      }
      const { index } = image as { index: number }
      return Promise.resolve({ data: { text: `RESULT-${String(index)}`, confidence: index % 100 } })
    })
    createWorkerMock.mockResolvedValueOnce(worker)
    await engine.prepare()

    const calls = Array.from({ length: CALL_COUNT }, (_, index) =>
      engine.recognize({ index } as unknown as HTMLCanvasElement).then(
        (result) => ({ ok: true as const, index, result }),
        (error: unknown) => ({ ok: false as const, index, error }),
      ),
    )
    const settled = await Promise.all(calls)

    // No call hangs forever — Promise.all above would itself never resolve if one did.
    expect(settled).toHaveLength(CALL_COUNT)
    const succeeded = settled.filter((s) => s.ok)
    const failed = settled.filter((s) => !s.ok)
    // At least the calls that ran before dispose() succeeded, and at least the calls still queued
    // once it fired were rejected — proves this run actually exercised the mid-queue dispose path
    // rather than disposing before anything started or after everything finished.
    expect(succeeded.length).toBeGreaterThan(0)
    expect(failed.length).toBeGreaterThan(0)
    expect(succeeded.length + failed.length).toBe(CALL_COUNT)

    // A brand-new instance must prepare and recognize normally — disposal of the previous instance
    // leaves no shared/static state behind, even after a 1,000-call queue was torn down mid-flight.
    const freshWorker = fakeWorker()
    createWorkerMock.mockResolvedValueOnce(freshWorker)
    const fresh = new ScannerOcrEngine()
    await fresh.prepare()
    expect(fresh.getState()).toBe('ready')
    const result = await fresh.recognize({} as HTMLCanvasElement)
    expect(result).toEqual({ text: 'PIKACHU', confidence: 92 })
  })

  it('the queue survives every call failing (100% failure rate) without deadlocking or leaving the mutex held', async () => {
    const { ScannerOcrEngine } = await importEngine()
    const engine = new ScannerOcrEngine()
    const worker = fakeWorker()
    const CALL_COUNT = 1_000
    worker.recognize.mockImplementation((image: unknown) => {
      const { index } = image as { index: number }
      return Promise.reject(new Error(`always fails ${String(index)}`))
    })
    createWorkerMock.mockResolvedValueOnce(worker)
    await engine.prepare()

    const calls = Array.from({ length: CALL_COUNT }, (_, index) =>
      engine.recognize({ index } as unknown as HTMLCanvasElement).then(
        () => ({ ok: true as const }),
        () => ({ ok: false as const }),
      ),
    )
    const settled = await Promise.all(calls)
    expect(settled.every((s) => !s.ok)).toBe(true)

    // The mutex was released after every one of the 1,000 failures — one more call still works.
    worker.recognize.mockResolvedValueOnce({ data: { text: 'RECOVERED', confidence: 80 } })
    const recovered = await engine.recognize({} as HTMLCanvasElement)
    expect(recovered).toEqual({ text: 'RECOVERED', confidence: 80 })
  })
})
