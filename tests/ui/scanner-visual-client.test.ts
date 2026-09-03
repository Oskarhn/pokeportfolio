import { afterEach, describe, expect, it, vi } from 'vitest'
import { VisualRecognitionClient } from '../../src/features/scanner/visual/visual-client'

/**
 * P78 regression suite for VisualRecognitionClient's message handling — phased init
 * attributability (R10/R11), a real backend/cardCount report on success (R12), and a safe worker
 * crash reason (R13). The test environment runs under Node (`environment: 'node'` in
 * vite.config.ts), which has no real Worker global, so a fake Worker intercepts construction and
 * lets the test drive the exact message shapes the real worker posts.
 */

interface Listener {
  (event: unknown): void
}

class FakeWorker {
  static instances: FakeWorker[] = []
  listeners: Record<string, Listener[]> = {}
  postMessage = vi.fn()
  terminate = vi.fn()

  constructor() {
    FakeWorker.instances.push(this)
  }

  addEventListener(type: string, cb: Listener): void {
    ;(this.listeners[type] ??= []).push(cb)
  }

  emit(type: string, data: unknown): void {
    for (const cb of this.listeners[type] ?? []) cb(data)
  }
}

function latestWorker(): FakeWorker {
  const worker = FakeWorker.instances[FakeWorker.instances.length - 1]
  if (!worker) throw new Error('no FakeWorker was constructed')
  return worker
}

/** P81 §3: a representative phase-timing report, used to prove the client relays it verbatim. */
function samplePhaseTimings(overrides: Record<string, unknown> = {}) {
  return {
    workerStartMs: 18,
    processorFetchMs: 12,
    processorInitMs: 2,
    modelConfigFetchMs: 6,
    modelOnnxFetchMs: 540,
    modelOnnxBytes: 24451943,
    ortRuntimeFetchMs: 4,
    ortWasmFetchMs: 310,
    ortWasmBytes: 12942611,
    modelCompileAndSessionCreateMs: 180,
    indexManifestFetchMs: 3,
    indexIdsFetchMs: 22,
    indexEmbeddingsFetchMs: 71,
    indexEmbeddingsBytes: 7488384,
    indexDecodeMs: 19,
    visualReadyTotalMs: 972,
    ...overrides,
  }
}

function readyMessage(overrides: Record<string, unknown> = {}) {
  return {
    type: 'ready',
    backend: 'wasm',
    indexAvailable: true,
    cardCount: 19501,
    modelColdLoadMs: 972,
    indexVersion: 'visual-v1',
    indexSourceProjectRef: 'nopmkroeygmlvndzjjqs.supabase.co',
    indexModelRevision: 'c2bb04a51fab207c420665f1946016107bffc701',
    indexGeneratedAt: '2026-09-01T00:00:00.000Z',
    indexEmbeddingsSha256: 'deadbeef',
    indexContentId: '0123456789abcdef',
    indexPrototypeCount: 2,
    indexPrototypeStrategy: 'pristinePlus1Aux',
    indexRowCount: 39002,
    indexSourceProjectExpected: 'nopmkroeygmlvndzjjqs.supabase.co',
    indexSourceProjectMatch: true,
    indexRuntimeChecksumVerified: true,
    indexRuntimeChecksumMs: 41,
    indexLoadMs: 76,
    indexUnavailableReason: null,
    offscreenCanvasAvailableInWorker: true,
    backendRequested: 'auto',
    backendAttempts: { webgpu: 'not-available', wasm: 'success' },
    webgpuError: null,
    wasmError: null,
    processorLoad: 'success',
    modelLoad: 'success',
    indexLoad: 'success',
    phaseTimings: samplePhaseTimings(),
    ...overrides,
  }
}

function unavailableMessage(overrides: Record<string, unknown> = {}) {
  return {
    type: 'unavailable',
    reason: 'model load failed: no backend available',
    backendRequested: 'auto',
    backendAttempts: { webgpu: 'not-attempted', wasm: 'not-attempted' },
    webgpuError: null,
    wasmError: null,
    processorLoad: 'failed',
    modelLoad: 'failed',
    indexLoad: 'not-reached',
    phaseTimings: samplePhaseTimings({ visualReadyTotalMs: 40 }),
    ...overrides,
  }
}

