import { describe, expect, it } from 'vitest'
import { formatScannerDiagnostics } from '../../src/features/scanner/diagnostics-format'
import type { ScannerDiagnostics } from '../../src/features/scanner/contract'

function diagnostics(overrides: Partial<ScannerDiagnostics> = {}): ScannerDiagnostics {
  return {
    visualModelState: 'ready',
    visualBackend: 'wasm',
    modelLoadMs: 812,
    captureCropWidth: 640,
    captureCropHeight: 896,
    captureFrameWidth: 1350,
    captureFrameHeight: 1800,
    rectificationUsed: true,
    visualEmbeddingCreated: true,
    embeddingNorm: 12.3456,
    indexVersion: 'visual-v1',
    indexCardCount: 985,
    indexSourceProjectRef: 'nopmkroeygmlvndzjjqs.supabase.co',
    indexLoadMs: 15,
    indexSearchMs: 2,
    topVisualCandidates: [{ cardId: 'card-a', similarity: 0.91, name: 'Shieldon' }],
    topVisualCandidatesExtended: [
      { cardId: 'card-a', similarity: 0.91, name: 'Shieldon', imageBaseUrl: null },
      { cardId: 'card-b', similarity: 0.77, name: 'Duskull', imageBaseUrl: null },
    ],
    ocrNameSignal: 'Shieldon',
    ocrNameRoiId: 'classic-top-left',
    ocrCollectorSignal: '049/102',
    ocrNumberRoiId: 'modern-bottom-left',
    candidateExpansionTriggered: false,
    finalRerankedCandidates: [
      { cardId: 'card-a', name: 'Shieldon', confidenceTier: 'HIGH', reasons: ['visual-strong'] },
    ],
    visualError: null,
    visualBackendRequested: 'auto',
    visualBackendAttempts: { webgpu: 'not-available', wasm: 'success' },
    webgpuError: null,
    wasmError: null,
    processorLoad: 'success',
    modelLoad: 'success',
    indexLoadStatus: 'success',
    ...overrides,
  }
}

describe('formatScannerDiagnostics', () => {
  it('renders every field as a labeled line', () => {
    const text = formatScannerDiagnostics(diagnostics())
    expect(text).toContain('VISUAL_MODEL_STATE=ready')
    expect(text).toContain('VISUAL_BACKEND_REQUESTED=auto')
    expect(text).toContain('webgpu: not-available')
    expect(text).toContain('wasm: success')
    expect(text).toContain('VISUAL_BACKEND=wasm')
    expect(text).toContain('WEBGPU_ERROR=—')
    expect(text).toContain('WASM_ERROR=—')
    expect(text).toContain('PROCESSOR_LOAD=success')
    expect(text).toContain('MODEL_LOAD=success')
    expect(text).toContain('INDEX_LOAD=success')
    expect(text).toContain('MODEL_LOAD_MS=812')
    expect(text).toContain('CAPTURE_FRAME_DIMENSIONS=1350x1800')
    expect(text).toContain('CAPTURE_CROP_DIMENSIONS=640x896')
    expect(text).toContain('RECTIFICATION_USED=yes')
    expect(text).toContain('TOP_20_VISUAL_CANDIDATES:')
    expect(text).toContain('2. card-b similarity=0.7700 name=Duskull')
    expect(text).toContain('VISUAL_EMBEDDING_CREATED=yes')
    expect(text).toContain('EMBEDDING_NORM=12.3456')
    expect(text).toContain('INDEX_VERSION=visual-v1')
    expect(text).toContain('INDEX_CARD_COUNT=985')
    expect(text).toContain('INDEX_SOURCE_PROJECT_REF=nopmkroeygmlvndzjjqs.supabase.co')
    expect(text).toContain('1. card-a similarity=0.9100 name=Shieldon')
    expect(text).toContain('OCR_NAME_SIGNAL=Shieldon')
    expect(text).toContain('OCR_NAME_ROI=classic-top-left')
    expect(text).toContain('OCR_COLLECTOR_SIGNAL=049/102')
    expect(text).toContain('OCR_NUMBER_ROI=modern-bottom-left')
    expect(text).toContain('CANDIDATE_EXPANSION_TRIGGERED=no')
    expect(text).toContain('1. card-a "Shieldon" tier=HIGH reasons=visual-strong')
    expect(text).toContain('VISUAL_ERROR=—')
  })

  it('renders honest placeholders for the P80 adaptive-ROI fields when nothing won', () => {
    const text = formatScannerDiagnostics(
      diagnostics({ ocrNameRoiId: null, ocrNumberRoiId: null, candidateExpansionTriggered: true }),
    )
    expect(text).toContain('OCR_NAME_ROI=—')
    expect(text).toContain('OCR_NUMBER_ROI=—')
    expect(text).toContain('CANDIDATE_EXPANSION_TRIGGERED=yes')
  })

  it('renders honest placeholders instead of fabricated values when fields are null/empty', () => {
    const text = formatScannerDiagnostics(
      diagnostics({
        modelLoadMs: null,
        captureCropWidth: null,
        captureCropHeight: null,
        captureFrameWidth: null,
        captureFrameHeight: null,
        rectificationUsed: false,
        embeddingNorm: null,
        indexVersion: null,
        indexCardCount: null,
        topVisualCandidates: [],
        topVisualCandidatesExtended: [],
        finalRerankedCandidates: [],
        visualError: 'model load failed: out of memory',
      }),
    )
    expect(text).toContain('MODEL_LOAD_MS=—')
    expect(text).toContain('CAPTURE_FRAME_DIMENSIONS=—x—')
    expect(text).toContain('CAPTURE_CROP_DIMENSIONS=—x—')
    expect(text).toContain('RECTIFICATION_USED=no')
    expect(text).toContain('EMBEDDING_NORM=—')
    expect(text).toContain('VISUAL_ERROR=model load failed: out of memory')
    // Never crashes or omits the section header on an empty list; an empty EXTENDED list simply
    // omits that optional section rather than printing an empty header.
    expect(text).toContain('TOP_VISUAL_CANDIDATES:')
    expect(text).toContain('FINAL_RERANKED_CANDIDATES:')
    expect(text).not.toContain('TOP_20_VISUAL_CANDIDATES:')
  })

  it('never contains anything resembling a secret/token field name', () => {
    const text = formatScannerDiagnostics(diagnostics())
    expect(text.toLowerCase()).not.toMatch(/service_role|token|password|auth|email|user_id/)
  })

  it('renders both backend errors when webgpu and wasm both failed (R6)', () => {
    const text = formatScannerDiagnostics(
      diagnostics({
        visualModelState: 'failed',
        visualBackend: 'unknown',
        visualBackendAttempts: { webgpu: 'failed', wasm: 'failed' },
        webgpuError: 'no available backend found',
        wasmError: 'out of memory',
        modelLoad: 'failed',
        indexLoadStatus: 'not-reached',
        visualError: 'model load failed: webgpu: no available backend found; wasm: out of memory',
      }),
    )
    expect(text).toContain('WEBGPU_ERROR=no available backend found')
    expect(text).toContain('WASM_ERROR=out of memory')
    expect(text).toContain('MODEL_LOAD=failed')
    expect(text).toContain('INDEX_LOAD=not-reached')
    expect(text).toContain(
      'VISUAL_ERROR=model load failed: webgpu: no available backend found; wasm: out of memory',
    )
  })
})
