import { File } from 'expo-file-system'
import { matchScannerObservation } from '@shared/domain/scanner/engine'
import type {
  ScannerCandidateRecord,
  ScannerObservation,
  VisualEvidenceByCard,
} from '@shared/domain/scanner/types'
import type { ScannerImageInput } from '../../photo/photo-store'
import { retrieveCandidates } from './candidate-retrieval'
import { checkDecodedDimensions, checkFileSize, imageSafetyRejectionMessage } from './image-safety'
import { decodeToRgba, ImageDecodeError, type DecodedImage } from './image-decode'
import { sniffImageHeader } from './image-header'
import { recognizeCardText, type OcrExtraction } from './ocr-adapter'
import {
  toRecognitionOutcome,
  type CardRecognitionPort,
  type RecognitionOutcome,
} from '../price-check/recognition'
import type { ScanCandidate, ScanConfidence } from '../price-check/p165-domain/price-check/scan'
import {
  emitTrace,
  nowMs,
  type ScanStageTimings,
  type ScanTraceEvent,
  type ScanTraceOutcome,
} from './scan-trace'
import { confidenceStateFromTier, toEvidenceSummary, type NativeRecognitionResult } from './types'
import { getVisualSession, type VisualSession } from './visual-adapter'

const VISUAL_TOP_K = 30
const DECODE_MAX_LONG_EDGE = 1600
const TRACE_VISUAL_TOP = 5
const TRACE_CANDIDATES = 5

/**
 * The I/O of the pipeline, injectable so the decision logic (checkpoints, safety order, fusion,
 * cancellation) is testable without a device. The default is the real thing.
 */
export interface RecognitionPipelineDeps {
  readFile(
    uri: string,
  ): Promise<{ readonly size: number; readonly bytes: () => Promise<Uint8Array> }>
  decode(bytes: Uint8Array, maxLongEdge: number): DecodedImage
  ocr(uri: string, imageHeight: number): Promise<OcrExtraction>
  visualSession(): Promise<VisualSession>
  retrieve(input: {
    ocrName: string | null
    ocrCollectorNumber: string | null
    visualCardIds: readonly string[]
  }): Promise<ScannerCandidateRecord[]>
}

const realDeps: RecognitionPipelineDeps = {
  readFile: (uri) => {
    const file = new File(uri)
    return Promise.resolve({ size: file.size, bytes: () => file.bytes() })
  },
  decode: decodeToRgba,
  ocr: recognizeCardText,
  visualSession: getVisualSession,
  retrieve: retrieveCandidates,
}

/**
 * Real on-device recognition: image safety -> OCR (ML Kit) + visual embed/search
 * (onnxruntime-react-native over the pinned DINOv2 model + index) -> the SAME candidate-fusion
 * engine the web scanner uses (`engine.ts`, unmodified) -> a confidence-gated result.
 *
 * LATEST-CAPTURE-WINS, CANCELLATION AND IDENTITY (P184). One generation counter guards every
 * publish:
 *   - `recognize()` bumps it, so an older call that is still running loses;
 *   - `cancelActive()` (app backgrounded) and `reset()` (identity boundary, registered in the
 *     scoped registry) bump it without starting a call, so nothing running may publish;
 *   - the pipeline checks it after EVERY await (a single ML Kit / ONNX call cannot be interrupted
 *     mid-flight on this runtime, so cancellation is checkpoint-based, not preemptive) and stops
 *     there — the expensive stages after the checkpoint never run, and the network retrieval never
 *     starts for a scan that is already superseded.
 * A token refresh of the SAME user does not touch the generation: it is deliberately not an
 * identity change, so a recognition in flight across a refresh is still valid.
 */