const originalWorker = globalThis.Worker

afterEach(() => {
  FakeWorker.instances = []
  vi.stubGlobal('Worker', originalWorker)
})

describe('VisualRecognitionClient — backend/init diagnostics (P78)', () => {
  it('R10: a processor-load failure is distinguishable from a model-load failure', async () => {
    vi.stubGlobal('Worker', FakeWorker)
    const client = new VisualRecognitionClient()
    const readyPromise = client.ensureReady()
    const worker = latestWorker()
    worker.emit('message', {
      data: unavailableMessage({
        reason: 'processor load failed: 404 on preprocessor_config.json',
      }),
    })
    const ready = await readyPromise
    expect(ready).toBeNull()
    const snapshot = client.getDiagnosticsSnapshot()
    expect(snapshot.modelState).toBe('failed')
    expect(snapshot.unavailableReason).toBe(
      'processor load failed: 404 on preprocessor_config.json',
    )
    expect(snapshot.backendDiagnostics?.processorLoad).toBe('failed')
    expect(snapshot.backendDiagnostics?.modelLoad).toBe('failed')
    expect(snapshot.backendDiagnostics?.indexLoad).toBe('not-reached')
  })

  it('R11: an index-load failure is distinguishable from a model-load failure (model still ready)', async () => {
    vi.stubGlobal('Worker', FakeWorker)
    const client = new VisualRecognitionClient()
    const readyPromise = client.ensureReady()
    const worker = latestWorker()
    worker.emit('message', {
      data: readyMessage({
        indexAvailable: false,
        cardCount: 0,
        indexLoad: 'failed',
        indexUnavailableReason: 'manifest.json fetch failed (HTTP 404)',
      }),
    })
    const ready = await readyPromise
    expect(ready).not.toBeNull()
    expect(ready?.indexAvailable).toBe(false)
    expect(ready?.indexUnavailableReason).toBe('manifest.json fetch failed (HTTP 404)')
    const snapshot = client.getDiagnosticsSnapshot()
    // The MODEL loaded fine — only the index failed — so modelState is still 'ready', not
    // 'failed'; a real-device reader must be able to tell these apart (prompt §12).
    expect(snapshot.modelState).toBe('ready')
    expect(snapshot.backendDiagnostics?.modelLoad).toBe('success')
    expect(snapshot.backendDiagnostics?.indexLoad).toBe('failed')
  })

  it('R12: a full success reports the actual backend and card count, not a placeholder', async () => {
    vi.stubGlobal('Worker', FakeWorker)
    const client = new VisualRecognitionClient()
    const readyPromise = client.ensureReady()
    const worker = latestWorker()
    worker.emit('message', { data: readyMessage({ backend: 'webgpu', cardCount: 19501 }) })
    const ready = await readyPromise
    expect(ready?.backend).toBe('webgpu')
    expect(ready?.cardCount).toBe(19501)
    expect(ready?.indexSourceProjectRef).toBe('nopmkroeygmlvndzjjqs.supabase.co')
    const snapshot = client.getDiagnosticsSnapshot()
    expect(snapshot.modelState).toBe('ready')
    expect(snapshot.backendDiagnostics?.backendAttempts.webgpu).toBe('not-available')
  })

  it('R13: a worker crash (error event) reports a safe reason, not a generic string only', async () => {
    vi.stubGlobal('Worker', FakeWorker)
    const client = new VisualRecognitionClient()
    const readyPromise = client.ensureReady()
    const worker = latestWorker()
    worker.emit('error', {
      message: 'Uncaught ReferenceError: WebAssembly is not defined',
      filename: '/assets/visual-worker-BR9n2tz9.js',
      lineno: 42,
      colno: 7,
    })
    const ready = await readyPromise
    expect(ready).toBeNull()
    const snapshot = client.getDiagnosticsSnapshot()
    expect(snapshot.modelState).toBe('failed')
    expect(snapshot.unavailableReason).toContain(
      'Uncaught ReferenceError: WebAssembly is not defined',
    )
    expect(snapshot.unavailableReason).toContain('/assets/visual-worker-BR9n2tz9.js')
    expect(snapshot.unavailableReason).toContain('42')
    // Never a secret/token/auth field.
    expect(snapshot.unavailableReason?.toLowerCase()).not.toMatch(/token|password|service_role/)
  })

  it('R9 (client half): an invalid ?visualBackend= value is still passed through as-is — the worker normalizes it, not the client', () => {
    vi.stubGlobal('Worker', FakeWorker)
    const client = new VisualRecognitionClient()
    void client.ensureReady()
    const worker = latestWorker()
    expect(worker.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'init', backendOverride: 'auto' }),
    )
  })
})

