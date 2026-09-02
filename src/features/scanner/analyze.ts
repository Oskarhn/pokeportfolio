/**
 * The OCR analysis pipeline (prompt §10–§17, P80 adaptive ROI): one captured frame in, a raw
 * textual observation out. Canvas work only — the blob never leaves this module, nothing here
 * performs network I/O, and no OCR text is ever logged. One decoded source lives at a time; the
 * ImageBitmap is closed in a finally block; canvases are bounded and reused across analyses via a
 * small pool (prompt §12).
 *
 * Pipeline: decode → crop the card rect into a ≤1280-long-edge working canvas → for EACH field
 * (name, collector number), try every layout candidate from roi.ts (grayscale + contrast-
 * normalise + 2× upscale when tiny, single-line recognition) and keep the highest-SCORING usable
 * result (P80: confidence plus field-specific parseability — see `scoreNameRoiCandidate`/
 * `scoreNumberRoiCandidate`) → if BOTH fields come back with nothing usable from ANY candidate,
 * exactly ONE full-card auto-mode fallback pass with a conservative name/number split (prompt
 * §17). No repeated inference beyond the bounded candidate set, no automatic recapture.
 */

import type { ScannerCapture } from './contract'
import {
  NAME_ROI_CANDIDATES,
  NUMBER_ROI_CANDIDATES,
  binarizeGrayscale,
  normalizeContrast,
  roiPixelRect,
  toGrayscale,
  ROI_UPSCALE_FACTOR,
  ROI_UPSCALE_MIN_HEIGHT_PX,
  type GrayImage,
  type NamedRoiCandidate,
} from './roi'
import {
  canvasToBlob,
  createCompatCanvas,
  type ScanCanvas,
  type ScanContext,
} from './canvas-compat'
import type { PixelRect } from './guide-geometry'
import { parseCollectorNumber } from '../../domain/scanner/collector-number'
import { parseCollectorNumberStructured } from '../../domain/scanner/collector-parse'

/** Long edge of the temporary OCR working bitmap (prompt §12). The stored review image is never
 *  mutated for OCR's benefit — recognition works on its own smaller copy. */
export const OCR_WORKING_LONG_EDGE = 1280

/** A raw, untrusted OCR observation of one physical card. Text only; feeds P67's matcher. */
export interface RawOcrObservation {
  rawNameText: string | null
  rawCollectorNumberText: string | null
  /** True when both fields failed and the single bounded full-card pass ran instead. */
  usedFullFrameFallback: boolean
  /** Which layout candidate (roi.ts's `id`) won the name field (P80 adaptive ROI) — null when no
   *  candidate produced anything usable (the full-frame fallback ran instead). Diagnostics-only:
   *  never fed back into matching. */
  nameRoiId: string | null
  /** Same as `nameRoiId` for the collector-number field. */
  numberRoiId: string | null
  /** Present only when the caller asked for debug images (P79 §4/§12) — the WINNING ROI's bitmap
   *  for each field, for the debug panel's "is the model seeing the card cleanly?" preview. Null
   *  values mean that field never produced a usable candidate (e.g. the full-frame fallback path). */
  debugImages?: { nameRoiBlob: Blob | null; numberRoiBlob: Blob | null }
  /** P85 §11: every ROI/preprocess/segmentation attempt considered this scan, present only when
   *  the caller asked for debug — same gating as `debugImages`. */
  trials?: OcrDebugTrial[]
}

export interface OcrEnginePort {
  prepare: () => Promise<void>
  recognize: (
    source: HTMLCanvasElement | OffscreenCanvas,
    segmentation?: 'single-line' | 'auto' | 'multi-line',
  ) => Promise<{ text: string; confidence: number }>
}

