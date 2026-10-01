import { InferenceSession, Tensor } from 'onnxruntime-react-native'
import { preprocessRgbaForDino } from '@shared/domain/scanner/dino-preprocess'
import type { RgbaImage } from '@shared/domain/scanner/rectify'
import {
  decodeVisualIndex,
  l2Normalize,
  searchVisualIndex,
} from '@shared/data/scanner/visual-index'
import { loadScannerAssets } from './model-assets'
import { emitTrace, nowMs } from './scan-trace'

/**
 * Native ONNX Runtime wrapper around the EXACT web-scanner visual pipeline: the same pinned
 * DINOv2 model file (verified by hash, see model-assets.ts), the same `preprocessRgbaForDino`
 * tensor-construction code the web scanner's own non-canvas fallback path already uses
 * unmodified, and the same `decodeVisualIndex`/`searchVisualIndex` index format and search
 * algorithm. Only the RUNTIME differs: `onnxruntime-react-native`'s `InferenceSession` in place of
 * `@huggingface/transformers`' `AutoModel`.
 *
 * CPU execution provider only (not NNAPI): the pinned model is int8-quantized (D-097), and NNAPI's
 * quantized-op coverage on Android varies by device/OS version in a way this project cannot verify
 * without a device matrix it does not have — CPU is slower but its numerical behavior is uniform
 * and directly comparable to the web path's own WASM CPU execution, which is what fixture parity
 * (mission §25) is measured against. Recorded as a disclosed choice, not an oversight.
 */

export interface TimedEmbedding {
  readonly vector: Float32Array
  readonly preprocessMs: number
  readonly onnxMs: number
}

export interface VisualSession {
  embed(image: RgbaImage): Promise<Float32Array>
  /** Same embedding with the preprocess/ONNX split the performance gate reports (P184). */
  embedTimed(image: RgbaImage): Promise<TimedEmbedding>
  search(queryVector: Float32Array, topK: number): { cardId: string; similarity: number }[]
  dispose(): Promise<void>
}

/**
 * ONE model session per JS runtime, kept for the process lifetime on purpose: loading the 24 MB
 * model costs seconds, and P167 established that an Android Activity recreation keeps the same JS
 * runtime, so this module-level cache is also what prevents a duplicate session after a font-scale,
 * density or locale change. `createdSessions` counts real creations (the device driver asserts it
 * stays 1 across recreations).
 *
 * A FAILED creation is not cached here, so a transient error (out of memory, an I/O hiccup) does not
 * disable the scanner until the app is killed. An integrity failure still stays a refusal: the asset
 * loader (model-assets.ts) keeps that failure cached, so every retry re-throws it and no later scan
 * falls back to, or retries against, an asset that did not verify.
 */
let cachedSession: Promise<VisualSession> | null = null
let createdSessions = 0
// Sessions alive right now. The invariant (checked by the device drivers through the trace) is <= 1:
// the prewarm (recognition-pipeline.ts) and a scan share this cache, they never create their own.
let activeSessions = 0

export function getVisualSession(): Promise<VisualSession> {
  if (cachedSession !== null) {
    emitTrace({
      kind: 'session',
      action: 'reused',
      sessionCount: createdSessions,
      active: activeSessions,
    })
    return cachedSession
  }
  const pending = createVisualSession()
  cachedSession = pending
  pending.catch(() => {
    if (cachedSession === pending) cachedSession = null
  })
  return pending
}

export function visualSessionCreationCount(): number {
  return createdSessions
}

export function visualSessionActiveCount(): number {
  return activeSessions
}

async function createVisualSession(): Promise<VisualSession> {
  const startedAt = nowMs()
  emitTrace({
    kind: 'session',
    action: 'create_started',
    sessionCount: createdSessions,
    active: activeSessions,
  })
  let ortSession: InferenceSession
  let assets: Awaited<ReturnType<typeof loadScannerAssets>>
  // Time until the verified model and index were in memory (the rest of `ms` is the runtime start).
  let assetsMs: number
  try {
    assets = await loadScannerAssets()
    assetsMs = Math.round(nowMs() - startedAt)
    ortSession = await InferenceSession.create(assets.modelPath, {
      executionProviders: ['cpu'],
    })
  } catch (error) {
    emitTrace({
      kind: 'session',
      action: 'create_failed',
      sessionCount: createdSessions,
      active: activeSessions,
      ms: Math.round(nowMs() - startedAt),
    })
    throw error
  }
  const firstInputName = ortSession.inputNames[0]
  if (firstInputName === undefined) {
    await ortSession.release()
    throw new Error('Visual model exposes no input names.')
  }
  const inputName: string = firstInputName
  createdSessions += 1
  activeSessions += 1
  const index = decodeVisualIndex(assets.manifest, assets.cardIds, assets.embeddingsBytes)

  emitTrace({
    kind: 'session',
    action: 'created',
    sessionCount: createdSessions,
    active: activeSessions,
    ms: Math.round(nowMs() - startedAt),
    assetsMs,
  })

  async function embedTimed(image: RgbaImage): Promise<TimedEmbedding> {
    const preprocessStart = nowMs()
    const preprocessed = preprocessRgbaForDino(image)
    const tensor = new Tensor('float32', preprocessed.data, [1, ...preprocessed.dims])
    const preprocessMs = nowMs() - preprocessStart
    const onnxStart = nowMs()
    const outputs = await ortSession.run({ [inputName]: tensor })
    const outputName = ortSession.outputNames[0]
    if (outputName === undefined) throw new Error('Visual model produced no outputs.')
    const output = outputs[outputName]
    if (output === undefined) throw new Error('Visual model output missing from result map.')
    // The pinned model's last_hidden_state carries the [CLS] token embedding first — the same
    // slice the web scanner's visual-worker.ts takes (`.slice(0, EMBEDDING_DIM)`), unchanged.
    const raw = Float32Array.from(output.data as ArrayLike<number>).slice(
      0,
      assets.manifest.embeddingDim,
    )
    const vector = l2Normalize(raw)
    return { vector, preprocessMs, onnxMs: nowMs() - onnxStart }
  }

  let disposed = false
  return {
    embedTimed,
    async embed(image: RgbaImage): Promise<Float32Array> {
      return (await embedTimed(image)).vector
    },
    search(queryVector: Float32Array, topK: number) {
      return searchVisualIndex(index, queryVector, topK)
    },
    async dispose() {
      if (disposed) return
      disposed = true
      activeSessions -= 1
      // A disposed session must not stay cached: the next scan would run on a released runtime.
      cachedSession = null
      await ortSession.release()
      emitTrace({
        kind: 'session',
        action: 'released',
        sessionCount: createdSessions,
        active: activeSessions,
      })
    },
  }
}

/** Test-only: clears the module-level session cache between unit tests. */
export function __resetVisualSessionCacheForTests(): void {
  cachedSession = null
  createdSessions = 0
  activeSessions = 0
}