describe('VisualRecognitionClient — P87 F-01/F-22/§6 index-integrity diagnostics relay', () => {
  it('relays the content id, source-project expectation/match, and runtime checksum fields verbatim', async () => {
    vi.stubGlobal('Worker', FakeWorker)
    const client = new VisualRecognitionClient()
    const readyPromise = client.ensureReady()
    const worker = latestWorker()
    worker.emit('message', {
      data: readyMessage({
        indexContentId: 'deadbeefcafef00d',
        indexSourceProjectExpected: 'nopmkroeygmlvndzjjqs.supabase.co',
        indexSourceProjectMatch: true,
        indexRuntimeChecksumVerified: true,
        indexRuntimeChecksumMs: 37,
      }),
    })
    const ready = await readyPromise
    expect(ready?.indexContentId).toBe('deadbeefcafef00d')
    expect(ready?.indexSourceProjectExpected).toBe('nopmkroeygmlvndzjjqs.supabase.co')
    expect(ready?.indexSourceProjectMatch).toBe(true)
    expect(ready?.indexRuntimeChecksumVerified).toBe(true)
    expect(ready?.indexRuntimeChecksumMs).toBe(37)
  })

  it('a rejected index (source-project mismatch) reports indexAvailable=false with the mismatch visible', async () => {
    vi.stubGlobal('Worker', FakeWorker)
    const client = new VisualRecognitionClient()
    const readyPromise = client.ensureReady()
    const worker = latestWorker()
    worker.emit('message', {
      data: readyMessage({
        indexAvailable: false,
        cardCount: 0,
        indexLoad: 'failed',
        indexSourceProjectRef: 'some-other-project.supabase.co',
        indexSourceProjectExpected: 'nopmkroeygmlvndzjjqs.supabase.co',
        indexSourceProjectMatch: false,
        indexContentId: null,
        indexUnavailableReason: 'manifest sourceProjectRef mismatch',
      }),
    })
    const ready = await readyPromise
    expect(ready?.indexAvailable).toBe(false)
    expect(ready?.indexSourceProjectMatch).toBe(false)
    expect(ready?.indexUnavailableReason).toContain('sourceProjectRef mismatch')
  })
})