/** P85 §11 OCR debugger: one considered ROI attempt, recorded only when `debug` is true. Never
 *  persisted anywhere beyond the return value of one `runOcrAnalysis` call — same in-memory-only
 *  discipline as the existing debug image previews. Raw OCR text already surfaces in this exact
 *  debug panel via `OCR_NAME_SIGNAL`/`OCR_COLLECTOR_SIGNAL` (P77) — a per-trial breakdown is the
 *  same information at finer grain, not a new privacy boundary. */
export interface OcrDebugTrial {
  readonly field: 'name' | 'number'
  readonly roiId: string
  readonly preprocess: RoiPreprocess
  readonly segmentation: 'single-line' | 'multi-line'
  readonly text: string
  readonly confidence: number
  readonly plausibilityScore: number
  readonly isWinner: boolean
}

/** Minimum usable signal lengths — anything shorter is treated as "nothing read" rather than
 *  handed to the parser (P67's own parser fails closed anyway; this avoids pointless queries). */
export const MIN_NAME_TEXT_LENGTH = 3
export const MIN_NUMBER_TEXT_LENGTH = 2

interface BoundedCanvas {
  element: ScanCanvas
  context: ScanContext
}

const createBoundedCanvas = createCompatCanvas

/**
 * Tiny reusable bounded-canvas pool (prompt §12): at most three canvases alive for a session
 * (working image + two ROI strips), resized upward when a larger card arrives, whatever how many
 * cards get scanned. Injectable so tests can substitute recording fakes.
 */
export class CanvasPool {
  private working: BoundedCanvas | null = null
  private nameRoi: BoundedCanvas | null = null
  private numberRoi: BoundedCanvas | null = null

  take(slot: 'working' | 'nameRoi' | 'numberRoi', width: number, height: number): BoundedCanvas {
    const existing =
      slot === 'working' ? this.working : slot === 'nameRoi' ? this.nameRoi : this.numberRoi
    if (
      existing !== null &&
      existing.element.width >= Math.max(1, Math.round(width)) &&
      existing.element.height >= Math.max(1, Math.round(height))
    ) {
      return existing
    }
    const created = createBoundedCanvas(width, height)
    if (slot === 'working') this.working = created
    else if (slot === 'nameRoi') this.nameRoi = created
    else this.numberRoi = created
    return created
  }

  release(): void {
    this.working = null
    this.nameRoi = null
    this.numberRoi = null
  }
}

const sharedPool = new CanvasPool()

/** Drops every pooled canvas reference (session teardown alongside engine disposal). */
export function releaseOcrCanvases(): void {
  sharedPool.release()
}

function shrinkToLongEdge(
  width: number,
  height: number,
  maxLongEdge: number,
): { width: number; height: number } {
  const longEdge = Math.max(width, height)
  if (longEdge <= maxLongEdge) return { width: Math.round(width), height: Math.round(height) }
  const scale = maxLongEdge / longEdge
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

/** Which grayscale preprocessing pass runs before recognition (P82 §15). `contrast` is the
 *  original, always-tried-first pass (percentile stretch only — zero behavioural change from
 *  P67-P81). `binarize` is a NEW fallback variant tried only when `contrast` did not already
 *  produce a confident read for a given ROI candidate: a real-device miss (Shieldon, P82 §0)
 *  showed a name ROI that visually contained clean text but still read as garbage, consistent with
 *  low LOCAL contrast against a colourful/holo background that a global percentile stretch alone
 *  does not fully separate — Otsu binarization (roi.ts) targets exactly that case. */
export type RoiPreprocess = 'contrast' | 'binarize'

/** Draws one source region at a chosen scale, then runs grayscale + the requested preprocessing
 *  pass over exactly those pixels and writes them back. Deterministic by construction. */
function drawPreparedRegion(
  target: BoundedCanvas,
  source: CanvasImageSource,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  scale: number,
  preprocess: RoiPreprocess = 'contrast',
): void {
  target.element.width = Math.max(1, Math.round(sw * scale))
  target.element.height = Math.max(1, Math.round(sh * scale))
  const context = target.context
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, target.element.width, target.element.height)
  context.drawImage(source, sx, sy, sw, sh, 0, 0, target.element.width, target.element.height)
  const imageData = context.getImageData(0, 0, target.element.width, target.element.height)
  const gray: GrayImage = toGrayscale({
    data: imageData.data,
    width: imageData.width,
    height: imageData.height,
  })
  const prepared = preprocess === 'binarize' ? binarizeGrayscale(gray) : normalizeContrast(gray)
  const output = context.createImageData(target.element.width, target.element.height)
  for (let i = 0; i < prepared.data.length; i += 1) {
    const value = prepared.data[i] ?? 0
    output.data[i * 4] = value
    output.data[i * 4 + 1] = value
    output.data[i * 4 + 2] = value
    output.data[i * 4 + 3] = 255
  }
  context.putImageData(output, 0, 0)
}

