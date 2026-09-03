/**
 * Capture-quality abstention gate (ported from P91 R&D, `ai_outputs/Claude_outputs/output_91.txt`,
 * `docs/DECISIONS.md` D-103; wired into the scan pipeline by P93/D-106). Investigated because the
 * project's two documented catastrophic hard-defect profiles (glare+shadow+blur, partial-shadow+
 * noise — `docs/DECISIONS.md` D-101 §2, reproduced at ~18x corpus scale by P91) drive same-card
 * visual similarity to ~0.10-0.13 while the nearest WRONG card sits at ~0.28-0.41 — a genuine
 * signal inversion no query-side normalization, reference-side augmentation or pooling-
 * representation change this project has tried (P84, P91) can close. A scan this bad is
 * unrecoverable by the matcher; the honest product response is to detect it and treat the visual
 * channel as unavailable for that scan rather than keep tuning the matcher against an input it
 * structurally cannot read (P91 §38: false confidence is worse than abstention).
 *
 * P91's own benchmark (500-card sample, 60/40 tune/holdout split BY CARD ID so no card's
 * augmentations leak across the split) found Laplacian-variance/Tenengrad blur metrics separate
 * this project's hard-defect profiles from clean/geometry-only captures almost perfectly
 * (holdout recall 99.5%, precision 98.6%, false-rejection-of-good-captures 1.4%), while the
 * glare-fraction and shadow-coefficient-of-variation metrics also tried showed ~zero
 * discriminative power (their exact formulas are evidently miscalibrated against this project's
 * synthetic glare/shadow composites, not proof glare/shadow never matter).
 *
 * IMPORTANT DISCLOSED LIMITATION, do not oversell this module: because this project's ONLY two
 * hard-defect profiles both include an explicit blur pass while its clean/geometry-only profiles
 * never do, the benchmark's "bad capture" label is close to bimodal BY CONSTRUCTION with blur
 * specifically. Restricted to the geometry-only profile alone (a real but small 1.4% bad-rate,
 * NOT dominated by blur), this gate's recall drops to 33% — it does NOT reliably catch
 * misalignment/geometry failures, only the specific severe-blur regime this project's hard
 * profiles happen to share. Ship this as "detects severe blur," not "detects bad scans in
 * general," until a continuous-severity (not two-tier) synthetic benchmark or real-device
 * evidence says otherwise (P93 §11 extends the benchmark to continuous sweeps — see
 * scripts/scanner-recognition-lab/quality/continuous-severity.mjs — but has not yet found grounds
 * to widen the gate's scope beyond severe blur).
 *
 * Pure and platform-neutral (plain RGBA typed arrays, no canvas/DOM/sharp) so the identical code
 * can run in the browser main thread and the offline Node lab — same discipline as rectify.ts and
 * photometric.ts.
 */
import type { RgbaImage } from './rectify'

/** Long-edge target for the internal downsample before computing blur metrics. The calibrated
 *  threshold below is only meaningful at this resolution — Laplacian variance scales with image
 *  size, so a caller passing full-resolution frames without going through `computeBlurScore`'s
 *  own downsample would get an incomparable number. */
const METRIC_LONG_EDGE = 256

/** Laplacian-variance floor below which P91's holdout benchmark found the true card was, 99.5% of
 *  the time, unrecoverable (rank > 20 of ~4,300 real cards, or not retrieved at all) — see the
 *  module header for the honest scope of what this threshold does and does not detect. Computed
 *  on this module's own 256px-long-edge grayscale downsample. */
export const BLUR_ABSTAIN_THRESHOLD = 378

interface GrayField {
  readonly values: Float64Array
  readonly width: number
  readonly height: number
}

function luma(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b
}

/** Nearest-neighbor box downsample to a `longEdge`-px long edge, converting to grayscale luma in
 *  the same pass. Deterministic; a no-op (aside from the color conversion) when the image is
 *  already at or below the target size. */
function downsampleToGray(image: RgbaImage, longEdge: number): GrayField {
  const { data, width, height } = image
  if (width === 0 || height === 0) return { values: new Float64Array(0), width: 0, height: 0 }

  const scale = Math.min(1, longEdge / Math.max(width, height))
  const outWidth = Math.max(1, Math.round(width * scale))
  const outHeight = Math.max(1, Math.round(height * scale))
  const values = new Float64Array(outWidth * outHeight)

  for (let oy = 0; oy < outHeight; oy += 1) {
    const sy = Math.min(height - 1, Math.floor(oy / scale))
    for (let ox = 0; ox < outWidth; ox += 1) {
      const sx = Math.min(width - 1, Math.floor(ox / scale))
      const i = (sy * width + sx) * 4
      values[oy * outWidth + ox] = luma(data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0)
    }
  }
  return { values, width: outWidth, height: outHeight }
}

/** Laplacian variance of a grayscale field — the standard, cheap blur proxy (P91 lab's
 *  `quality/metrics.mjs`, ported here as a pure domain function). Higher = sharper. */
function laplacianVariance(field: GrayField): number {
  const { values, width, height } = field
  if (width < 3 || height < 3) return 0

  const lap = new Float64Array(width * height)
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const i = y * width + x
      const center = values[i] ?? 0
      const left = values[i - 1] ?? 0
      const right = values[i + 1] ?? 0
      const up = values[i - width] ?? 0
      const down = values[i + width] ?? 0
      lap[i] = 4 * center - left - right - up - down
    }
  }
  let mean = 0
  const n = lap.length
  for (let i = 0; i < n; i += 1) mean += lap[i] ?? 0
  mean /= n
  let variance = 0
  for (let i = 0; i < n; i += 1) variance += ((lap[i] ?? 0) - mean) ** 2
  return variance / n
}

/** Computes the blur score this gate decides on. Exposed separately from `shouldAbstainForBlur`
 *  so callers can log/inspect the raw metric (e.g. scan diagnostics) even where the boolean
 *  decision drives a real behavior change (P93: it does — see rectify-capture.ts). */
export function computeBlurScore(image: RgbaImage): number {
  const gray = downsampleToGray(image, METRIC_LONG_EDGE)
  return laplacianVariance(gray)
}

/** The actual abstention decision given an ALREADY-COMPUTED blur score (P93/D-106) — the form
 *  `rectify-capture.ts`/`controller.ts` actually use, since they compute the score once (on the
 *  canonical rectified image, before it's encoded to a blob) and thread the NUMBER through rather
 *  than re-decoding pixels. `null` (rectification never produced a working image at all) never
 *  abstains on its own — that path has no visual-channel-poisoning pixels to be severely blurred,
 *  and the visual channel's own existing failure handling covers it independently. */
export function shouldAbstainForBlurScore(
  blurScore: number | null,
  threshold: number = BLUR_ABSTAIN_THRESHOLD,
): boolean {
  return blurScore !== null && blurScore < threshold
}

/** Whether this captured (post-crop) frame is severely blurred enough that P91's benchmark found
 *  visual retrieval catastrophically unreliable on it — see the module header for exactly what
 *  this does and does not detect. Wired (P93/D-106) to abstain the VISUAL channel only — OCR text
 *  recognition and manual search are never affected. */
export function shouldAbstainForBlur(
  image: RgbaImage,
  threshold: number = BLUR_ABSTAIN_THRESHOLD,
): boolean {
  return shouldAbstainForBlurScore(computeBlurScore(image), threshold)
}