describe('VisualRecognitionClient — getExpectedCardRank (P84, ported P87)', () => {
  it('returns null without constructing a Worker when ensureReady/analyze was never called', async () => {
    vi.stubGlobal('Worker', FakeWorker)
    const client = new VisualRecognitionClient()
    const result = await client.getExpectedCardRank('some-card-id')
    expect(result).toBeNull()
    expect(FakeWorker.instances.length).toBe(0)
  })

  it('sends a get-expected-rank request and resolves the matching response by requestId', async () => {
    vi.stubGlobal('Worker', FakeWorker)
    const client = new VisualRecognitionClient()
    const readyPromise = client.ensureReady()
    const worker = latestWorker()
    worker.emit('message', { data: readyMessage() })
    await readyPromise

    const rankPromise = client.getExpectedCardRank('card-42')
    const call = worker.postMessage.mock.calls.find(
      (call) => (call[0] as { type: string }).type === 'get-expected-rank',
    )
    expect(call).toBeDefined()
    const requestId = (call?.[0] as { requestId: number }).requestId
    worker.emit('message', {
      data: {
        type: 'expected-rank',
        requestId,
        found: true,
        rank: 7,
        similarity: 0.91,
        totalCards: 19501,
        inTop20: true,
        inTop100: true,
        indexContentId: '0123456789abcdef',
      },
    })
    const result = await rankPromise
    expect(result).toEqual({
      found: true,
      rank: 7,
      similarity: 0.91,
      totalCards: 19501,
      inTop20: true,
      inTop100: true,
      indexContentId: '0123456789abcdef',
      // P90 §21: this class only answers the visual-only question; controller.ts fills these in.
      hybridRank: null,
      hybridScore: null,
      hybridTier: null,
      scoreComponents: [],
      // N-08 (P94): same defer-to-controller.ts shape — this class has no catalog-enrichment
      // concept at all, so it always answers 'not-in-index' here.
      enrichmentStatus: 'not-in-index',
    })
  })

  it('a not-found rank lookup resolves with found=false and null rank/similarity, never throws', async () => {
    vi.stubGlobal('Worker', FakeWorker)
    const client = new VisualRecognitionClient()
    const readyPromise = client.ensureReady()
    const worker = latestWorker()
    worker.emit('message', { data: readyMessage() })
    await readyPromise

    const rankPromise = client.getExpectedCardRank('unknown-card')
    const call = worker.postMessage.mock.calls.find(
      (call) => (call[0] as { type: string }).type === 'get-expected-rank',
    )
    const requestId = (call?.[0] as { requestId: number }).requestId
    worker.emit('message', {
      data: {
        type: 'expected-rank',
        requestId,
        found: false,
        rank: null,
        similarity: null,
        totalCards: 19501,
        inTop20: false,
        inTop100: false,
        indexContentId: '0123456789abcdef',
      },
    })
    await expect(rankPromise).resolves.toEqual({
      found: false,
      rank: null,
      similarity: null,
      totalCards: 19501,
      inTop20: false,
      inTop100: false,
      indexContentId: '0123456789abcdef',
      hybridRank: null,
      hybridScore: null,
      hybridTier: null,
      scoreComponents: [],
      enrichmentStatus: 'not-in-index',
    })
  })

  it('dispose() clears any in-flight rank request bookkeeping without throwing', async () => {
    vi.stubGlobal('Worker', FakeWorker)
    const client = new VisualRecognitionClient()
    const readyPromise = client.ensureReady()
    const worker = latestWorker()
    worker.emit('message', { data: readyMessage() })
    await readyPromise
    void client.getExpectedCardRank('card-x')
    expect(() => {
      client.dispose()
    }).not.toThrow()
  })
})

