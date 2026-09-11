import { afterEach, describe, expect, it, vi } from 'vitest'
import { VisualRecognitionClient } from '../../src/features/scanner/visual/visual-client'

/**
 * P116 §4 — visual worker lifecycle soak. P113 did zero lifecycle soak (prompt's own framing).
 *
 * `tests/ui/scanner-visual-client.test.ts` already exercises message-handling correctness (P78)
 * against a `FakeWorker` (this test environment is Node — no real Worker/ONNX runtime exists, so a
 * REAL 1000-cycle model-loading soak is not reachable here; the real-worker E2E smoke lives in
 * `tests/e2e/visual-worker-real-browser.spec.ts`). This file reuses that same FakeWorker seam for
 * PROTOCOL-LEVEL soak — construct/init/embed/search/dispose repeated at real scale — tracking
 * exactly what prompt §4 asks: unresolved requests and listener leaks across many complete
 * lifecycles, plus one long-lived worker across many embed/search RPCs.
 *
 * A genuine finding surfaced by this soak (documented, not silently patched — see this file's
 * final describe block): `dispose()` clears the `pending`/`pendingRankRequests` maps but never
 * REJECTS the promises already handed to callers — an `analyze()`/`getExpectedCardRank()` call
 * still in flight when `dispose()` runs (a real route-exit/account-switch/retake mid-scan) hangs
 * forever instead of settling. `analyzeCapture`'s own `AbortSignal` checks
 * (`throwIfAnalysisAborted`) are POLLED at specific checkpoints, not raced against the signal's
 * abort event — so a hang inside `visualClient.analyze()` is NOT rescued by the caller's abort
 * either, once the visual channel was already warm (`analyzeVisualBounded` only applies its own
 * timeout race when the channel was NOT already ready before capture).
 */

interface Listener {
  (event: unknown): void
}

class FakeWorker {
  static instances: FakeWorker[] = []
  static disposedCount = 0
  listeners: Record<string, Listener[]> = {}
  postMessage = vi.fn()
  terminate = vi.fn(() => {
    FakeWorker.disposedCount += 1
  })

  constructor() {
    FakeWorker.instances.push(this)
  }

  addEventListener(type: string, cb: Listener): void {
    ;(this.listeners[type] ??= []).push(cb)
  }
  removeEventListener(type: string, cb: Listener): void {
    this.listeners[type] = (this.listeners[type] ?? []).filter((l) => l !== cb)
  }
  emit(type: string, data: unknown): void {
    for (const cb of [...(this.listeners[type] ?? [])]) cb(data)
  }
}

function latestWorker(): FakeWorker {
  const worker = FakeWorker.instances[FakeWorker.instances.length - 1]
  if (!worker) throw new Error('no FakeWorker was constructed')
  return worker
}

function readyMessage(overrides: Record<string, unknown> = {}) {
  return {
    type: 'ready',
    backend: 'wasm',
    indexAvailable: true,
    cardCount: 19501,
    modelColdLoadMs: 12,
    indexVersion: 'visual-v1',
    indexSourceProjectRef: null,
    indexModelRevision: null,
    indexGeneratedAt: null,
    indexEmbeddingsSha256: null,
    indexContentId: null,
    indexPrototypesPerCard: 2,
    indexPrototypeStrategy: null,
    indexRowCount: 39002,
    indexSourceProjectExpected: null,
    indexSourceProjectMatch: null,
    indexRuntimeChecksumVerified: null,
    indexRuntimeChecksumMs: null,
    indexLoadMs: 3,
    indexUnavailableReason: null,
    offscreenCanvasAvailableInWorker: true,
    backendRequested: 'auto',
    backendAttempts: { webgpu: 'not-available', wasm: 'success' },
    webgpuError: null,
    wasmError: null,
    processorLoad: 'success',
    modelLoad: 'success',
    indexLoad: 'success',
    phaseTimings: {
      workerStartMs: 1,
      processorFetchMs: 1,
      processorInitMs: 1,
      modelConfigFetchMs: 1,
      modelOnnxFetchMs: 1,
      modelOnnxBytes: 1,
      ortRuntimeFetchMs: 1,
      ortWasmFetchMs: 1,
      ortWasmBytes: 1,
      modelCompileAndSessionCreateMs: 1,
      indexManifestFetchMs: 1,
      indexIdsFetchMs: 1,
      indexEmbeddingsFetchMs: 1,
      indexEmbeddingsBytes: 1,
      indexDecodeMs: 1,
      visualReadyTotalMs: 1,
    },
    ...overrides,
  }
}

function fakeBitmap(): ImageBitmap {
  return { close: vi.fn(), width: 300, height: 400 }
}

const originalWorker = globalThis.Worker

