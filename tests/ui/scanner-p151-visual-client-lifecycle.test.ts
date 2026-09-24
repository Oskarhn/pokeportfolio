import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  VISUAL_ANALYZE_TIMEOUT_MS,
  VisualRecognitionClient,
} from '../../src/features/scanner/visual/visual-client'

/**
 * P151 — VisualRecognitionClient resource lifecycle. A FakeWorker with a tracked LIVE set stands in
 * for the real Worker (Node has none): every assertion is about a worker actually terminated or a
 * bitmap actually closed, and every ordering is driven by explicit barriers rather than sleeps.
 *
 * Reproduces three defects of the baseline client:
 *  1. `dispose()` only nulled ready state, so any later `ensureReady()`/`analyze()`/`prewarm()` — in
 *     practice a stale in-flight scan reaching the client after route exit — constructed a NEW Worker
 *     that nothing referenced or terminated (a model-loading worker leaked per exit).
 *  2. `dispose()` during init left `readyPromise` pending forever: the awaiting `analyze()` (and the
 *     controller's `Promise.all` around it) never resumed and its bitmap was never closed.
 *  3. A worker that crashed or wedged was never terminated (kept model + index in memory until route
 *     exit) and, when wedged, hung every scan behind it.
 */

interface Listener {
  (event: unknown): void
}

class FakeWorker {
  static instances: FakeWorker[] = []
  static live = new Set<FakeWorker>()
  listeners: Record<string, Listener[]> = {}
  postMessage = vi.fn()
  terminated = false
  terminate = vi.fn(() => {
    this.terminated = true
    FakeWorker.live.delete(this)
  })

  constructor() {
    FakeWorker.instances.push(this)
    FakeWorker.live.add(this)
  }

  addEventListener(type: string, cb: Listener): void {
    ;(this.listeners[type] ??= []).push(cb)
  }

  /** Delivers to listeners even after terminate(): a message already queued on the parent's port
   *  before the worker was killed is still delivered in real browsers. */
  emit(type: string, data: unknown): void {
    for (const cb of this.listeners[type] ?? []) cb(data)
  }
}

function latestWorker(): FakeWorker {
  const worker = FakeWorker.instances[FakeWorker.instances.length - 1]
  if (!worker) throw new Error('no FakeWorker was constructed')
  return worker
}

function readyMessage() {
  return {
    type: 'ready',
    backend: 'wasm',
    indexAvailable: true,
    cardCount: 19500,
    modelColdLoadMs: 900,
    indexVersion: 'visual-v1',
    indexSourceProjectRef: null,
    indexModelRevision: null,
    indexGeneratedAt: null,
    indexEmbeddingsSha256: null,
    indexContentId: 'f25fc05d569b7cca',
    indexSchemaVersion: 2,
    indexPayloadFormat: 'multi-prototype-v2',
    indexPrototypesPerCard: 2,
    indexPrototypeStrategy: 'pristinePlus1Aux',
    indexRowCount: 39000,
    indexSourceProjectExpected: null,
    indexSourceProjectMatch: null,
    indexRuntimeChecksumVerified: true,
    indexRuntimeChecksumMs: 30,
    indexLoadMs: 70,
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
  }
}

interface FakeBitmap {
  close: ReturnType<typeof vi.fn>
  width: number
  height: number
}

function fakeBitmap(): FakeBitmap {
  return { close: vi.fn(), width: 300, height: 400 }
}

/** The client only needs `close()`, `width` and `height`; the double is passed where an
 *  ImageBitmap is expected. */
function analyze(client: VisualRecognitionClient, bitmap: FakeBitmap) {
  return client.analyze(bitmap as unknown as ImageBitmap, 30)
}