export function cleanSignal(text: string | null, minimumLength: number): string | null {
  if (text === null) return null
  const cleaned = text.replace(/\s+/g, ' ').trim()
  return cleaned.length >= minimumLength ? cleaned : null
}

/**
 * P80 adaptive-ROI scoring — name field. OCR confidence dominates; the letter-ratio term breaks
 * ties AND penalizes symbol/digit-heavy noise a name ROI landing on artwork or a stat line tends
 * to produce (a real name is almost entirely letters and spaces). Pure and exported so tests pin
 * the exact numbers, same discipline as engine.ts's SCORING_WEIGHTS.
 */
export function scoreNameRoiCandidate(cleanedText: string, confidence: number): number {
  return confidence + nameLetterRatio(cleanedText) * 20
}

function nameLetterRatio(cleanedText: string): number {
  const letters = cleanedText.replace(/[^a-zA-Z]/g, '').length
  return cleanedText.length === 0 ? 0 : letters / cleanedText.length
}

/** A real printed collector id is short ("049/197", "TG01/TG30") — a long OCR string that
 *  happens to contain a digit run must never be scored as a plausible id just because P67's
 *  intentionally-permissive `parseCollectorNumber` (built to tolerate short OCR noise, not to
 *  reject long prose) can still structurally match a prefix/digits/suffix shape inside it. */
const MAX_PLAUSIBLE_NUMBER_TEXT_LENGTH = 12

/** True when `cleanedText` both looks like a real printed id (short) AND actually parses as one
 *  — the strongest possible signal a P80 candidate ROI can produce for this field. */
export function looksLikeCollectorNumberText(cleanedText: string): boolean {
  return (
    cleanedText.length <= MAX_PLAUSIBLE_NUMBER_TEXT_LENGTH &&
    parseCollectorNumber(cleanedText) !== null
  )
}

/**
 * P80 adaptive-ROI scoring — collector-number field. Parseability is the strongest possible
 * signal here, so a candidate whose text actually parses as a plausible printed id wins over one
 * that merely has higher raw OCR confidence but reads as rules/credit text.
 */
export function scoreNumberRoiCandidate(cleanedText: string, confidence: number): number {
  return confidence + (looksLikeCollectorNumberText(cleanedText) ? 100 : 0)
}

/** P80 early-exit predicates: once a candidate is this good, the remaining layout candidates for
 *  the same field are skipped — restores the original single-ROI-read latency for the common,
 *  already-correct-layout case, while still trying every candidate when the first read is weak or
 *  wrong (the real modern-layout failure this session fixes). */
export function isNameRoiConfident(cleanedText: string, confidence: number): boolean {
  return confidence >= 70 && nameLetterRatio(cleanedText) >= 0.8
}

export function isNumberRoiConfident(cleanedText: string): boolean {
  return looksLikeCollectorNumberText(cleanedText)
}