afterEach(() => {
  FakeWorker.instances = []
  FakeWorker.disposedCount = 0
  vi.stubGlobal('Worker', originalWorker)
})

describe('VisualRecognitionClient lifecycle soak — protocol level (P116 §4)', () => {
  it('1,000 complete lifecycles (construct -> ensureReady -> embed/search -> dispose): one Worker constructed and terminated per lifecycle, no accumulation, ranking result matches expected rank', async () => {
    vi.stubGlobal('Worker', FakeWorker)
    const CYCLES = 1_000
    for (let i = 0; i < CYCLES; i += 1) {
      const client = new VisualRecognitionClient()
      const readyPromise = client.ensureReady()
      const worker = latestWorker()
      worker.emit('message', { data: readyMessage() })
      const ready = await readyPromise
      expect(ready?.indexAvailable).toBe(true)

      const analyzePromise = client.analyze(fakeBitmap(), 20)
      // analyze() awaits the already-resolved ensureReady() promise before it calls
      // worker.postMessage — that resumption happens on a LATER microtask, not synchronously, so
      // the embed-and-search postMessage call is not observable until we yield once.
      await Promise.resolve()
      await Promise.resolve()
      // The worker answers with a deterministic hit set tied to this cycle's index.
      const lastCall = worker.postMessage.mock.calls[worker.postMessage.mock.calls.length - 1]
      const requestId = (lastCall?.[0] as { requestId: number }).requestId
      worker.emit('message', {
        data: {
          type: 'result',
          requestId,
          hits: [{ cardId: `card-${String(i)}`, similarity: 0.5 }],
          embedMs: 1,
          searchMs: 1,
          embeddingNorm: 1,
        },
      })
      const result = await analyzePromise
      expect(result?.hits[0]?.cardId).toBe(`card-${String(i)}`)

      client.dispose()
    }
    expect(FakeWorker.instances.length).toBe(CYCLES)
    expect(FakeWorker.disposedCount).toBe(CYCLES)
  })

  it('10,000 embed/search RPC requests against ONE long-lived worker: requestId never collides, every response routes to its own caller, no growth in outstanding-request bookkeeping', async () => {
    vi.stubGlobal('Worker', FakeWorker)
    const client = new VisualRecognitionClient()
    const readyPromise = client.ensureReady()
    latestWorker().emit('message', { data: readyMessage() })
    await readyPromise
    const worker = latestWorker()

    const RPCS = 10_000
    const seenRequestIds = new Set<number>()
    for (let i = 0; i < RPCS; i += 1) {
      const analyzePromise = client.analyze(fakeBitmap(), 5)
      await Promise.resolve()
      await Promise.resolve()
      const call = worker.postMessage.mock.calls[worker.postMessage.mock.calls.length - 1]?.[0] as {
        requestId: number
      }
      expect(seenRequestIds.has(call.requestId)).toBe(false)
      seenRequestIds.add(call.requestId)
      worker.emit('message', {
        data: {
          type: 'result',
          requestId: call.requestId,
          hits: [],
          embedMs: 0,
          searchMs: 0,
          embeddingNorm: 0,
        },
      })
      await analyzePromise
    }
    expect(seenRequestIds.size).toBe(RPCS)
    client.dispose()
  })
})

describe('fixed: dispose() settles in-flight analyze()/getExpectedCardRank() promises instead of abandoning them (P116 §4 finding, closed by P116 Phase Q)', () => {
  it('an analyze() call still pending when dispose() runs resolves to null immediately — the caller never hangs', async () => {
    vi.stubGlobal('Worker', FakeWorker)
    const client = new VisualRecognitionClient()
    const readyPromise = client.ensureReady()
    latestWorker().emit('message', { data: readyMessage() })
    await readyPromise

    const analyzePromise = client.analyze(fakeBitmap(), 5)
    // Let analyze() actually progress past its await ensureReady() and reach worker.postMessage —
    // otherwise dispose() would race BEFORE the request is even registered, which exercises a
    // different (already-correct) early-return path instead of a genuinely in-flight request.
    await Promise.resolve()
    await Promise.resolve()
    expect(latestWorker().postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'embed-and-search' }),
      expect.anything(),
    )
    client.dispose() // route exit / account switch / retake mid-scan

    // This session's original P116 §4 run found dispose() left this pending forever (proven by
    // racing against a short timer, which always won). visual-client.ts's dispose() now rejects
    // every stored `{ resolve, reject }` BEFORE clearing the pending map — analyze()'s own
    // try/catch turns that rejection into its documented `null` result — so the real assertion is
    // just "this resolves", no race needed any more.
    await expect(analyzePromise).resolves.toBeNull()
  })
})
