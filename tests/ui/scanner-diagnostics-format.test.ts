import { describe, expect, it } from 'vitest'
import {
  formatScannerDiagnostics,
  formatExpectedCardRankDiagnostics,
} from '../../src/features/scanner/diagnostics-format'
import type { ExpectedCardRank, ScannerDiagnostics } from '../../src/features/scanner/contract'
import { APP_BUILD_SHA } from '../../src/platform/build-info'

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
    indexModelRevision: 'c2bb04a51fab207c420665f1946016107bffc701',
    indexGeneratedAt: '2026-09-01T00:00:00.000Z',
    indexEmbeddingsSha256: 'deadbeef',
    indexContentId: '0123456789abcdef',
    indexSourceProjectExpected: 'nopmkroeygmlvndzjjqs.supabase.co',
    indexSourceProjectMatch: true,
    indexRuntimeChecksumVerified: true,
    indexRuntimeChecksumMs: 41,
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
    ocrTrials: [],
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
    visualPhaseTimings: {
      workerStartMs: 42,
      processorFetchMs: 15,
      processorInitMs: 3,
      modelConfigFetchMs: 8,
      modelOnnxFetchMs: 610,
      modelOnnxBytes: 24451943,
      ortRuntimeFetchMs: 5,
      ortWasmFetchMs: 340,
      ortWasmBytes: 12942611,
      modelCompileAndSessionCreateMs: 220,
      indexManifestFetchMs: 4,
      indexIdsFetchMs: 30,
      indexEmbeddingsFetchMs: 90,
      indexEmbeddingsBytes: 7488384,
      indexDecodeMs: 25,
      visualReadyTotalMs: 812,
    },
    firstEmbedMs: 640,
    assetCacheStatus: 'likely-network',
    visualPrewarmStarted: true,
    visualPrewarmReadyBeforeCapture: true,
    ocrPrepareMs: 900,
    workerBooted: true,
    workerBootMs: 12,
    visualCurrentPhase: 'ready',
    visualCurrentPhaseElapsedMs: 4,
    visualLastProgressMsAgo: 4,
    fastScannerState: 'ready',
    ocrRuntimeState: 'ready',
    enhancedVisualState: 'ready',
    visualCalibrationBand: 'strong',
    ocrNameConfidence: 91,
    ocrCollectorConfidence: 88,
    ocrCollectorParseConfidence: 'high',
    ocrNameLexiconMatch: null,
    ocrNameLexiconMargin: null,
    visualTextDisagreement: false,
    tierCapReason: null,
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
    expect(text).toContain('VISUAL_CALIBRATION_BAND=strong')
    expect(text).toContain('OCR_NAME_CONFIDENCE=91')
    expect(text).toContain('OCR_NAME_LEXICON_MATCH=—')
    expect(text).toContain('OCR_NAME_LEXICON_MARGIN=—')
    expect(text).toContain('OCR_COLLECTOR_CONFIDENCE=88')
    expect(text).toContain('OCR_COLLECTOR_PARSE_CONFIDENCE=high')
    expect(text).toContain('card-a: visual-strong')
    expect(text).toContain('VISUAL_TEXT_DISAGREEMENT=no')
    expect(text).toContain('TIER_CAP_REASON=—')
  })

  it('P88 §21: renders a capped tier reason and disagreement flag when present', () => {
    const text = formatScannerDiagnostics(
      diagnostics({
        visualTextDisagreement: true,
        tierCapReason: 'visual-dominance-guarded',
        visualCalibrationBand: 'weak',
        ocrCollectorParseConfidence: 'low',
      }),
    )
    expect(text).toContain('VISUAL_TEXT_DISAGREEMENT=yes')
    expect(text).toContain('TIER_CAP_REASON=visual-dominance-guarded')
    expect(text).toContain('VISUAL_CALIBRATION_BAND=weak')
    expect(text).toContain('OCR_COLLECTOR_PARSE_CONFIDENCE=low')
  })

  it('renders P81 prewarm/timing fields and the full phase-timing block', () => {
    const text = formatScannerDiagnostics(diagnostics())
    expect(text).toContain('VISUAL_PREWARM_STARTED=yes')
    expect(text).toContain('VISUAL_PREWARM_READY_BEFORE_CAPTURE=yes')
    expect(text).toContain('OCR_PREPARE_MS=900')
    expect(text).toContain('FIRST_EMBED_MS=640')
    expect(text).toContain('ASSET_CACHE_STATUS=likely-network')
    expect(text).toContain('VISUAL_PHASE_TIMINGS:')
    expect(text).toContain('VISUAL_WORKER_START_MS=42')
    expect(text).toContain('MODEL_ONNX_FETCH_MS=610')
    expect(text).toContain('MODEL_ONNX_BYTES=24451943')
    expect(text).toContain('ORT_WASM_FETCH_MS=340')
    expect(text).toContain('ORT_WASM_BYTES=12942611')
    expect(text).toContain('MODEL_COMPILE_AND_SESSION_CREATE_MS=220')
    expect(text).toContain('INDEX_DECODE_MS=25')
    expect(text).toContain('VISUAL_READY_TOTAL_MS=812')
  })

  it('renders an honest placeholder when phase timings/prewarm fields are absent', () => {
    const text = formatScannerDiagnostics(
      diagnostics({
        visualPhaseTimings: null,
        firstEmbedMs: null,
        ocrPrepareMs: null,
        assetCacheStatus: 'unknown',
        visualPrewarmStarted: false,
        visualPrewarmReadyBeforeCapture: false,
      }),
    )
    expect(text).toContain('VISUAL_PREWARM_STARTED=no')
    expect(text).toContain('VISUAL_PREWARM_READY_BEFORE_CAPTURE=no')
    expect(text).toContain('OCR_PREPARE_MS=—')
    expect(text).toContain('FIRST_EMBED_MS=—')
    expect(text).toContain('ASSET_CACHE_STATUS=unknown')
    expect(text).toContain('VISUAL_PHASE_TIMINGS:\n  —')
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

  it('P83 S1/S2/§15: exposes the build SHA, and it appears before every scanner field', () => {
    const text = formatScannerDiagnostics(diagnostics())
    expect(text).toContain(`APP_BUILD_SHA=${APP_BUILD_SHA}`)
    expect(APP_BUILD_SHA).not.toBe('unknown')
    expect(text).toContain('APP_BUILD_TIME=')
    expect(text).toContain('SCANNER_SCHEMA_VERSION=')
    const shaIndex = text.indexOf('APP_BUILD_SHA=')
    const fastStateIndex = text.indexOf('FAST_SCANNER_STATE=')
    expect(shaIndex).toBeGreaterThanOrEqual(0)
    expect(shaIndex).toBeLessThan(fastStateIndex)
  })

  it('never contains anything resembling a secret/token field name', () => {
    const text = formatScannerDiagnostics(diagnostics())
    expect(text.toLowerCase()).not.toMatch(/service_role|token|password|auth|email|user_id/)
  })

  it('P82-4/P82-5: renders live-progress fields even while still loading, distinct from FAST_SCANNER_STATE/ENHANCED_VISUAL_STATE', () => {
    const text = formatScannerDiagnostics(
      diagnostics({
        visualModelState: 'loading',
        enhancedVisualState: 'loading',
        fastScannerState: 'ready',
        ocrRuntimeState: 'ready',
        workerBooted: true,
        workerBootMs: 9,
        visualCurrentPhase: 'wasm-attempt-started',
        visualCurrentPhaseElapsedMs: 42000,
        visualLastProgressMsAgo: 42000,
      }),
    )
    expect(text).toContain('FAST_SCANNER_STATE=ready')
    expect(text).toContain('OCR_RUNTIME_STATE=ready')
    expect(text).toContain('ENHANCED_VISUAL_STATE=loading')
    expect(text).toContain('WORKER_BOOTED=yes')
    expect(text).toContain('WORKER_BOOT_MS=9')
    expect(text).toContain('VISUAL_CURRENT_PHASE=wasm-attempt-started')
    expect(text).toContain('DINO_CURRENT_PHASE=wasm-attempt-started')
    expect(text).toContain('VISUAL_CURRENT_PHASE_ELAPSED_MS=42000')
    expect(text).toContain('VISUAL_LAST_PROGRESS_MS_AGO=42000')
  })

  it('P82-4: a worker constructed but never reporting a boot message is distinguishable from one stuck in a later phase', () => {
    const text = formatScannerDiagnostics(
      diagnostics({
        workerBooted: false,
        workerBootMs: null,
        visualCurrentPhase: null,
        visualCurrentPhaseElapsedMs: null,
        visualLastProgressMsAgo: null,
      }),
    )
    expect(text).toContain('WORKER_BOOTED=no')
    expect(text).toContain('WORKER_BOOT_MS=—')
    expect(text).toContain('VISUAL_CURRENT_PHASE=—')
  })

  it('O85-11: renders every OCR trial with its winner flagged, and an honest placeholder when empty', () => {
    const empty = formatScannerDiagnostics(diagnostics())
    expect(empty).toContain('OCR_TRIALS:\n  —')

    const text = formatScannerDiagnostics(
      diagnostics({
        ocrTrials: [
          {
            field: 'number',
            roiId: 'modern-bottom-left',
            preprocess: 'contrast',
            segmentation: 'single-line',
            text: '',
            confidence: 0,
            plausibilityScore: 0,
            isWinner: false,
          },
          {
            field: 'number',
            roiId: 'modern-bottom-left',
            preprocess: 'contrast',
            segmentation: 'multi-line',
            text: '049/197',
            confidence: 55,
            plausibilityScore: 155,
            isWinner: true,
          },
        ],
      }),
    )
    expect(text).toContain(
      '[number] roi=modern-bottom-left preprocess=contrast segmentation=single-line confidence=0 plausibility=0.0 text=""',
    )
    expect(text).toContain(
      '[number] roi=modern-bottom-left preprocess=contrast segmentation=multi-line confidence=55 plausibility=155.0 text="049/197" <-- WINNER',
    )
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

describe('formatExpectedCardRankDiagnostics (P90 §10/§21)', () => {
  const card = { id: 'card-58', name: 'Pikachu', setName: 'Base Set', localId: '58' }

  function rank(overrides: Partial<ExpectedCardRank> = {}): ExpectedCardRank {
    return {
      found: true,
      rank: 3,
      similarity: 0.87,
      totalCards: 19501,
      inTop20: true,
      inTop100: true,
      indexContentId: '0123456789abcdef',
      hybridRank: 1,
      hybridScore: 85,
      hybridTier: 'high',
      scoreComponents: ['collector-number-exact', 'name-exact', 'visual-strong'],
      ...overrides,
    }
  }

  it('renders every required field with real values', () => {
    const text = formatExpectedCardRankDiagnostics(card, rank())
    expect(text).toContain('EXPECTED_CARD_ID=card-58')
    expect(text).toContain('EXPECTED_CARD_NAME=Pikachu')
    expect(text).toContain('EXPECTED_CARD_SET=Base Set')
    expect(text).toContain('EXPECTED_CARD_NUMBER=58')
    expect(text).toContain('EXPECTED_VISUAL_RANK=3')
    expect(text).toContain('EXPECTED_VISUAL_SIMILARITY=0.8700')
    expect(text).toContain('EXPECTED_IN_TOP20=yes')
    expect(text).toContain('EXPECTED_IN_TOP100=yes')
    expect(text).toContain('EXPECTED_TOTAL_INDEX_CARDS=19501')
    expect(text).toContain('EXPECTED_INDEX_CONTENT_ID=0123456789abcdef')
    expect(text).toContain('EXPECTED_HYBRID_RANK=1')
    expect(text).toContain('EXPECTED_HYBRID_TIER=high')
    expect(text).toContain('EXPECTED_TEXT_EVIDENCE=collector-number-exact,name-exact')
    expect(text).toContain(
      'EXPECTED_SCORE_COMPONENTS=collector-number-exact,name-exact,visual-strong',
    )
  })

  it('never fabricates a rank/tier when the card was not found or not in the bounded top N', () => {
    const text = formatExpectedCardRankDiagnostics(
      card,
      rank({
        found: false,
        rank: null,
        similarity: null,
        hybridRank: null,
        hybridScore: null,
        hybridTier: null,
        scoreComponents: [],
      }),
    )
    expect(text).toContain('EXPECTED_VISUAL_RANK=—')
    expect(text).toContain('EXPECTED_VISUAL_SIMILARITY=—')
    expect(text).toContain('EXPECTED_VISUAL_PERCENTILE=—')
    expect(text).toContain('EXPECTED_HYBRID_RANK=—')
    expect(text).toContain('EXPECTED_HYBRID_TIER=—')
    expect(text).toContain('EXPECTED_TEXT_EVIDENCE=—')
    expect(text).toContain('EXPECTED_SCORE_COMPONENTS=—')
  })
})
