import { File } from 'expo-file-system'
import { matchScannerObservation } from '@shared/domain/scanner/engine'
import type { ScannerObservation, VisualEvidenceByCard } from '@shared/domain/scanner/types'
import type { ScannerImageInput } from '../../photo/photo-store'
import { retrieveCandidates } from './candidate-retrieval'
import { checkDecodedDimensions, checkFileSize, imageSafetyRejectionMessage } from './image-safety'
import { decodeToRgba, ImageDecodeError } from './image-decode'
import { recognizeCardText } from './ocr-adapter'
import {
  toRecognitionOutcome,
  type CardRecognitionPort,
  type RecognitionOutcome,
} from '../price-check/recognition'
import type { ScanCandidate, ScanConfidence } from '../price-check/p165-domain/price-check/scan'
import { confidenceStateFromTier, toEvidenceSummary, type NativeRecognitionResult } from './types'
import { getVisualSession } from './visual-adapter'

const VISUAL_TOP_K = 30
const DECODE_MAX_LONG_EDGE = 1600

/**
 * Real on-device recognition: image safety -> OCR (ML Kit) + visual embed/search
 * (onnxruntime-react-native over the pinned DINOv2 model + index) -> the SAME candidate-fusion
 * engine the web scanner uses (`engine.ts`, unmodified) -> a confidence-gated result.
 *
 * LATEST-CAPTURE-WINS: an internal generation token, checked after every await (mirrors P151's
 * own "abort takes effect at the next checkpoint" design — a single OCR/inference call cannot be
 * interrupted mid-flight on this runtime, so cancellation is checkpoint-based, not preemptive).
 * `recognize()` is called fresh per photo by `PhotoEntryScreen`'s own effect; a second call before
 * the first settles bumps the token, and the first call's eventual result is discarded here
 * (returns `{status:'cancelled'}`) rather than published, even if it would otherwise resolve.
 */
export function createNativeCardRecognitionPort(): CardRecognitionPort {
  let generation = 0

  return {
    implemented: true,
    async recognize(input: ScannerImageInput): Promise<RecognitionOutcome> {
      const myGeneration = (generation += 1)
      const stillCurrent = () => myGeneration === generation

      try {
        const result = await runPipeline(input)
        if (!stillCurrent()) return { status: 'cancelled' }
        return toOutcome(result)
      } catch (error) {
        if (!stillCurrent()) return { status: 'cancelled' }
        if (error instanceof RecognitionAbstainError) {
          return { status: 'abstain_quality', reason: error.message }
        }
        return { status: 'error', reason: error instanceof Error ? error.message : 'unknown' }
      }
    },
  }
}

class RecognitionAbstainError extends Error {}

async function runPipeline(input: ScannerImageInput): Promise<NativeRecognitionResult> {
  const file = new File(input.uri)
  const fileSizeCheck = checkFileSize(file.size)
  if (!fileSizeCheck.ok)
    throw new RecognitionAbstainError(imageSafetyRejectionMessage(fileSizeCheck))

  const fileBytes = await file.bytes()

  let decoded
  try {
    decoded = decodeToRgba(fileBytes, DECODE_MAX_LONG_EDGE)
  } catch (error) {
    if (error instanceof ImageDecodeError)
      throw new RecognitionAbstainError('This photo could not be read.')
    throw error
  }
  const dimensionCheck = checkDecodedDimensions(decoded.originalWidth, decoded.originalHeight)
  if (!dimensionCheck.ok) {
    throw new RecognitionAbstainError(imageSafetyRejectionMessage(dimensionCheck))
  }

  const [ocr, visualSession] = await Promise.all([
    recognizeCardText(input.uri, decoded.height).catch(() => null),
    getVisualSession(),
  ])

  let visualScores: VisualEvidenceByCard | undefined
  let visualHits: { cardId: string; similarity: number }[] = []
  try {
    const embedding = await visualSession.embed(decoded)
    visualHits = visualSession.search(embedding, VISUAL_TOP_K)
    visualScores = new Map(visualHits.map((hit) => [hit.cardId, hit.similarity]))
  } catch {
    // Visual channel failed (e.g. a corrupt tensor on this device): fall through to OCR-only,
    // matching the web scanner's own documented degradation (prompt §36) rather than erroring the
    // whole scan when text evidence alone may still be usable.
    visualScores = undefined
  }

  const observation: ScannerObservation = {
    rawNameText: ocr?.rawNameText ?? null,
    rawCollectorNumberText: ocr?.rawCollectorNumberText ?? null,
    rawSetText: null,
    languageHint: 'en',
    nameOcrConfidence: ocr?.nameOcrConfidence ?? null,
    collectorOcrConfidence: ocr?.collectorOcrConfidence ?? null,
  }

  const candidates = await retrieveCandidates({
    ocrName: ocr?.rawNameText ?? null,
    ocrCollectorNumber: ocr?.rawCollectorNumberText ?? null,
    visualCardIds: visualHits.map((hit) => hit.cardId),
  })

  const match = matchScannerObservation(observation, candidates, visualScores)
  const scannerBestId = match.candidates[0]?.card.cardId ?? null

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
    evidence: match.candidates[0] ? toEvidenceSummary(match.candidates[0]) : [],
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
