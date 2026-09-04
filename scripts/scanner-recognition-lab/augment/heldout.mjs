// P100: genuinely held-out QUERY-side distortions for benchmark validation, built specifically to
// be structurally incapable of the P95/P98 leakage shape (a query byte-identical to one of its own
// card's reference-augmentation ingredients).
//
// Three independent safeguards, not just "a different seed":
//   1. A DIFFERENT transform implementation per effect than augment/photometric.mjs (the reference-
//      augmentation module) or augment/continuous.mjs uses — different sharp operations, different
//      parameter families, sometimes a mechanic neither existing module has at all (crop/
//      translation). Even a coincidentally-equal seed could never reproduce byte-identical output,
//      because the actual pixel operations differ.
//   2. A DIFFERENT seed derivation (`'heldout::' + cardId`, multiplier base 151, distinct from
//      photometric.mjs's un-prefixed cardId + idx*97 and continuous.mjs's un-prefixed cardId with
//      base 41) — belt-and-suspenders, not the primary defense.
//   3. Every benchmark that uses this module is REQUIRED to additionally run
//      retrieval/leakage-guard.mjs's runtime hash check before recording a result — this module
//      reduces the risk of a leak to near-zero by construction, the guard makes it structurally
//      impossible to ship a result if one somehow still occurred.
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
function heldoutSeed(cardId, salt) {
  const tagged = `heldout::${cardId}::${salt}`
  let seed = 151
  for (const ch of tagged) seed = (seed * 151 + ch.charCodeAt(0)) | 0
  return seed
}

/** Named held-out regimes. `clean` is the pristine control (identity, no transform at all — never
 *  routed through this module's rng at all, so it can never coincide with anything). Every other
 *  regime is deliberately NOT a member of photometric.mjs's AUGMENTATION_PROFILES or
 *  continuous.mjs's axis set — new names, new code paths. */
export const HELDOUT_REGIMES = [
  'clean',
  'heldoutGeometry',
  'heldoutMildPerspective',
  'heldoutCropTranslation',
  'heldoutBlur',
  'heldoutExposureWhiteBalance',
  'heldoutGlare',
  'mixedModerate',
]

async function heldoutGeometry(buffer, cardId) {
  // Rotate via a raw affine matrix (not sharp's `.rotate()` convenience the OTHER two modules both
  // use) — a genuinely different code path even though the visual effect (rotation) rhymes.
  const rng = mulberry32(heldoutSeed(cardId, 'geometry'))
  const angleRad = (rangeFrom(rng, -8, 8) * Math.PI) / 180
  const cos = Math.cos(angleRad)
  const sin = Math.sin(angleRad)
  const meta = await sharp(buffer).metadata()
  const width = meta.width ?? 400
  return sharp(buffer)
    .affine([cos, -sin, sin, cos], { background: { r: 35, g: 35, b: 35, alpha: 1 } })
    .resize(Math.round(width * 0.72))
    .jpeg({ quality: 87 })
    .toBuffer()
}

async function heldoutMildPerspective(buffer, cardId) {
  // A true two-axis shear (both X and Y simultaneously) approximating an off-axis lens/homography
  // view — photometric.mjs's 'perspective-rotate' only ever rotates; continuous.mjs's
  // applyPerspective shears on ONE axis. Two simultaneous shear axes is a distinct code shape.
  const rng = mulberry32(heldoutSeed(cardId, 'mild-perspective'))
  const shearX = rangeFrom(rng, -0.06, 0.06)
  const shearY = rangeFrom(rng, -0.04, 0.04)
  const meta = await sharp(buffer).metadata()
  const width = meta.width ?? 400
  return sharp(buffer)
    .affine([1, shearX, shearY, 1], { background: { r: 35, g: 35, b: 35, alpha: 1 } })
    .resize(Math.round(width * 0.74))
    .jpeg({ quality: 87 })
    .toBuffer()
}

async function heldoutCropTranslation(buffer, cardId) {
  // A mechanic neither photometric.mjs nor continuous.mjs has at all: crop a sub-region smaller
  // than the source, then composite it off-center onto a padded canvas — simulates imperfect guide
  // alignment (the card not perfectly filling the capture frame), never a full-frame transform.
  const rng = mulberry32(heldoutSeed(cardId, 'crop-translation'))
  const meta = await sharp(buffer).metadata()
  const width = meta.width ?? 400
  const height = meta.height ?? 560
  const cropFrac = rangeFrom(rng, 0.86, 0.95)
  const cropW = Math.round(width * cropFrac)
  const cropH = Math.round(height * cropFrac)
  const left = Math.round(rangeFrom(rng, 0, width - cropW))
  const top = Math.round(rangeFrom(rng, 0, height - cropH))
  const cropped = await sharp(buffer).extract({ left, top, width: cropW, height: cropH }).toBuffer()
  // Canvas sized to always contain the crop (padding on top, never smaller than it) — the padding
  // itself is what creates room for the translation offset below.
  const paddingX = Math.max(2, Math.round(width * 0.1))
  const paddingY = Math.max(2, Math.round(height * 0.1))
  const canvasW = cropW + paddingX
  const canvasH = cropH + paddingY
  const offsetX = Math.round(rangeFrom(rng, 0, paddingX))
  const offsetY = Math.round(rangeFrom(rng, 0, paddingY))
  return sharp({
    create: { width: canvasW, height: canvasH, channels: 3, background: { r: 40, g: 40, b: 38 } },
  })
    .composite([{ input: cropped, left: offsetX, top: offsetY }])
    .jpeg({ quality: 88 })
    .toBuffer()
}

