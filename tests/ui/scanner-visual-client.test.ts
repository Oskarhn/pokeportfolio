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

function readyMessage(overrides: Record<string, unknown> = {}) {
  return {
    type: 'ready',
    backend: 'wasm',
    indexAvailable: true,
    cardCount: 19501,
    modelColdLoadMs: 972,
    indexVersion: 'visual-v1',
    indexSourceProjectRef: 'nopmkroeygmlvndzjjqs.supabase.co',
    indexLoadMs: 76,
    indexUnavailableReason: null,
    backendRequested: 'auto',
    backendAttempts: { webgpu: 'not-available', wasm: 'success' },
    webgpuError: null,
    wasmError: null,
    processorLoad: 'success',
    modelLoad: 'success',
    indexLoad: 'success',
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
