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
    visualEmbeddingCreated: true,
    embeddingNorm: 12.3456,
    indexVersion: 'visual-v1',
    indexCardCount: 985,
    indexSourceProjectRef: 'nopmkroeygmlvndzjjqs.supabase.co',
    indexLoadMs: 15,
    indexSearchMs: 2,
    topVisualCandidates: [{ cardId: 'card-a', similarity: 0.91, name: 'Shieldon' }],
    ocrNameSignal: 'Shieldon',
    ocrCollectorSignal: '049/102',
    finalRerankedCandidates: [
      { cardId: 'card-a', name: 'Shieldon', confidenceTier: 'HIGH', reasons: ['visual-strong'] },
    ],
    visualError: null,
    ...overrides,
  }
}

describe('formatScannerDiagnostics', () => {
  it('renders every field as a labeled line', () => {
    const text = formatScannerDiagnostics(diagnostics())
    expect(text).toContain('VISUAL_MODEL_STATE=ready')
    expect(text).toContain('VISUAL_BACKEND=wasm')
    expect(text).toContain('MODEL_LOAD_MS=812')
    expect(text).toContain('CAPTURE_CROP_DIMENSIONS=640x896')
    expect(text).toContain('VISUAL_EMBEDDING_CREATED=yes')
    expect(text).toContain('EMBEDDING_NORM=12.3456')
    expect(text).toContain('INDEX_VERSION=visual-v1')
    expect(text).toContain('INDEX_CARD_COUNT=985')
    expect(text).toContain('INDEX_SOURCE_PROJECT_REF=nopmkroeygmlvndzjjqs.supabase.co')
    expect(text).toContain('1. card-a similarity=0.9100 name=Shieldon')
    expect(text).toContain('OCR_NAME_SIGNAL=Shieldon')
    expect(text).toContain('OCR_COLLECTOR_SIGNAL=049/102')
    expect(text).toContain('1. card-a "Shieldon" tier=HIGH reasons=visual-strong')
    expect(text).toContain('VISUAL_ERROR=—')
  })

  it('renders honest placeholders instead of fabricated values when fields are null/empty', () => {
    const text = formatScannerDiagnostics(
      diagnostics({
        modelLoadMs: null,
        captureCropWidth: null,
        captureCropHeight: null,
        embeddingNorm: null,
        indexVersion: null,
        indexCardCount: null,
        topVisualCandidates: [],
        finalRerankedCandidates: [],
        visualError: 'model load failed: out of memory',
      }),
    )
    expect(text).toContain('MODEL_LOAD_MS=—')
    expect(text).toContain('CAPTURE_CROP_DIMENSIONS=—x—')
    expect(text).toContain('EMBEDDING_NORM=—')
    expect(text).toContain('VISUAL_ERROR=model load failed: out of memory')
    // Never crashes or omits the section header on an empty list.
    expect(text).toContain('TOP_VISUAL_CANDIDATES:')
    expect(text).toContain('FINAL_RERANKED_CANDIDATES:')
  })

  it('never contains anything resembling a secret/token field name', () => {
    const text = formatScannerDiagnostics(diagnostics())
    expect(text.toLowerCase()).not.toMatch(/service_role|token|password|auth|email|user_id/)
  })
})
