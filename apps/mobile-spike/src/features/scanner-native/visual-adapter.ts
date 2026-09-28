import { InferenceSession, Tensor } from 'onnxruntime-react-native'
import { preprocessRgbaForDino } from '@shared/domain/scanner/dino-preprocess'
import type { RgbaImage } from '@shared/domain/scanner/rectify'
import {
  decodeVisualIndex,
  l2Normalize,
  searchVisualIndex,
} from '@shared/data/scanner/visual-index'
import { loadScannerAssets } from './model-assets'

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

export interface VisualSession {
  embed(image: RgbaImage): Promise<Float32Array>
  search(queryVector: Float32Array, topK: number): { cardId: string; similarity: number }[]
  dispose(): Promise<void>
}

let cachedSession: Promise<VisualSession> | null = null

export function getVisualSession(): Promise<VisualSession> {
  if (cachedSession === null) cachedSession = createVisualSession()
  return cachedSession
}

async function createVisualSession(): Promise<VisualSession> {
  const assets = await loadScannerAssets()
  const ortSession = await InferenceSession.create(assets.modelPath, {
    executionProviders: ['cpu'],
  })
  const index = decodeVisualIndex(assets.manifest, assets.cardIds, assets.embeddingsBytes)
  const inputName = ortSession.inputNames[0]
  if (inputName === undefined) {
    throw new Error('Visual model exposes no input names.')
  }

  return {
    async embed(image: RgbaImage): Promise<Float32Array> {
      const preprocessed = preprocessRgbaForDino(image)
      const tensor = new Tensor('float32', preprocessed.data, [1, ...preprocessed.dims])
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
      return l2Normalize(raw)
    },
    search(queryVector: Float32Array, topK: number) {
      return searchVisualIndex(index, queryVector, topK)
    },
    async dispose() {
      await ortSession.release()
    },
  }
}

/** Test-only: clears the module-level session cache between unit tests. */
export function __resetVisualSessionCacheForTests(): void {
  cachedSession = null
}
