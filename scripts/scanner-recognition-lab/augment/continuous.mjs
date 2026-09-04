// P95 §2: continuous-severity synthetic distortions, one independently controllable axis at a
// time (levels 0-5), plus a few pairwise interactions and a realistic "iPhone-like moderate"
// preset (§17). Deliberately NOT a canvas-composite like augment/hard.mjs's catastrophic profiles
// (P91) — this operates directly on the card image so a large stratified sweep stays cheap. Each
// step re-encodes to JPEG, matching how sequential real-world capture degradation actually stacks
// (recompression at each stage), not a single clean composite.
import sharp from 'sharp'

function mulberry32(seed) {
  let a = seed
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
function rangeFrom(rng, min, max) {
  return min + rng() * (max - min)
}
function gaussianNoise(rng) {
  const u1 = Math.max(rng(), 1e-9)
  const u2 = rng()
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
}

export const AXES = ['blur', 'shadow', 'glare', 'noise', 'perspective', 'brightness']
export const NUM_LEVELS = 6 // indices 0..5

// Per-axis severity scales. brightness is bidirectional (dark -> normal -> blown); index 3 is
// "normal" so brightness:0 (the shared no-defect baseline for every other axis) still means
// "untouched," matching the other five axes' index-0-means-nothing convention.
export const SCALES = {
  blur: [0, 0.6, 1.2, 2.0, 3.2, 5.0], // gaussian sigma
  shadow: [0, 0.12, 0.24, 0.38, 0.55, 0.75], // gradient darkening opacity
  glare: [0, 0.15, 0.3, 0.45, 0.6, 0.8], // radial highlight opacity
  noise: [0, 5, 12, 22, 35, 55], // gaussian stddev, 0-255 scale
  perspective: [0, 2, 4, 7, 11, 16], // rotation degrees magnitude (+ proportional shear)
  brightness: [0.32, 0.55, 0.8, 1.0, 1.4, 1.9], // modulate() brightness multiplier
}
export const BRIGHTNESS_NORMAL_LEVEL = 3

const BG = { r: 210, g: 210, b: 205, alpha: 1 }

async function applyPerspective(buffer, angleDeg, rng) {
  if (angleDeg <= 0) return buffer
  const sign = rng() < 0.5 ? -1 : 1
  const shear = rangeFrom(rng, -angleDeg / 45, angleDeg / 45)
  return sharp(buffer)
    .rotate(angleDeg * sign, { background: BG })
    .affine([1, shear, 0, 1], { background: BG })
    .jpeg({ quality: 90 })
    .toBuffer()
}

async function applyBrightness(buffer, mult) {
  if (mult === 1) return buffer
  return sharp(buffer).modulate({ brightness: mult }).jpeg({ quality: 90 }).toBuffer()
}

async function applyShadow(buffer, opacity) {
  if (opacity <= 0) return buffer
  const meta = await sharp(buffer).metadata()
  const w = meta.width ?? 400
  const h = meta.height ?? 560
  const svg = Buffer.from(
    `<svg width="${w}" height="${h}"><defs><linearGradient id="s" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="black" stop-opacity="0"/><stop offset="100%" stop-color="black" stop-opacity="${opacity}"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#s)"/></svg>`,
  )
  return sharp(buffer)
    .composite([{ input: svg, blend: 'multiply' }])
    .jpeg({ quality: 90 })
    .toBuffer()
}

async function applyGlare(buffer, opacity) {
  if (opacity <= 0) return buffer
  const meta = await sharp(buffer).metadata()
  const w = meta.width ?? 400
  const h = meta.height ?? 560
  const svg = Buffer.from(
    `<svg width="${w}" height="${h}"><defs><radialGradient id="g" cx="35%" cy="25%" r="40%"><stop offset="0%" stop-color="white" stop-opacity="${opacity}"/><stop offset="100%" stop-color="white" stop-opacity="0"/></radialGradient></defs><rect width="100%" height="100%" fill="url(#g)"/></svg>`,
  )
  return sharp(buffer)
    .composite([{ input: svg, blend: 'screen' }])
    .jpeg({ quality: 90 })
    .toBuffer()
}

async function addNoise(buffer, stddev, rng) {
  if (stddev <= 0) return buffer
  const { data, info } = await sharp(buffer)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const out = Buffer.from(data)
  for (let i = 0; i < out.length; i += 1) {
    const n = gaussianNoise(rng) * stddev
    out[i] = Math.max(0, Math.min(255, Math.round(out[i] + n)))
  }
  return sharp(out, { raw: { width: info.width, height: info.height, channels: info.channels } })
    .jpeg({ quality: 88 })
    .toBuffer()
}

async function applyBlur(buffer, sigma) {
  if (sigma <= 0) return buffer
  return sharp(buffer).blur(sigma).jpeg({ quality: 86 }).toBuffer()
}

/**
 * levels: { blur?, shadow?, glare?, noise?, perspective?, brightness? } — each an index 0-5 into
 * SCALES (brightness defaults to BRIGHTNESS_NORMAL_LEVEL=3="no change", every other axis defaults
 * to 0="no change"). Order (perspective -> brightness -> shadow -> glare -> noise -> blur)
 * mirrors a plausible physical capture pipeline (geometry first, then lighting, then lens/motion
 * blur last) and is fixed across every call for reproducibility.
 */
export async function composeContinuous(buffer, cardId, levels = {}) {
  const seed = [...cardId].reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) | 0, 41)
  const rng = mulberry32(seed)
  let buf = buffer
  buf = await applyPerspective(buf, SCALES.perspective[levels.perspective ?? 0], rng)
  buf = await applyBrightness(buf, SCALES.brightness[levels.brightness ?? BRIGHTNESS_NORMAL_LEVEL])
  buf = await applyShadow(buf, SCALES.shadow[levels.shadow ?? 0])
  buf = await applyGlare(buf, SCALES.glare[levels.glare ?? 0])
  buf = await addNoise(buf, SCALES.noise[levels.noise ?? 0], rng)
  buf = await applyBlur(buf, SCALES.blur[levels.blur ?? 0])
  return buf
}

/** §17: a realistic "iPhone-like moderate" preset — mild sleeve glare, small shadow, minor focus
 *  error, warm/slightly dim room light, small perspective error. Tuned empirically (see
 *  experiments/11-iphone-like-profile.mjs) to land same-card similarity roughly in 0.5-0.8, the
 *  gap D-101/P91 identified between geometry-only (~0.80-0.90) and catastrophic (~0.13). */
export const IPHONE_LIKE_LEVELS = {
  blur: 2,
  shadow: 1,
  glare: 1,
  noise: 1,
  perspective: 2,
  brightness: 2,
}