/**
 * P85 §7/§9 — extracts the most plausible collector-number LINE out of a multi-line OCR block.
 * Real-corpus forensics (docs/SCANNER_RESEARCH.md §7f) found that a correctly-cropped number strip
 * routinely shares its visual line with an illustrator credit or copyright line — a real, common
 * template shape (confirmed directly on both a vintage Base-Set-style card and a modern
 * Scarlet & Violet card), not a rare edge case. Search from the LAST line backward: the printed id
 * sits on the bottom-most line of these crops far more consistently than the credit/copyright text
 * above it. Pure; exported for tests. Returns null rather than guessing when no line qualifies.
 */
/**
 * P85 §7/§8/§10 — a real, confirmed false positive: a PSM 6 block read of a vintage card's
 * copyright line ("...© 1995 Nintendo...") produces a bare 4-digit token ("1995") that
 * `looksLikeCollectorNumberText` structurally accepts (digits only, ≤12 chars, parses) but is not
 * remotely a real printed id. `parseCollectorNumberStructured`'s own structural-plausibility bands
 * (`collector-parse.ts`, built for exactly this "prevent garbage from scoring like a real id"
 * purpose) already reject this shape down to `low` — reused here rather than a second, divergent
 * ad hoc predicate. Requires `medium`+ (a total, a bare 1-3-digit number, or a recognized prefix)
 * — stricter than the plain `looksLikeCollectorNumberText` still used by the single-line pass
 * above (where this specific two-line ambiguity does not arise) — used ONLY by the multi-line
 * fallback's per-token search below.
 */
function looksLikePlausibleMultiLineToken(token: string): boolean {
  if (!looksLikeCollectorNumberText(token)) return false
  const confidence = parseCollectorNumberStructured(token).confidence
  return confidence === 'high' || confidence === 'medium'
}

export function extractCollectorNumberLine(text: string): string | null {
  const lines = text
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line.length > 0)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? ''
    if (looksLikePlausibleMultiLineToken(line)) return line
    // A PSM 6 block-read line often carries real noise AROUND the id itself — a misread
    // set-symbol icon box, a trailing bullet/star glyph — so the id is one TOKEN inside an
    // otherwise-unparseable line, not the whole line (real, confirmed directly against
    // Scarlet & Violet's "(BI 001/198 ®"-shaped read). Strip stray punctuation per token (never
    // letters/digits/slash/hyphen — those stay meaningful to `parseCollectorNumber`) and try each.
    const tokens = line.split(' ').filter(Boolean)
    for (const token of tokens) {
      const stripped = token.replace(/[^A-Za-z0-9/-]/g, '')
      if (stripped.length > 0 && looksLikePlausibleMultiLineToken(stripped)) return stripped
    }
  }
  return null
}

/**
 * Conservative split of ONE full-card fallback text into (name, collector-number) candidates:
 * scanning from the end, the first token that plausibly IS a printed id (short, contains a
 * digit, not prose) becomes the number candidate and everything before it the name candidate.
 * Pure; exported for tests. Best-effort by design — the matcher still fails closed downstream.
 */
export function splitFullFrameCardText(text: string): {
  name: string | null
  number: string | null
} {
  const tokens = text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean)
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const token = tokens[index] ?? ''
    const letters = token.replace(/[^a-zA-Z]/g, '')
    if (/\d/.test(token) && letters.length <= 3 && token.length <= 10) {
      const nameTokens = tokens.slice(0, index)
      const name = nameTokens.join(' ')
      return {
        name: name.length >= MIN_NAME_TEXT_LENGTH ? name : null,
        number: token.length >= MIN_NUMBER_TEXT_LENGTH ? token : null,
      }
    }
  }
  const joined = tokens.join(' ')
  return { name: joined.length >= MIN_NAME_TEXT_LENGTH ? joined : null, number: null }
}

/**
 * Runs the full OCR pipeline against one capture using the provided engine port. Throws on
 * engine/decode failure (mapped upstream to friendly copy); returns an honest observation even
 * when nothing was read (both fields null).
 */
