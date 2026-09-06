import { describe, expect, it, vi } from 'vitest'
import {
  selectVisualBackend,
  composeUnavailableReason,
  normalizeBackendOverride,
} from '../../../src/domain/scanner/visual-backend-selection'

/**
 * P78 regression suite for the WebGPU→WASM fallback orchestration (prompt R2-R9). Pure logic,
 * fully mocked deps — no Worker, no transformers.js, no real GPU/WASM runtime involved. The real
 * root causes of the P78 real-device failure (env.allowLocalModels, CSP script-src) live
 * elsewhere (visual-worker.ts, vite.config.ts); this file only covers the fallback DECISION.
 */

function ok(): Promise<{ ok: true }> {
  return Promise.resolve({ ok: true })
}
function fail(error: string): Promise<{ ok: false; error: string }> {
  return Promise.resolve({ ok: false, error })
}

describe('normalizeBackendOverride', () => {
  it('accepts wasm and webgpu verbatim', () => {
    expect(normalizeBackendOverride('wasm')).toBe('wasm')
    expect(normalizeBackendOverride('webgpu')).toBe('webgpu')
  })

  it('R9: any other value, including garbage, falls back to auto', () => {
    for (const value of [undefined, null, '', 'AUTO', 'gpu', 123, {}, 'wasm ']) {
      expect(normalizeBackendOverride(value)).toBe('auto')
    }
  })
})

