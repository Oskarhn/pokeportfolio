// Harder, more realistic synthetic phone-capture distortions (P79 §7). The P76 benchmark
// (augment.mjs) resizes/rotates/blurs the REFERENCE image IN PLACE — the query image is still
// "the card, filling the frame, nothing else." That structurally cannot exercise anything this
// session's fixes target: imperfect guide alignment (background visible on one or more sides),
// mild hand-held tilt the guide itself never corrects, or a crop pipeline that has real pixels to
// search around. These profiles instead COMPOSE a synthetic "phone photo": the clean reference
// card, mildly tilted/sheared, placed off-center on a larger background canvas — so a query here
// genuinely needs cropping/rectification before it resembles the tight reference images the index
// was built from, exactly the gap the real real-device diagnostic exposed.
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

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

export const HARD_AUGMENTATION_PROFILES = [
  'tilted-offcenter',
  'tilted-glare-shadow-blur',
  'skewed-partial-shadow-noisy',
]

/**
 * One hard query: composes `inputBuffer` (a clean, tight reference card image) onto a larger
 * background canvas at a jittered position with a mild tilt/shear, then layers profile-specific
 * defects on top. Returns the composed JPEG buffer PLUS `nominalRect` — the position the user
 * would have roughly aimed for (guide-aligned, centered), independent of the actual jittered
 * placement, exactly mirroring what the real app always has available (the guide rect) without
 * ever knowing exactly where the card ended up within it.
 */
async function composeHardQuery(name, inputBuffer, seed) {
  const rng = mulberry32(seed)
  const meta = await sharp(inputBuffer).metadata()
  const cardW = meta.width ?? 400
  const cardH = meta.height ?? 560
  const canvasW = Math.round(cardW * 1.6)
  const canvasH = Math.round(cardH * 1.6)
  const bg = {
    r: Math.round(rangeFrom(rng, 50, 190)),
    g: Math.round(rangeFrom(rng, 50, 190)),
    b: Math.round(rangeFrom(rng, 50, 190)),
  }

  const angle = rangeFrom(rng, -9, 9)
  const shearX = rangeFrom(rng, -0.1, 0.1)
  let cardPipeline = sharp(inputBuffer)
    .rotate(angle, { background: { ...bg, alpha: 1 } })
    .affine([1, shearX, 0, 1], { background: { ...bg, alpha: 1 } })
  let cardBuffer = await cardPipeline.jpeg({ quality: 92 }).toBuffer()
  const cardMeta = await sharp(cardBuffer).metadata()
  const tiltedW = cardMeta.width ?? cardW
  const tiltedH = cardMeta.height ?? cardH

  // Off-center placement (imperfect guide alignment): jitter up to 35% of the available margin.
  const marginX = Math.max(0, canvasW - tiltedW)
  const marginY = Math.max(0, canvasH - tiltedH)
  const offsetX = clamp(
    Math.round(marginX / 2 + rangeFrom(rng, -marginX * 0.35, marginX * 0.35)),
    0,
    marginX,
  )
  const offsetY = clamp(
    Math.round(marginY / 2 + rangeFrom(rng, -marginY * 0.35, marginY * 0.35)),
    0,
    marginY,
  )

  let composed = sharp({
    create: { width: canvasW, height: canvasH, channels: 3, background: bg },
  }).composite([{ input: cardBuffer, left: offsetX, top: offsetY }])

  if (name === 'tilted-glare-shadow-blur') {
    const glareSvg = Buffer.from(
      `<svg width="${canvasW}" height="${canvasH}">
        <defs><radialGradient id="g" cx="35%" cy="25%" r="40%">
          <stop offset="0%" stop-color="white" stop-opacity="0.7"/>
          <stop offset="100%" stop-color="white" stop-opacity="0"/>
        </radialGradient></defs>
        <rect width="100%" height="100%" fill="url(#g)"/>
      </svg>`,
    )
    const shadowSvg = Buffer.from(
      `<svg width="${canvasW}" height="${canvasH}">
        <defs><linearGradient id="s" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="black" stop-opacity="0"/>
          <stop offset="100%" stop-color="black" stop-opacity="0.35"/>
        </linearGradient></defs>
        <rect width="100%" height="100%" fill="url(#s)"/>
      </svg>`,
    )
    composed = composed
      .composite([
        { input: glareSvg, blend: 'screen' },
        { input: shadowSvg, blend: 'multiply' },
      ])
      .blur(rangeFrom(rng, 0.5, 1.4))
  } else if (name === 'skewed-partial-shadow-noisy') {
    const shadowSvg = Buffer.from(
      `<svg width="${canvasW}" height="${canvasH}">
        <defs><linearGradient id="s2" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0%" stop-color="black" stop-opacity="0.5"/>
          <stop offset="45%" stop-color="black" stop-opacity="0"/>
        </linearGradient></defs>
        <rect width="100%" height="100%" fill="url(#s2)"/>
      </svg>`,
    )
    composed = composed
      .composite([{ input: shadowSvg, blend: 'multiply' }])
      .modulate({ brightness: rangeFrom(rng, 0.85, 1.1), saturation: rangeFrom(rng, 0.85, 1.1) })
  }

  const outBuffer = await composed.jpeg({ quality: Math.round(rangeFrom(rng, 65, 85)) }).toBuffer()
  const nominalRect = {
    left: Math.round((canvasW - cardW) / 2),
    top: Math.round((canvasH - cardH) / 2),
    width: cardW,
    height: cardH,
  }
  return { buffer: outBuffer, nominalRect, canvasWidth: canvasW, canvasHeight: canvasH }
}

/** Applies every hard profile to one reference image, seeded from the card id (reproducible). */
export async function hardAugmentAll(imageBuffer, cardId) {
  const baseSeed = [...cardId].reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) | 0, 13)
  const results = []
  for (let i = 0; i < HARD_AUGMENTATION_PROFILES.length; i += 1) {
    const profile = HARD_AUGMENTATION_PROFILES[i]
    const composed = await composeHardQuery(profile, imageBuffer, baseSeed + i * 131)
    results.push({ profile, ...composed })
  }
  return results
}