export function createNativeCardRecognitionPort(
  deps: RecognitionPipelineDeps = realDeps,
): CardRecognitionPort {
  let generation = 0
  let scanCounter = 0

  return {
    implemented: true,
    cancelActive() {
      generation += 1
    },
    reset() {
      generation += 1
    },
    async recognize(input: ScannerImageInput): Promise<RecognitionOutcome> {
      const myGeneration = (generation += 1)
      const isCurrent = () => myGeneration === generation
      const scanId = (scanCounter += 1)
      const startedAt = nowMs()
      const stages: Partial<Mutable<ScanStageTimings>> = {}
      const trace: TraceDraft = {
        ocr: null,
        visualTop: [],
        visualFailed: false,
        tier: null,
        topCandidateIds: [],
        scannerBestId: null,
        preselectedId: null,
        evidenceCodes: [],
      }

      const finish = (outcome: ScanTraceOutcome, stoppedAt: string | null): void => {
        stages.totalMs = nowMs() - startedAt
        emitTrace({
          kind: 'scan',
          scanId,
          outcome,
          stoppedAt,
          stages: roundStages(stages),
          ...trace,
        } satisfies ScanTraceEvent)
      }

      try {
        const result = await runPipeline(input, deps, { isCurrent, stages, trace })
        if (!isCurrent()) {
          finish('cancelled', 'before_publish')
          return { status: 'cancelled' }
        }
        const outcome = toOutcome(result)
        if (outcome.status === 'analysed' && outcome.outcome.kind === 'high') {
          trace.preselectedId = outcome.outcome.preselectedId
        }
        finish('analysed', null)
        return outcome
      } catch (error) {
        if (error instanceof RecognitionCancelledError) {
          finish('cancelled', error.checkpoint)
          return { status: 'cancelled' }
        }
        if (!isCurrent()) {
          finish('cancelled', 'error_after_supersede')
          return { status: 'cancelled' }
        }
        if (error instanceof RecognitionAbstainError) {
          finish('abstain_quality', error.code)
          return { status: 'abstain_quality', reason: error.message }
        }
        finish('error', error instanceof Error ? error.name : 'unknown')
        return { status: 'error', reason: error instanceof Error ? error.message : 'unknown' }
      }
    },
  }
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] }
type TraceDraft = Mutable<
  Pick<
    ScanTraceEvent,
    | 'ocr'
    | 'visualTop'
    | 'visualFailed'
    | 'tier'
    | 'topCandidateIds'
    | 'scannerBestId'
    | 'preselectedId'
    | 'evidenceCodes'
  >
>

function roundStages(stages: Partial<ScanStageTimings>): Partial<ScanStageTimings> {
  const out: Partial<Mutable<ScanStageTimings>> = {}
  for (const [key, value] of Object.entries(stages)) {
    out[key as keyof ScanStageTimings] = Math.round(value * 10) / 10
  }
  return out
}

class RecognitionAbstainError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message)
  }
}

class RecognitionCancelledError extends Error {
  constructor(readonly checkpoint: string) {
    super(`recognition superseded at ${checkpoint}`)
  }
}

interface RunContext {
  readonly isCurrent: () => boolean
  readonly stages: Partial<Mutable<ScanStageTimings>>
  readonly trace: TraceDraft
}

async function timed<T>(
  ctx: RunContext,
  stage: keyof ScanStageTimings,
  work: () => Promise<T> | T,
): Promise<T> {
  const started = nowMs()
  try {
    return await work()
  } finally {
    ctx.stages[stage] = (ctx.stages[stage] ?? 0) + (nowMs() - started)
  }
}

function checkpoint(ctx: RunContext, name: string): void {
  if (!ctx.isCurrent()) throw new RecognitionCancelledError(name)
}