describe('selectVisualBackend', () => {
  it('R2: auto tries webgpu first when an adapter is available, and uses it on success', async () => {
    const loadModel = vi
      .fn()
      .mockImplementation((device: 'webgpu' | 'wasm') =>
        device === 'webgpu' ? ok() : fail('should not be called'),
      )
    const result = await selectVisualBackend('auto', {
      detectWebgpuAvailable: () => Promise.resolve(true),
      loadModel,
    })
    expect(result.chosen).toBe('webgpu')
    expect(result.attempts).toEqual({ webgpu: 'success', wasm: 'not-attempted' })
    expect(loadModel).toHaveBeenCalledTimes(1)
  })

  it('R3: a successful webgpu load never triggers a wasm load too', async () => {
    const loadModel = vi.fn().mockImplementation(() => ok())
    await selectVisualBackend('auto', {
      detectWebgpuAvailable: () => Promise.resolve(true),
      loadModel,
    })
    expect(loadModel).toHaveBeenCalledTimes(1)
    expect(loadModel).toHaveBeenCalledWith('webgpu')
  })

  it('R4: webgpu adapter unavailable falls straight to wasm under auto', async () => {
    const loadModel = vi.fn().mockImplementation(() => ok())
    const result = await selectVisualBackend('auto', {
      detectWebgpuAvailable: () => Promise.resolve(false),
      loadModel,
    })
    expect(result.chosen).toBe('wasm')
    expect(result.attempts).toEqual({ webgpu: 'not-available', wasm: 'success' })
    expect(loadModel).toHaveBeenCalledTimes(1)
    expect(loadModel).toHaveBeenCalledWith('wasm')
  })

  it('R2/R5: a webgpu INIT failure (adapter present, load throws) retries on wasm and succeeds', async () => {
    const loadModel = vi
      .fn()
      .mockImplementation((device: 'webgpu' | 'wasm') =>
        device === 'webgpu' ? fail('no available backend found') : ok(),
      )
    const result = await selectVisualBackend('auto', {
      detectWebgpuAvailable: () => Promise.resolve(true),
      loadModel,
    })
    expect(result.chosen).toBe('wasm')
    expect(result.attempts).toEqual({ webgpu: 'failed', wasm: 'success' })
    expect(result.webgpuError).toBe('no available backend found')
    expect(loadModel).toHaveBeenNthCalledWith(1, 'webgpu')
    expect(loadModel).toHaveBeenNthCalledWith(2, 'wasm')
  })

  it('R5: wasm failure (after webgpu unavailable) is a final, attributable failure', async () => {
    const loadModel = vi.fn().mockImplementation(() => fail('out of memory'))
    const result = await selectVisualBackend('auto', {
      detectWebgpuAvailable: () => Promise.resolve(false),
      loadModel,
    })
    expect(result.chosen).toBeNull()
    expect(result.attempts).toEqual({ webgpu: 'not-available', wasm: 'failed' })
    expect(result.wasmError).toBe('out of memory')
  })

  it('R6: both webgpu and wasm failing retains BOTH reasons, not just the last one', async () => {
    const loadModel = vi
      .fn()
      .mockImplementation((device: 'webgpu' | 'wasm') =>
        device === 'webgpu' ? fail('webgpu boom') : fail('wasm boom'),
      )
    const result = await selectVisualBackend('auto', {
      detectWebgpuAvailable: () => Promise.resolve(true),
      loadModel,
    })
    expect(result.chosen).toBeNull()
    expect(result.attempts).toEqual({ webgpu: 'failed', wasm: 'failed' })
    expect(result.webgpuError).toBe('webgpu boom')
    expect(result.wasmError).toBe('wasm boom')
  })

  it('R7: force wasm never probes for a webgpu adapter at all', async () => {
    const detectWebgpuAvailable = vi.fn().mockResolvedValue(true)
    const loadModel = vi.fn().mockImplementation(() => ok())
    const result = await selectVisualBackend('wasm', { detectWebgpuAvailable, loadModel })
    expect(detectWebgpuAvailable).not.toHaveBeenCalled()
    expect(result.chosen).toBe('wasm')
    expect(result.attempts).toEqual({ webgpu: 'not-attempted', wasm: 'success' })
    expect(loadModel).toHaveBeenCalledTimes(1)
    expect(loadModel).toHaveBeenCalledWith('wasm')
  })

  it('R8: force webgpu failing does NOT silently fall back to wasm', async () => {
    const loadModel = vi
      .fn()
      .mockImplementation((device: 'webgpu' | 'wasm') =>
        device === 'webgpu' ? fail('webgpu explicit failure') : ok(),
      )
    const result = await selectVisualBackend('webgpu', {
      detectWebgpuAvailable: () => Promise.resolve(true),
      loadModel,
    })
    expect(result.chosen).toBeNull()
    expect(result.attempts).toEqual({ webgpu: 'failed', wasm: 'not-attempted' })
    expect(result.webgpuError).toBe('webgpu explicit failure')
    // wasm must never even be attempted under an explicit webgpu force.
    expect(loadModel).toHaveBeenCalledTimes(1)
  })

  it('R8: force webgpu with no adapter available is also a clean failure, no wasm fallback', async () => {
    const loadModel = vi.fn().mockImplementation(() => ok())
    const result = await selectVisualBackend('webgpu', {
      detectWebgpuAvailable: () => Promise.resolve(false),
      loadModel,
    })
    expect(result.chosen).toBeNull()
    expect(result.attempts).toEqual({ webgpu: 'not-available', wasm: 'not-attempted' })
    expect(loadModel).not.toHaveBeenCalled()
  })
})

describe('composeUnavailableReason', () => {
  it('names the single failed backend when only one was attempted', () => {
    expect(
      composeUnavailableReason({ webgpu: 'not-available', wasm: 'failed' }, null, 'disk full'),
    ).toBe('model load failed: wasm: disk full')
  })

  it('R6: names BOTH backends when both were attempted and failed', () => {
    expect(
      composeUnavailableReason({ webgpu: 'failed', wasm: 'failed' }, 'gpu gone', 'wasm gone'),
    ).toBe('model load failed: webgpu: gpu gone; wasm: wasm gone')
  })

  it('never fabricates a reason when nothing was actually attempted', () => {
    expect(
      composeUnavailableReason({ webgpu: 'not-available', wasm: 'not-attempted' }, null, null),
    ).toBe('model load failed: no backend available')
  })
})