async function heldoutBlur(buffer, cardId) {
  // A 5x5 box/motion-style convolution kernel — NOT sharp's `.blur()` (a true Gaussian, the only
  // blur mechanism either existing module uses). A box kernel has a flat frequency response very
  // different from Gaussian, so this genuinely exercises a different degradation, not just a
  // different sigma of the same one.
  const rng = mulberry32(heldoutSeed(cardId, 'blur'))
  const strength = rangeFrom(rng, 0.5, 1)
  const kernelSize = strength > 0.75 ? 5 : 3
  const kernel = new Array(kernelSize * kernelSize).fill(1 / (kernelSize * kernelSize))
  return sharp(buffer)
    .convolve({ width: kernelSize, height: kernelSize, kernel })
    .jpeg({ quality: 85 })
    .toBuffer()
}

async function heldoutExposureWhiteBalance(buffer, cardId) {
  // Color-temperature (tint) shift + linear exposure gain — photometric.mjs's brightness-contrast
  // profile uses `.modulate({brightness,saturation})` + `.linear()`; continuous.mjs's brightness
  // axis uses `.modulate({brightness})` alone. `.tint()` (per-channel color cast, simulating warm/
  // cool white balance) is used by NEITHER existing module anywhere in this lab.
  const rng = mulberry32(heldoutSeed(cardId, 'exposure-wb'))
  const warmth = rng() < 0.5
  const tint = warmth
    ? {
        r: Math.round(rangeFrom(rng, 200, 255)),
        g: Math.round(rangeFrom(rng, 190, 230)),
        b: Math.round(rangeFrom(rng, 150, 200)),
      }
    : {
        r: Math.round(rangeFrom(rng, 170, 210)),
        g: Math.round(rangeFrom(rng, 200, 235)),
        b: Math.round(rangeFrom(rng, 220, 255)),
      }
  const gain = rangeFrom(rng, 0.85, 1.2)
  return sharp(buffer).tint(tint).linear(gain, 0).jpeg({ quality: 86 }).toBuffer()
}

async function heldoutGlare(buffer, cardId) {
  // An elliptical LINEAR band highlight blended with 'lighten' — photometric.mjs's glare-overlay
  // uses a radial gradient blended with 'screen'. Different geometry AND different blend mode.
  const rng = mulberry32(heldoutSeed(cardId, 'glare'))
  const meta = await sharp(buffer).metadata()
  const width = meta.width ?? 400
  const height = meta.height ?? 560
  const bandAngle = Math.round(rangeFrom(rng, -25, 25))
  const opacity = rangeFrom(rng, 0.35, 0.6)
  const svg = Buffer.from(
    `<svg width="${width}" height="${height}"><defs><linearGradient id="g" gradientTransform="rotate(${bandAngle})"><stop offset="35%" stop-color="white" stop-opacity="0"/><stop offset="50%" stop-color="white" stop-opacity="${opacity}"/><stop offset="65%" stop-color="white" stop-opacity="0"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/></svg>`,
  )
  return sharp(buffer)
    .composite([{ input: svg, blend: 'lighten' }])
    .jpeg({ quality: 84 })
    .toBuffer()
}

/** A mild composite of several held-out effects together — independent of continuous.mjs's
 *  IPHONE_LIKE_LEVELS preset (different axes composed, different order, different implementation
 *  of every individual step). Order: geometry -> exposure/WB -> glare -> blur, mirroring a
 *  plausible physical capture pipeline without reusing continuous.mjs's own ordering rationale. */
async function mixedModerate(buffer, cardId) {
  let buf = await heldoutMildPerspective(buffer, cardId)
  buf = await heldoutExposureWhiteBalance(buf, cardId)
  const rng = mulberry32(heldoutSeed(cardId, 'mixed-glare-decision'))
  if (rng() < 0.6) buf = await heldoutGlare(buf, cardId)
  const blurRng = mulberry32(heldoutSeed(cardId, 'mixed-blur'))
  if (blurRng() < 0.7) {
    buf = await sharp(buf)
      .convolve({ width: 3, height: 3, kernel: new Array(9).fill(1 / 9) })
      .jpeg({ quality: 85 })
      .toBuffer()
  }
  return buf
}

const IMPLEMENTATIONS = {
  heldoutGeometry,
  heldoutMildPerspective,
  heldoutCropTranslation,
  heldoutBlur,
  heldoutExposureWhiteBalance,
  heldoutGlare,
  mixedModerate,
}

/** Applies one named held-out regime to `buffer`. `'clean'` returns `buffer` UNCHANGED (the
 *  pristine control) — deliberately never touched by this module's rng at all. */
export async function applyHeldoutRegime(regimeName, buffer, cardId) {
  if (regimeName === 'clean') return buffer
  const impl = IMPLEMENTATIONS[regimeName]
  if (!impl) throw new Error(`Unknown held-out regime: ${regimeName}`)
  return impl(buffer, cardId)
}

/** Builds all held-out query buffers for one card in one call — convenience for benchmark scripts
 *  that need every regime per card. Returns `{ regimeName: buffer }`. */
export async function buildAllHeldoutQueries(buffer, cardId, regimes = HELDOUT_REGIMES) {
  const out = {}
  for (const regime of regimes) out[regime] = await applyHeldoutRegime(regime, buffer, cardId)
  return out
}