async function runPipeline(
  input: ScannerImageInput,
  deps: RecognitionPipelineDeps,
  ctx: RunContext,
): Promise<NativeRecognitionResult> {
  const file = await deps.readFile(input.uri)
  const fileSizeCheck = checkFileSize(file.size)
  if (!fileSizeCheck.ok) {
    throw new RecognitionAbstainError(
      imageSafetyRejectionMessage(fileSizeCheck),
      fileSizeCheck.reason,
    )
  }

  const fileBytes = await timed(ctx, 'readMs', () => file.bytes())
  checkpoint(ctx, 'after_read')

  // The declared size is read from the container header BEFORE anything decodes or OCRs the file,
  // so a compressed pixel bomb is refused on a few byte reads instead of after an allocation.
  const header = await timed(ctx, 'headerMs', () => sniffImageHeader(fileBytes))
  if (header === null) {
    throw new RecognitionAbstainError('This photo could not be read.', 'unsupported-format')
  }
  const headerCheck = checkDecodedDimensions(header.width, header.height)
  if (!headerCheck.ok) {
    throw new RecognitionAbstainError(imageSafetyRejectionMessage(headerCheck), headerCheck.reason)
  }

  let decoded: DecodedImage
  try {
    decoded = await timed(ctx, 'decodeMs', () => deps.decode(fileBytes, DECODE_MAX_LONG_EDGE))
  } catch (error) {
    if (error instanceof ImageDecodeError) {
      throw new RecognitionAbstainError('This photo could not be read.', `decode-${error.code}`)
    }
    throw error
  }
  checkpoint(ctx, 'after_decode')
  // The decoder's own view of the size must agree with the header's bounds too.
  const dimensionCheck = checkDecodedDimensions(decoded.originalWidth, decoded.originalHeight)
  if (!dimensionCheck.ok) {
    throw new RecognitionAbstainError(
      imageSafetyRejectionMessage(dimensionCheck),
      dimensionCheck.reason,
    )
  }

  const [ocr, visualSession] = await Promise.all([
    timed(ctx, 'ocrMs', () => deps.ocr(input.uri, decoded.height)).catch(() => null),
    timed(ctx, 'sessionMs', () => deps.visualSession()),
  ])
  ctx.trace.ocr =
    ocr === null
      ? { name: null, number: null, failed: true }
      : {
          name: ocr.rawNameText ?? null,
          number: ocr.rawCollectorNumberText ?? null,
          failed: false,
        }
  checkpoint(ctx, 'after_ocr_and_session')

  let visualScores: VisualEvidenceByCard | undefined
  let visualHits: { cardId: string; similarity: number }[] = []
  try {
    const embedding = await visualSession.embedTimed(decoded)
    ctx.stages.preprocessMs = embedding.preprocessMs
    ctx.stages.onnxMs = embedding.onnxMs
    checkpoint(ctx, 'after_embed')
    visualHits = await timed(ctx, 'searchMs', () =>
      visualSession.search(embedding.vector, VISUAL_TOP_K),
    )
    visualScores = new Map(visualHits.map((hit) => [hit.cardId, hit.similarity]))
    ctx.trace.visualTop = visualHits
      .slice(0, TRACE_VISUAL_TOP)
      .map((hit) => ({ cardId: hit.cardId, similarity: Math.round(hit.similarity * 1e4) / 1e4 }))
  } catch (error) {
    if (error instanceof RecognitionCancelledError) throw error
    // Visual channel failed (e.g. a corrupt tensor on this device): fall through to OCR-only,
    // matching the web scanner's own documented degradation rather than erroring the whole scan
    // when text evidence alone may still be usable.
    visualScores = undefined
    visualHits = []
    ctx.trace.visualFailed = true
  }

  const observation: ScannerObservation = {
    rawNameText: ocr?.rawNameText ?? null,
    rawCollectorNumberText: ocr?.rawCollectorNumberText ?? null,
    rawSetText: null,
    languageHint: 'en',
    nameOcrConfidence: ocr?.nameOcrConfidence ?? null,
    collectorOcrConfidence: ocr?.collectorOcrConfidence ?? null,
  }

  const candidates = await timed(ctx, 'retrievalMs', () =>
    deps.retrieve({
      ocrName: ocr?.rawNameText ?? null,
      ocrCollectorNumber: ocr?.rawCollectorNumberText ?? null,
      visualCardIds: visualHits.map((hit) => hit.cardId),
    }),
  )
  checkpoint(ctx, 'after_retrieval')

  const fusionStart = nowMs()
  const match = matchScannerObservation(observation, candidates, visualScores)
  ctx.stages.fusionMs = nowMs() - fusionStart
  const scannerBestId = match.candidates[0]?.card.cardId ?? null
  const evidence = match.candidates[0] ? toEvidenceSummary(match.candidates[0]) : []
  ctx.trace.tier = confidenceStateFromTier(match.tier)
  ctx.trace.scannerBestId = scannerBestId
  ctx.trace.topCandidateIds = match.candidates.slice(0, TRACE_CANDIDATES).map((c) => c.card.cardId)
  ctx.trace.evidenceCodes = evidence.map((line) => line.code)

  return {
    state: confidenceStateFromTier(match.tier),
    scannerBestId,
    candidates: match.candidates.map((c) => ({
      cardId: c.card.cardId,
      name: c.card.name,
      setName: c.card.setName,
      collectorNumber: c.card.localId,
      language: c.card.language,
      imageBaseUrl: c.card.imageBaseUrl,
      debugScore: c.score,
    })),
    evidence,
  }
}

/** `result.state` here is always HIGH/MEDIUM/LOW/NO_MATCH (`runPipeline` only ever produces those
 *  four via `confidenceStateFromTier`; ABSTAIN_QUALITY/ERROR/CANCELLED arise from thrown errors or
 *  the generation check in `recognize()`, never reach here) — narrowed once, at this one seam. The
 *  HIGH-vouching/pre-selection rule itself is P165's own `interpretScan`, reused unchanged via
 *  `toRecognitionOutcome` rather than re-implemented here, so this pipeline cannot silently drift
 *  from the rule Price Check's UI already trusts. */
function toOutcome(result: NativeRecognitionResult): RecognitionOutcome {
  const confidence = result.state as ScanConfidence
  const candidates: ScanCandidate[] = result.candidates.map((c) => ({
    candidateId: c.cardId,
    name: c.name,
    setName: c.setName,
    collectorNumber: c.collectorNumber,
    imageBaseUrl: c.imageBaseUrl,
    languageLabel: c.language === 'ja' ? 'Japanese' : 'English',
  }))
  return toRecognitionOutcome({ confidence, candidates, scannerBestId: result.scannerBestId })
}