describe('VisualRecognitionClient — P81 prewarm and cold-start diagnostics', () => {
  it('P81-1/P81-6: prewarm() and ensureReady() share ONE in-flight/settled init — only one Worker is ever constructed', async () => {
    vi.stubGlobal('Worker', FakeWorker)
    const client = new VisualRecognitionClient()
    const [prewarmPromise, readyPromise] = [client.prewarm(), client.ensureReady()]
    expect(FakeWorker.instances).toHaveLength(1)
    latestWorker().emit('message', { data: readyMessage() })
    await Promise.all([prewarmPromise, readyPromise])
    // A later call, after settlement, still does not construct a second Worker.
    await client.prewarm()
    await client.ensureReady()
    expect(FakeWorker.instances).toHaveLength(1)
  })

  it('P81-2: prewarm() posts init and resolves independently of any capture/analyze() call', async () => {
    vi.stubGlobal('Worker', FakeWorker)
    const client = new VisualRecognitionClient()
    const prewarmPromise = client.prewarm()
    const worker = latestWorker()
    expect(worker.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'init' }))
    worker.emit('message', { data: readyMessage() })
    const info = await prewarmPromise
    expect(info?.backend).toBe('wasm')
  })

  it("P81-9/§17: a ready message's phaseTimings are relayed verbatim through getDiagnosticsSnapshot()", async () => {
    vi.stubGlobal('Worker', FakeWorker)
    const client = new VisualRecognitionClient()
    const readyPromise = client.ensureReady()
    latestWorker().emit('message', {
      data: readyMessage({ phaseTimings: samplePhaseTimings({ modelOnnxFetchMs: 5000 }) }),
    })
    await readyPromise
    const snapshot = client.getDiagnosticsSnapshot()
    expect(snapshot.backendDiagnostics?.phaseTimings.modelOnnxFetchMs).toBe(5000)
    expect(snapshot.backendDiagnostics?.phaseTimings.visualReadyTotalMs).toBe(972)
  })

  it("§17 FIRST_EMBED_MS: reports only the FIRST successful analyze() round trip's duration", async () => {
    vi.stubGlobal('Worker', FakeWorker)
    const client = new VisualRecognitionClient()
    const readyPromise = client.ensureReady()
    const worker = latestWorker()
    worker.emit('message', { data: readyMessage() })
    await readyPromise
    expect(client.getDiagnosticsSnapshot().firstEmbedMs).toBeNull()

    const bitmap = { close: vi.fn() } as unknown as ImageBitmap
    const analyzePromise = client.analyze(bitmap, 30)
    // analyze() awaits ensureReady() (already settled, but still a real microtask hop) before it
    // calls postMessage — flush the event loop with a real macrotask so the "embed-and-search"
    // postMessage call has actually happened before we read it back.
    await new Promise((resolve) => setTimeout(resolve, 0))
    const lastCall = worker.postMessage.mock.calls.at(-1)?.[0] as {
      type: string
      requestId: number
    }
    expect(lastCall.type).toBe('embed-and-search')
    worker.emit('message', {
      data: {
        type: 'result',
        requestId: lastCall.requestId,
        hits: [],
        embedMs: 4,
        searchMs: 1,
        embeddingNorm: 3,
      },
    })
    await analyzePromise
    const firstEmbedMs = client.getDiagnosticsSnapshot().firstEmbedMs
    expect(firstEmbedMs).not.toBeNull()
    expect(firstEmbedMs).toBeGreaterThanOrEqual(0)
  })

  it('P90 §9: converts the bitmap to RGBA on the main thread and closes it itself when the worker cannot (offscreenCanvasAvailableInWorker: false)', async () => {
    vi.stubGlobal('Worker', FakeWorker)
    const fakeImageData = { data: new Uint8ClampedArray(4 * 8 * 8) }
    const fakeContext = { drawImage: vi.fn(), getImageData: vi.fn().mockReturnValue(fakeImageData) }
    class FakeOffscreenCanvas {
      width: number
      height: number
      constructor(width: number, height: number) {
        this.width = width
        this.height = height
      }
      getContext(): typeof fakeContext {
        return fakeContext
      }
    }
    vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas)

    const client = new VisualRecognitionClient()
    const readyPromise = client.ensureReady()
    const worker = latestWorker()
    worker.emit('message', { data: readyMessage({ offscreenCanvasAvailableInWorker: false }) })
    await readyPromise

    const close = vi.fn()
    const bitmap = { width: 8, height: 8, close } as unknown as ImageBitmap
    const analyzePromise = client.analyze(bitmap, 30)
    await new Promise((resolve) => setTimeout(resolve, 0))

    // The main thread did the conversion itself (never the worker's own OffscreenCanvas path) and
    // closed the source bitmap immediately after, exactly like the fast path's transfer-and-forget
    // — no lingering reference either way.
    expect(fakeContext.drawImage).toHaveBeenCalledWith(bitmap, 0, 0)
    expect(close).toHaveBeenCalledTimes(1)

    const [lastMessage, transferList] = worker.postMessage.mock.calls.at(-1) as [
      { type: string; requestId: number; image: { kind: string; buffer?: ArrayBuffer } },
      Transferable[],
    ]
    expect(lastMessage.type).toBe('embed-and-search')
    expect(lastMessage.image.kind).toBe('rgba')
    expect(transferList).toEqual([lastMessage.image.buffer])

    worker.emit('message', {
      data: {
        type: 'result',
        requestId: lastMessage.requestId,
        hits: [],
        embedMs: 1,
        searchMs: 1,
        embeddingNorm: 1,
      },
    })
    await analyzePromise
  })
})

