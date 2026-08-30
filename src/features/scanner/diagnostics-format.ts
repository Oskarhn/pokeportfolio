/**
 * Plain-text rendering of one scan's {@link ScannerDiagnostics} (P77 prompt §13/§14) — the exact
 * shape the debug panel's "Copy diagnostics" button copies to the clipboard, so the owner can
 * paste one failed real-device scan straight into a review session. Pure and deterministic so it
 * is unit-testable without a DOM; the panel itself only renders these lines.
 *
 * Deliberately excludes anything the prompt marks unsafe to copy: no photo, no tokens, no
 * Supabase key, no email, no user id, no full auth state — every field here already lives on
 * {@link ScannerDiagnostics}, which itself never carries any of those.
 */
import type { ScannerDiagnostics } from './contract'

const EMPTY = '—'

function num(value: number | null): string {
  return value === null ? EMPTY : String(value)
}

export function formatScannerDiagnostics(d: ScannerDiagnostics): string {
  const lines: string[] = [
    `VISUAL_MODEL_STATE=${d.visualModelState}`,
    `VISUAL_BACKEND_REQUESTED=${d.visualBackendRequested}`,
    'VISUAL_BACKEND_ATTEMPTS:',
    `  webgpu: ${d.visualBackendAttempts.webgpu}`,
    `  wasm: ${d.visualBackendAttempts.wasm}`,
    `VISUAL_BACKEND=${d.visualBackend}`,
    `WEBGPU_ERROR=${d.webgpuError ?? EMPTY}`,
    `WASM_ERROR=${d.wasmError ?? EMPTY}`,
    `PROCESSOR_LOAD=${d.processorLoad ?? EMPTY}`,
    `MODEL_LOAD=${d.modelLoad ?? EMPTY}`,
    `INDEX_LOAD=${d.indexLoadStatus ?? EMPTY}`,
    `MODEL_LOAD_MS=${num(d.modelLoadMs)}`,
    `VISUAL_PREWARM_STARTED=${d.visualPrewarmStarted ? 'yes' : 'no'}`,
    `VISUAL_PREWARM_READY_BEFORE_CAPTURE=${d.visualPrewarmReadyBeforeCapture ? 'yes' : 'no'}`,
    `OCR_PREPARE_MS=${num(d.ocrPrepareMs)}`,
    `FIRST_EMBED_MS=${num(d.firstEmbedMs)}`,
    `ASSET_CACHE_STATUS=${d.assetCacheStatus}`,
    'VISUAL_PHASE_TIMINGS:',
    ...(d.visualPhaseTimings === null
      ? [`  ${EMPTY}`]
      : [
          `  VISUAL_WORKER_START_MS=${num(d.visualPhaseTimings.workerStartMs)}`,
          `  PROCESSOR_FETCH_MS=${String(d.visualPhaseTimings.processorFetchMs)}`,
          `  PROCESSOR_INIT_MS=${String(d.visualPhaseTimings.processorInitMs)}`,
          `  MODEL_CONFIG_FETCH_MS=${String(d.visualPhaseTimings.modelConfigFetchMs)}`,
          `  MODEL_ONNX_FETCH_MS=${String(d.visualPhaseTimings.modelOnnxFetchMs)}`,
          `  MODEL_ONNX_BYTES=${num(d.visualPhaseTimings.modelOnnxBytes)}`,
          `  ORT_RUNTIME_FETCH_MS=${String(d.visualPhaseTimings.ortRuntimeFetchMs)}`,
          `  ORT_WASM_FETCH_MS=${String(d.visualPhaseTimings.ortWasmFetchMs)}`,
          `  ORT_WASM_BYTES=${num(d.visualPhaseTimings.ortWasmBytes)}`,
          `  MODEL_COMPILE_AND_SESSION_CREATE_MS=${String(d.visualPhaseTimings.modelCompileAndSessionCreateMs)}`,
          `  INDEX_MANIFEST_FETCH_MS=${String(d.visualPhaseTimings.indexManifestFetchMs)}`,
          `  INDEX_IDS_FETCH_MS=${String(d.visualPhaseTimings.indexIdsFetchMs)}`,
          `  INDEX_EMBEDDINGS_FETCH_MS=${String(d.visualPhaseTimings.indexEmbeddingsFetchMs)}`,
          `  INDEX_EMBEDDINGS_BYTES=${num(d.visualPhaseTimings.indexEmbeddingsBytes)}`,
          `  INDEX_DECODE_MS=${num(d.visualPhaseTimings.indexDecodeMs)}`,
          `  VISUAL_READY_TOTAL_MS=${String(d.visualPhaseTimings.visualReadyTotalMs)}`,
        ]),
    `CAPTURE_FRAME_DIMENSIONS=${d.captureFrameWidth ?? EMPTY}x${d.captureFrameHeight ?? EMPTY}`,
    `CAPTURE_CROP_DIMENSIONS=${d.captureCropWidth ?? EMPTY}x${d.captureCropHeight ?? EMPTY}`,
    `RECTIFICATION_USED=${d.rectificationUsed ? 'yes' : 'no'}`,
    `VISUAL_EMBEDDING_CREATED=${d.visualEmbeddingCreated ? 'yes' : 'no'}`,
    `EMBEDDING_NORM=${d.embeddingNorm === null ? EMPTY : d.embeddingNorm.toFixed(4)}`,
    `INDEX_VERSION=${d.indexVersion ?? EMPTY}`,
    `INDEX_CARD_COUNT=${num(d.indexCardCount)}`,
    `INDEX_SOURCE_PROJECT_REF=${d.indexSourceProjectRef ?? EMPTY}`,
    `INDEX_LOAD_MS=${num(d.indexLoadMs)}`,
    `INDEX_SEARCH_MS=${num(d.indexSearchMs)}`,
    'TOP_VISUAL_CANDIDATES:',
  ]
  if (d.topVisualCandidates.length === 0) {
    lines.push(`  ${EMPTY}`)
  } else {
    d.topVisualCandidates.forEach((c, i) => {
      lines.push(
        `  ${String(i + 1)}. ${c.cardId} similarity=${c.similarity.toFixed(4)} name=${c.name ?? EMPTY}`,
      )
    })
  }
  if (d.topVisualCandidatesExtended.length > 0) {
    lines.push('TOP_20_VISUAL_CANDIDATES:')
    d.topVisualCandidatesExtended.forEach((c, i) => {
      lines.push(
        `  ${String(i + 1)}. ${c.cardId} similarity=${c.similarity.toFixed(4)} name=${c.name ?? EMPTY}`,
      )
    })
  }
  lines.push(
    `OCR_NAME_SIGNAL=${d.ocrNameSignal ?? EMPTY}`,
    `OCR_NAME_ROI=${d.ocrNameRoiId ?? EMPTY}`,
    `OCR_COLLECTOR_SIGNAL=${d.ocrCollectorSignal ?? EMPTY}`,
    `OCR_NUMBER_ROI=${d.ocrNumberRoiId ?? EMPTY}`,
    `CANDIDATE_EXPANSION_TRIGGERED=${d.candidateExpansionTriggered ? 'yes' : 'no'}`,
    'FINAL_RERANKED_CANDIDATES:',
  )
  if (d.finalRerankedCandidates.length === 0) {
    lines.push(`  ${EMPTY}`)
  } else {
    d.finalRerankedCandidates.forEach((c, i) => {
      lines.push(
        `  ${String(i + 1)}. ${c.cardId} "${c.name}" tier=${c.confidenceTier} reasons=${
          c.reasons.length > 0 ? c.reasons.join(',') : EMPTY
        }`,
      )
    })
  }
  lines.push(`VISUAL_ERROR=${d.visualError ?? EMPTY}`)
  return lines.join('\n')
}