export async function runOcrAnalysis(
  capture: ScannerCapture,
  engine: OcrEnginePort,
  pool: CanvasPool = sharedPool,
  debug = false,
): Promise<RawOcrObservation> {
  await engine.prepare()
  if (typeof createImageBitmap !== 'function') {
    throw new Error('This browser cannot analyse images here.')
  }
  const bitmap = await createImageBitmap(capture.blob)
  try {
    const workingSize = shrinkToLongEdge(
      capture.cardRect.width,
      capture.cardRect.height,
      OCR_WORKING_LONG_EDGE,
    )
    const working = pool.take('working', workingSize.width, workingSize.height)
    drawPreparedRegion(
      working,
      bitmap,
      capture.cardRect.left,
      capture.cardRect.top,
      capture.cardRect.width,
      capture.cardRect.height,
      workingSize.width / capture.cardRect.width,
    )

    const cardOnWorking: PixelRect = {
      left: 0,
      top: 0,
      width: working.element.width,
      height: working.element.height,
    }

    /** Runs ONE ROI candidate's crop+prep+recognize (no scoring/selection) — the atomic unit both
     *  the trial loop and the final debug redraw below share. `segmentation` defaults to
     *  `single-line` (P85 §3 forensics: the current default beats every other page-segmentation
     *  mode decisively for both fields when a candidate crop genuinely IS one line — see
     *  docs/SCANNER_RESEARCH.md §7f); `multi-line` (P85 §7/§9) is used ONLY by the collector-number
     *  field's bounded third pass below, for the specific case forensics found single-line cannot
     *  handle at all: a crop that structurally contains two visual lines. */
    async function readOneCandidate(
      candidate: NamedRoiCandidate,
      slot: 'nameRoi' | 'numberRoi',
      preprocess: RoiPreprocess = 'contrast',
      segmentation: 'single-line' | 'multi-line' = 'single-line',
    ): Promise<{ rect: PixelRect; text: string; confidence: number } | null> {
      const rect = roiPixelRect(cardOnWorking, candidate.fractions)
      if (rect.width < 8 || rect.height < 8) return null
      const upscale = rect.height < ROI_UPSCALE_MIN_HEIGHT_PX ? ROI_UPSCALE_FACTOR : 1
      const roi = pool.take(slot, rect.width * upscale, rect.height * upscale)
      drawPreparedRegion(
        roi,
        working.element,
        rect.left,
        rect.top,
        rect.width,
        rect.height,
        upscale,
        preprocess,
      )
      const result = await engine.recognize(roi.element, segmentation)
      return { rect, text: result.text, confidence: result.confidence }
    }

    /**
     * P80 adaptive ROI: tries each layout candidate for one field in order, scoring every usable
     * result and keeping the best, but stops as soon as one candidate is already "confident"
     * (`isConfident`) — this is what keeps the common, already-correctly-laid-out scan at the
     * SAME one-recognition-call cost the original single-ROI pipeline had, while still falling
     * through to the next layout hypothesis when the first read is weak, empty or wrong (the real
     * modern-vs-vintage-layout failure this session fixes). Never stops on a merely non-null but
     * low-quality result — only on genuine confidence — so list ORDER never silently decides the
     * winner in the cases that actually matter.
     *
     * P82 §15: if this `contrast` pass (identical to P78-P81's own pipeline, zero call-count or
     * scoring change from before) finds NOTHING usable from ANY candidate, exactly ONE second pass
     * over the SAME candidates retries `binarize` preprocessing before falling through to the
     * full-frame OCR pass — a real-device miss (Shieldon, P82 §0) showed a name ROI that visually
     * contained clean text while OCR still produced garbage, consistent with low LOCAL contrast a
     * global percentile stretch alone does not always separate. Bounded to the already-failing
     * case only: a scan that already found SOME text via `contrast` (even if not "confident") never
     * pays for the second pass, so this cannot regress anything P80's own candidate-scoring tests
     * already pin. Only in a debug session, the winning region is redrawn once more afterward for
     * the preview blob (cheap: one extra canvas draw, no extra recognition call).
     *
     * P85 §7/§9: for the collector-number field ONLY (`multiLineExtract` provided), a THIRD
     * bounded pass retries the SAME candidates with `multi-line` segmentation + `contrast`
     * preprocessing when BOTH earlier passes found nothing usable at all — real-corpus forensics
     * (docs/SCANNER_RESEARCH.md §7f) found this recovers a real, common failure class
     * (single-line segmentation cannot read a crop that structurally contains two visual lines,
     * e.g. an illustrator credit sharing its line with the printed id) that no amount of
     * preprocessing variation on `single-line` alone can fix. Still bounded to at most
     * `candidates.length` extra recognition calls, and only in the already-failing case.
     */
    async function readBestRoi(
      candidates: readonly NamedRoiCandidate[],
      slot: 'nameRoi' | 'numberRoi',
      minLength: number,
      score: (cleanedText: string, confidence: number) => number,
      isConfident: (cleanedText: string, confidence: number) => boolean,
      field: 'name' | 'number',
      multiLineExtract?: (rawText: string) => string | null,
    ): Promise<{
      text: string | null
      roiId: string | null
      debugBlob: Blob | null
      trials: OcrDebugTrial[]
    }> {
      interface BestTrial {
        roiId: string
        cleaned: string
        score: number
        rect: PixelRect
        preprocess: RoiPreprocess
      }
      const best: { value: BestTrial | null } = { value: null }
      const trials: OcrDebugTrial[] = []

      function recordTrial(
        candidate: NamedRoiCandidate,
        preprocess: RoiPreprocess,
        segmentation: 'single-line' | 'multi-line',
        text: string,
        confidence: number,
        plausibilityScore: number,
      ): void {
        if (!debug) return
        trials.push({
          field,
          roiId: candidate.id,
          preprocess,
          segmentation,
          text,
          confidence,
          plausibilityScore,
          isWinner: false,
        })
      }

      // Returns whether anything usable was found, not just whether it was CONFIDENT (same
      // shape as `readOneCandidate`'s honest tri-state elsewhere): a closure-mutated `let`/object
      // property reassigned only inside an awaited nested call is invisible to TypeScript's own
      // control-flow narrowing at the CALLER's later read site (confirmed directly — real repro,
      // same class of bug P78 already found in this exact file: see PROJECT_JOURNAL.md's
      // 2026-08-27 entry). Returning the fact explicitly, rather than re-reading `best.value`
      // afterward, sidesteps that pitfall instead of fighting it.
      async function tryPreprocessPass(
        preprocess: RoiPreprocess,
      ): Promise<{ confident: boolean; foundAny: boolean }> {
        let foundAny = false
        for (const candidate of candidates) {
          const attempt = await readOneCandidate(candidate, slot, preprocess)
          if (attempt === null) continue
          const cleaned = cleanSignal(attempt.text, minLength)
          if (cleaned === null) {
            recordTrial(candidate, preprocess, 'single-line', attempt.text, attempt.confidence, 0)
            continue
          }
          foundAny = true
          const candidateScore = score(cleaned, attempt.confidence)
          recordTrial(
            candidate,
            preprocess,
            'single-line',
            cleaned,
            attempt.confidence,
            candidateScore,
          )
          if (best.value === null || candidateScore > best.value.score) {
            best.value = {
              roiId: candidate.id,
              cleaned,
              score: candidateScore,
              rect: attempt.rect,
              preprocess,
            }
          }
          if (isConfident(cleaned, attempt.confidence)) return { confident: true, foundAny: true }
        }
        return { confident: false, foundAny }
      }

      async function tryMultiLinePass(): Promise<void> {
        if (!multiLineExtract) return
        for (const candidate of candidates) {
          const attempt = await readOneCandidate(candidate, slot, 'contrast', 'multi-line')
          if (attempt === null) continue
          const line = multiLineExtract(attempt.text)
          const cleaned = line === null ? null : cleanSignal(line, minLength)
          if (cleaned === null) {
            recordTrial(candidate, 'contrast', 'multi-line', attempt.text, attempt.confidence, 0)
            continue
          }
          const candidateScore = score(cleaned, attempt.confidence)
          recordTrial(
            candidate,
            'contrast',
            'multi-line',
            cleaned,
            attempt.confidence,
            candidateScore,
          )
          if (best.value === null || candidateScore > best.value.score) {
            best.value = {
              roiId: candidate.id,
              cleaned,
              score: candidateScore,
              rect: attempt.rect,
              preprocess: 'contrast',
            }
          }
          if (isConfident(cleaned, attempt.confidence)) return
        }
      }

      const contrastResult = await tryPreprocessPass('contrast')
      if (!contrastResult.confident && !contrastResult.foundAny) {
        const binarizeResult = await tryPreprocessPass('binarize')
        if (!binarizeResult.confident && !binarizeResult.foundAny) {
          await tryMultiLinePass()
        }
      }

      let debugBlob: Blob | null = null
      const winner = best.value
      if (debug && winner !== null) {
        const upscale = winner.rect.height < ROI_UPSCALE_MIN_HEIGHT_PX ? ROI_UPSCALE_FACTOR : 1
        const roi = pool.take(slot, winner.rect.width * upscale, winner.rect.height * upscale)
        drawPreparedRegion(
          roi,
          working.element,
          winner.rect.left,
          winner.rect.top,
          winner.rect.width,
          winner.rect.height,
          upscale,
          winner.preprocess,
        )
        // Captured BEFORE the next scan can reuse/resize this pooled canvas (prompt §4/§12
        // debug-only image preview) — never persisted, never sent anywhere but this call's return.
        debugBlob = await canvasToBlob(roi.element).catch(() => null)
        for (const trial of trials) {
          if (
            trial.roiId === winner.roiId &&
            trial.preprocess === winner.preprocess &&
            trial.text === winner.cleaned
          ) {
            trials[trials.indexOf(trial)] = { ...trial, isWinner: true }
            break
          }
        }
      }
      return { text: winner?.cleaned ?? null, roiId: winner?.roiId ?? null, debugBlob, trials }
    }

    const nameResult = await readBestRoi(
      NAME_ROI_CANDIDATES,
      'nameRoi',
      MIN_NAME_TEXT_LENGTH,
      scoreNameRoiCandidate,
      isNameRoiConfident,
      'name',
    )
    const numberResult = await readBestRoi(
      NUMBER_ROI_CANDIDATES,
      'numberRoi',
      MIN_NUMBER_TEXT_LENGTH,
      scoreNumberRoiCandidate,
      isNumberRoiConfident,
      'number',
      extractCollectorNumberLine,
    )
    const allTrials = [...nameResult.trials, ...numberResult.trials]

    if (nameResult.text !== null || numberResult.text !== null) {
      return {
        rawNameText: nameResult.text,
        rawCollectorNumberText: numberResult.text,
        usedFullFrameFallback: false,
        nameRoiId: nameResult.roiId,
        numberRoiId: numberResult.roiId,
        ...(debug
          ? {
              debugImages: {
                nameRoiBlob: nameResult.debugBlob,
                numberRoiBlob: numberResult.debugBlob,
              },
              trials: allTrials,
            }
          : {}),
      }
    }

    // No candidate for EITHER field produced anything usable: exactly ONE bounded full-card pass
    // (prompt §17), auto layout mode.
    const fullResult = await engine.recognize(working.element, 'auto')
    const split = splitFullFrameCardText(fullResult.text)
    return {
      rawNameText: split.name,
      rawCollectorNumberText: split.number,
      usedFullFrameFallback: true,
      nameRoiId: null,
      numberRoiId: null,
      ...(debug
        ? {
            trials: allTrials,
            debugImages: {
              nameRoiBlob: nameResult.debugBlob,
              numberRoiBlob: numberResult.debugBlob,
            },
          }
        : {}),
    }
  } finally {
    bitmap.close()
  }
}
