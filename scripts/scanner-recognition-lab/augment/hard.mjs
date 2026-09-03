// Composed "phone photo" hard-capture profiles — ported from the pre-existing
// scripts/scanner-visual-benchmark/lib/hard-augment.mjs (P79/P84) so P91's hard-defect numbers stay
// directly comparable to the documented ~0.10-0.11 same-card / ~0.28-0.33 nearest-wrong similarity
// bands that calibrated the owner's real 0.1816 failure (docs/DECISIONS.md D-101 §2).
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
  let cardBuffer = await sharp(inputBuffer)
    .rotate(angle, { background: { ...bg, alpha: 1 } })
    .affine([1, shearX, 0, 1], { background: { ...bg, alpha: 1 } })
    .jpeg({ quality: 92 })
    .toBuffer()
  const cardMeta = await sharp(cardBuffer).metadata()
  const tiltedW = cardMeta.width ?? cardW
  const tiltedH = cardMeta.height ?? cardH

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
      `<svg width="${canvasW}" height="${canvasH}"><defs><radialGradient id="g" cx="35%" cy="25%" r="40%"><stop offset="0%" stop-color="white" stop-opacity="0.7"/><stop offset="100%" stop-color="white" stop-opacity="0"/></radialGradient></defs><rect width="100%" height="100%" fill="url(#g)"/></svg>`,
    )
    const shadowSvg = Buffer.from(
      `<svg width="${canvasW}" height="${canvasH}"><defs><linearGradient id="s" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="black" stop-opacity="0"/><stop offset="100%" stop-color="black" stop-opacity="0.35"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#s)"/></svg>`,
    )
    composed = composed
      .composite([
        { input: glareSvg, blend: 'screen' },
        { input: shadowSvg, blend: 'multiply' },
      ])
      .blur(rangeFrom(rng, 0.5, 1.4))
  } else if (name === 'skewed-partial-shadow-noisy') {
    const shadowSvg = Buffer.from(
      `<svg width="${canvasW}" height="${canvasH}"><defs><linearGradient id="s2" x1="0" y1="1" x2="1" y2="0"><stop offset="0%" stop-color="black" stop-opacity="0.5"/><stop offset="45%" stop-color="black" stop-opacity="0"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#s2)"/></svg>`,
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

export async function hardAugmentAll(imageBuffer, cardId, profiles = HARD_AUGMENTATION_PROFILES) {
  const baseSeed = [...cardId].reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) | 0, 13)
  const results = []
  for (let i = 0; i < profiles.length; i += 1) {
    const profile = profiles[i]
    const idx = HARD_AUGMENTATION_PROFILES.indexOf(profile)
    const composed = await composeHardQuery(profile, imageBuffer, baseSeed + idx * 131)
    results.push({ profile, ...composed })
  }
  return results
}

/** Crops a hard-query buffer down to its nominal (guide-aligned) rect — the "simple crop" the
 *  production pipeline performs before rectify/embed, reused by several P91 experiments. */
export async function cropToNominalRect(buffer, nominalRect, canvasW, canvasH) {
  const left = Math.max(0, Math.min(Math.round(nominalRect.left), canvasW - 1))
  const top = Math.max(0, Math.min(Math.round(nominalRect.top), canvasH - 1))
  const right = Math.max(
    left + 1,
    Math.min(Math.round(nominalRect.left + nominalRect.width), canvasW),
  )
  const bottom = Math.max(
    top + 1,
    Math.min(Math.round(nominalRect.top + nominalRect.height), canvasH),
  )
  return sharp(buffer)
    .extract({ left, top, width: right - left, height: bottom - top })
    .jpeg({ quality: 90 })
    .toBuffer()
}
