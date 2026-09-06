import { describe, expect, it } from 'vitest'
import {
  classifyVisualAssetUrl,
  summarizeFetchLog,
  nonNetworkRemainder,
  estimateAssetCacheStatus,
} from '../../src/features/scanner/visual/phase-timing'

/**
 * P81 §3/§17: pure classification/summarization logic behind the visual worker's cold-start
 * phase-attribution instrumentation. This is the primary evidence for the new fields — deployed
 * behaviour on a real iPhone cannot be exercised in CI, but the LOGIC that turns a raw fetch log
 * into per-phase numbers has a provable specification and is fully covered here.
 */

describe('classifyVisualAssetUrl', () => {
  it('classifies every asset path this worker actually requests', () => {
    expect(
      classifyVisualAssetUrl('/scanner-assets/visual-v1/model/onnx/model_quantized.onnx'),
    ).toBe('modelOnnx')
    expect(classifyVisualAssetUrl('/scanner-assets/visual-v1/model/config.json')).toBe(
      'modelConfig',
    )
    expect(classifyVisualAssetUrl('/scanner-assets/visual-v1/model/preprocessor_config.json')).toBe(
      'processorConfig',
    )
    expect(
      classifyVisualAssetUrl('/scanner-assets/visual-v1/ort/ort-wasm-simd-threaded.wasm'),
    ).toBe('ortWasm')
    expect(
      classifyVisualAssetUrl('/scanner-assets/visual-v1/ort/ort-wasm-simd-threaded.asyncify.wasm'),
    ).toBe('ortWasm')
    expect(classifyVisualAssetUrl('/scanner-assets/visual-v1/ort/ort-wasm-simd-threaded.mjs')).toBe(
      'ortRuntime',
    )
    expect(classifyVisualAssetUrl('/scanner-assets/visual-v1/manifest.json')).toBe('indexManifest')
    expect(classifyVisualAssetUrl('/scanner-assets/visual-v1/card-ids.json')).toBe('indexIds')
    expect(classifyVisualAssetUrl('/scanner-assets/visual-v1/embeddings.bin')).toBe(
      'indexEmbeddings',
    )
  })

  it('resolves an absolute origin-qualified URL the same way as a bare path', () => {
    expect(
      classifyVisualAssetUrl(
        'https://pokeportfolio.example/scanner-assets/visual-v1/embeddings.bin',
      ),
    ).toBe('indexEmbeddings')
  })

  it('ignores a query string when classifying (cache-busting must not break attribution)', () => {
    expect(classifyVisualAssetUrl('/scanner-assets/visual-v1/embeddings.bin?v=3')).toBe(
      'indexEmbeddings',
    )
  })

  it('falls back to "other" for anything unrecognized, never crashing or guessing', () => {
    expect(classifyVisualAssetUrl('/scanner-assets/v7/worker.min.js')).toBe('other')
    expect(classifyVisualAssetUrl('')).toBe('other')
  })
})

describe('summarizeFetchLog', () => {
  it('sums duration and bytes per phase, zeroing phases with no entries', () => {
    const summary = summarizeFetchLog([
      { phase: 'modelOnnx', ms: 500, bytes: 24451943 },
      { phase: 'ortWasm', ms: 300, bytes: 12942611 },
      { phase: 'indexEmbeddings', ms: 80, bytes: 7488384 },
    ])
    expect(summary.modelOnnx).toEqual({ ms: 500, bytes: 24451943 })
    expect(summary.ortWasm).toEqual({ ms: 300, bytes: 12942611 })
    expect(summary.processorConfig).toEqual({ ms: 0, bytes: null })
  })

  it('sums a phase fetched more than once instead of dropping either entry', () => {
    const summary = summarizeFetchLog([
      { phase: 'modelOnnx', ms: 400, bytes: 24451943 },
      { phase: 'modelOnnx', ms: 5, bytes: 24451943 }, // e.g. a WebGPU retry re-fetching the model
    ])
    expect(summary.modelOnnx).toEqual({ ms: 405, bytes: 48903886 })
  })

  it('keeps bytes null when the response never carried a Content-Length header', () => {
    const summary = summarizeFetchLog([{ phase: 'indexManifest', ms: 4, bytes: null }])
    expect(summary.indexManifest).toEqual({ ms: 4, bytes: null })
  })
})

describe('nonNetworkRemainder', () => {
  it('is the wall-clock time minus the network time already accounted for', () => {
    expect(nonNetworkRemainder(500, 300)).toBe(200)
  })

  it('floors at 0 rather than going negative under timer jitter', () => {
    expect(nonNetworkRemainder(100, 140)).toBe(0)
  })
})

describe('estimateAssetCacheStatus', () => {
  it('reports "unknown" when nothing has been measured yet', () => {
    expect(estimateAssetCacheStatus(null)).toBe('unknown')
  })

  it('reports "unknown" when byte counts were never observed (no Content-Length)', () => {
    expect(
      estimateAssetCacheStatus({
        modelOnnxFetchMs: 5,
        modelOnnxBytes: null,
        ortWasmFetchMs: 3,
        ortWasmBytes: null,
      }),
    ).toBe('unknown')
  })

  it('reports "likely-network" for a realistic multi-second download of tens of megabytes', () => {
    expect(
      estimateAssetCacheStatus({
        modelOnnxFetchMs: 4000,
        modelOnnxBytes: 24451943,
        ortWasmFetchMs: 3000,
        ortWasmBytes: 12942611,
      }),
    ).toBe('likely-network')
  })

  it('reports "likely-cache" when the same bytes resolve in a few milliseconds', () => {
    expect(
      estimateAssetCacheStatus({
        modelOnnxFetchMs: 2,
        modelOnnxBytes: 24451943,
        ortWasmFetchMs: 1,
        ortWasmBytes: 12942611,
      }),
    ).toBe('likely-cache')
  })
})