describe('VisualRecognitionClient — P82 live progress instrumentation', () => {
  it('P82-1/P82-5: worker-boot progress arrives (and is observable) before processor/model completion', async () => {
    vi.stubGlobal('Worker', FakeWorker)
    const client = new VisualRecognitionClient()
    const readyPromise = client.ensureReady()
    const worker = latestWorker()

    // Nothing has arrived yet: distinguishable from "booted but stuck" (P82 §4).
    let snapshot = client.getDiagnosticsSnapshot()
    expect(snapshot.liveProgress.workerBooted).toBe(false)
    expect(snapshot.liveProgress.currentPhase).toBeNull()

    worker.emit('message', {
      data: { type: 'progress', phase: 'worker-module-evaluated', atMs: 1_000_100 },
    })
    snapshot = client.getDiagnosticsSnapshot()
    expect(snapshot.liveProgress.workerBooted).toBe(true)
    expect(snapshot.liveProgress.workerBootMs).not.toBeNull()
    expect(snapshot.liveProgress.currentPhase).toBe('worker-module-evaluated')
    // The worker has not reported ready/unavailable at all yet — this is exactly the gap P81 left.
    expect(snapshot.modelState).toBe('loading')

    worker.emit('message', { data: readyMessage() })
    await readyPromise
  })

  it('P82-2/P82-3: a stalled processor/model phase remains observable via the live progress snapshot', () => {
    vi.stubGlobal('Worker', FakeWorker)
    const client = new VisualRecognitionClient()
    void client.ensureReady()
    const worker = latestWorker()
    worker.emit('message', {
      data: { type: 'progress', phase: 'worker-module-evaluated', atMs: 2_000_000 },
    })
    worker.emit('message', {
      data: { type: 'progress', phase: 'processor-load-started', atMs: 2_000_050 },
    })
    let snapshot = client.getDiagnosticsSnapshot()
    expect(snapshot.liveProgress.currentPhase).toBe('processor-load-started')
    expect(snapshot.modelState).toBe('loading')

    // Later: the worker is now stuck attempting the WASM backend — still no ready/unavailable.
    worker.emit('message', {
      data: { type: 'progress', phase: 'wasm-attempt-started', atMs: 2_000_900 },
    })
    snapshot = client.getDiagnosticsSnapshot()
    expect(snapshot.liveProgress.currentPhase).toBe('wasm-attempt-started')
    expect(snapshot.modelState).toBe('loading')
  })

  it('P82-4: the live progress snapshot answers "WORKER_CONSTRUCTED_BUT_NO_BOOT_MESSAGE" honestly when nothing has arrived', () => {
    vi.stubGlobal('Worker', FakeWorker)
    const client = new VisualRecognitionClient()
    void client.ensureReady()
    const snapshot = client.getDiagnosticsSnapshot()
    expect(snapshot.liveProgress.workerBooted).toBe(false)
    expect(snapshot.liveProgress.workerBootMs).toBeNull()
    expect(snapshot.liveProgress.currentPhase).toBeNull()
  })

  it("P82-5: a terminal 'ready' message still leaves the live progress snapshot's own phase timings intact", async () => {
    vi.stubGlobal('Worker', FakeWorker)
    const client = new VisualRecognitionClient()
    const readyPromise = client.ensureReady()
    const worker = latestWorker()
    worker.emit('message', {
      data: { type: 'progress', phase: 'worker-module-evaluated', atMs: 3_000_000 },
    })
    worker.emit('message', { data: readyMessage() })
    await readyPromise
    const snapshot = client.getDiagnosticsSnapshot()
    expect(snapshot.modelState).toBe('ready')
    expect(snapshot.liveProgress.workerBooted).toBe(true)
    expect(snapshot.backendDiagnostics?.phaseTimings.visualReadyTotalMs).toBe(972)
  })

  it('dispose() clears the live progress snapshot back to an honest all-null state', async () => {
    vi.stubGlobal('Worker', FakeWorker)
    const client = new VisualRecognitionClient()
    const readyPromise = client.ensureReady()
    const worker = latestWorker()
    worker.emit('message', {
      data: { type: 'progress', phase: 'worker-module-evaluated', atMs: 4_000_000 },
    })
    worker.emit('message', { data: readyMessage() })
    await readyPromise
    client.dispose()
    const snapshot = client.getDiagnosticsSnapshot()
    expect(snapshot.liveProgress.workerBooted).toBe(false)
    expect(snapshot.liveProgress.currentPhase).toBeNull()
  })
})