/** Yields long enough for `analyze()` to get past its `await ensureReady()` and reach postMessage. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

const originalWorker = globalThis.Worker

afterEach(() => {
  FakeWorker.instances = []
  FakeWorker.live.clear()
  vi.useRealTimers()
  vi.stubGlobal('Worker', originalWorker)
})

async function readyClient(): Promise<{ client: VisualRecognitionClient; worker: FakeWorker }> {
  vi.stubGlobal('Worker', FakeWorker)
  const client = new VisualRecognitionClient()
  const readyPromise = client.ensureReady()
  const worker = latestWorker()
  worker.emit('message', { data: readyMessage() })
  await readyPromise
  return { client, worker }
}

describe('P151 — dispose() is terminal and never leaves an init pending', () => {
  it('dispose() DURING init settles the pending ensureReady()/analyze() instead of hanging, and closes the bitmap', async () => {
    vi.stubGlobal('Worker', FakeWorker)
    const client = new VisualRecognitionClient()
    const ready = client.ensureReady()
    const bitmap = fakeBitmap()
    const analysis = analyze(client, bitmap) // awaiting the still-pending init

    client.dispose()

    // Both must settle on their own — a hang here is the defect (the test would time out).
    await expect(ready).resolves.toBeNull()
    await expect(analysis).resolves.toBeNull()
    expect(bitmap.close).toHaveBeenCalledTimes(1)
    expect(FakeWorker.live.size).toBe(0)
  })

  it('after dispose(), ensureReady()/prewarm()/analyze() construct NO new Worker (no resurrection)', async () => {
    const { client } = await readyClient()
    client.dispose()
    const constructedBefore = FakeWorker.instances.length

    await expect(client.ensureReady()).resolves.toBeNull()
    await expect(client.prewarm()).resolves.toBeNull()
    const bitmap = fakeBitmap()
    await expect(analyze(client, bitmap)).resolves.toBeNull()

    expect(bitmap.close).toHaveBeenCalledTimes(1)
    expect(FakeWorker.instances.length).toBe(constructedBefore)
    expect(FakeWorker.live.size).toBe(0)
  })

  it('a stale scan that reaches the client only after dispose() (the real route-exit race) leaks no worker', async () => {
    // A -> controller.dispose() -> A's createImageBitmap finally resolves -> visualClient.analyze().
    vi.stubGlobal('Worker', FakeWorker)
    const client = new VisualRecognitionClient()
    client.dispose()
    const bitmap = fakeBitmap()
    await expect(analyze(client, bitmap)).resolves.toBeNull()
    expect(FakeWorker.instances.length).toBe(0)
    expect(bitmap.close).toHaveBeenCalledTimes(1)
  })

  it('a message already queued from a disposed worker cannot resurrect ready state', () => {
    vi.stubGlobal('Worker', FakeWorker)
    const client = new VisualRecognitionClient()
    void client.ensureReady()
    const worker = latestWorker()
    client.dispose()
    worker.emit('message', { data: readyMessage() })

    const snapshot = client.getDiagnosticsSnapshot()
    expect(snapshot.readyInfo).toBeNull()
    expect(snapshot.modelState).toBe('not-loaded')
  })
})

describe('P151 — a crashed or wedged worker is terminated, not kept alive', () => {
  it('a crash AFTER ready terminates the worker, reports failed (not ready), and never constructs a replacement', async () => {
    const { client, worker } = await readyClient()
    const inFlight = analyze(client, fakeBitmap())
    await settle()

    worker.emit('error', { message: 'wasm abort', filename: '', lineno: 0, colno: 0 })

    await expect(inFlight).resolves.toBeNull()
    expect(worker.terminate).toHaveBeenCalledTimes(1)
    expect(FakeWorker.live.size).toBe(0)
    const snapshot = client.getDiagnosticsSnapshot()
    expect(snapshot.modelState).toBe('failed')
    expect(snapshot.readyInfo).toBeNull()

    const bitmap = fakeBitmap()
    await expect(analyze(client, bitmap)).resolves.toBeNull()
    expect(bitmap.close).toHaveBeenCalledTimes(1)
    expect(FakeWorker.instances.length).toBe(1)
  })

  it('a warm worker that never answers times out, is terminated, and the NEXT scan does not hang behind it', async () => {
    vi.useFakeTimers()
    const { client, worker } = await readyClient()
    const bitmap = fakeBitmap()
    const first = analyze(client, bitmap)
    await vi.advanceTimersByTimeAsync(0)

    await vi.advanceTimersByTimeAsync(VISUAL_ANALYZE_TIMEOUT_MS)
    await expect(first).resolves.toBeNull()
    expect(worker.terminate).toHaveBeenCalledTimes(1)
    expect(FakeWorker.live.size).toBe(0)
    // The bitmap was transferred to the (dead) worker, not closed here a second time.
    expect(bitmap.close).not.toHaveBeenCalled()
    expect(client.getDiagnosticsSnapshot().modelState).toBe('failed')

    const second = fakeBitmap()
    await expect(analyze(client, second)).resolves.toBeNull()
    expect(second.close).toHaveBeenCalledTimes(1)
  })

  it('a normal round trip clears its timeout (no timer accumulates per scan) and still resolves', async () => {
    vi.useFakeTimers()
    const { client, worker } = await readyClient()
    for (let i = 0; i < 25; i += 1) {
      const pending = analyze(client, fakeBitmap())
      await vi.advanceTimersByTimeAsync(0)
      const call = worker.postMessage.mock.calls.at(-1)?.[0] as { requestId: number }
      worker.emit('message', {
        data: {
          type: 'result',
          requestId: call.requestId,
          hits: [],
          embedMs: 1,
          searchMs: 1,
          embeddingNorm: 1,
        },
      })
      await expect(pending).resolves.toMatchObject({ hits: [] })
    }
    expect(vi.getTimerCount()).toBe(0)
    client.dispose()
  })

  it('a synchronous postMessage failure closes the bitmap and leaves the worker usable for the next scan', async () => {
    const { client, worker } = await readyClient()
    worker.postMessage.mockImplementationOnce(() => {
      throw new Error('DataCloneError')
    })
    const failing = fakeBitmap()
    await expect(analyze(client, failing)).resolves.toBeNull()
    expect(failing.close).toHaveBeenCalledTimes(1)

    const next = analyze(client, fakeBitmap())
    await settle()
    const call = worker.postMessage.mock.calls.at(-1)?.[0] as { requestId: number }
    worker.emit('message', {
      data: {
        type: 'result',
        requestId: call.requestId,
        hits: [{ cardId: 'a', similarity: 0.9 }],
        embedMs: 1,
        searchMs: 1,
        embeddingNorm: 1,
      },
    })
    await expect(next).resolves.toMatchObject({ hits: [{ cardId: 'a', similarity: 0.9 }] })
    client.dispose()
  })
})

describe('P151 — 100 randomized lifecycles leave zero live workers and zero unsettled calls', () => {
  function mulberry32(seed: number): () => number {
    let a = seed
    return () => {
      a |= 0
      a = (a + 0x6d2b79f5) | 0
      let t = Math.imul(a ^ (a >>> 15), 1 | a)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }

  it('random interleavings of ready / analyze / crash / dispose / late messages', async () => {
    vi.stubGlobal('Worker', FakeWorker)
    const rng = mulberry32(0x151)
    const bitmaps: FakeBitmap[] = []
    for (let cycle = 0; cycle < 100; cycle += 1) {
      const client = new VisualRecognitionClient()
      const calls: Promise<unknown>[] = [client.ensureReady()]
      const worker = latestWorker()
      const steps = Math.floor(rng() * 6) + 2
      for (let step = 0; step < steps; step += 1) {
        const roll = rng()
        if (roll < 0.3) {
          const bitmap = fakeBitmap()
          bitmaps.push(bitmap)
          calls.push(analyze(client, bitmap))
        } else if (roll < 0.5) {
          worker.emit('message', { data: readyMessage() })
        } else if (roll < 0.62) {
          worker.emit('error', { message: 'crash', filename: '', lineno: 0, colno: 0 })
        } else if (roll < 0.8) {
          client.dispose()
        } else {
          await settle()
        }
      }
      client.dispose()
      // Every call must settle by itself once the client is disposed.
      await Promise.all(calls)
      expect(FakeWorker.live.size).toBe(0)
    }
    // No bitmap is ever closed more than once by the client (double close is harmless in browsers
    // but signals two owners).
    for (const bitmap of bitmaps) expect(bitmap.close.mock.calls.length).toBeLessThanOrEqual(1)
    expect(FakeWorker.live.size).toBe(0)
  })
})
