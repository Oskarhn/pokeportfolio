// Deterministic synthetic camera-capture distortions (prompt §12). These approximate real phone
// capture problems well enough to COMPARE recognition methods before another owner device test —
// they are explicitly NOT a substitute for real photos (prompt §12, §62).
import sharp from 'sharp'

// A tiny seeded PRNG (mulberry32) so "deterministic seed" is literal, not "ran once and kept it".
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

/**
 * One named augmentation profile. Each returns a sharp pipeline transform applied to the
 * decoded reference image. Profiles are intentionally moderate (prompt §11's "representative
 * moderate-distortion benchmark", not worst-case adversarial noise.
 */
export const AUGMENTATION_PROFILES = [
  'clean-resize',
  'perspective-rotate',
  'brightness-contrast',
  'blur-jpeg',
  'glare-overlay',
  'shadow-color-shift',
]

async function applyProfile(name, inputBuffer, seed) {
  const rng = mulberry32(seed)
  let pipeline = sharp(inputBuffer).ensureAlpha()
  const meta = await sharp(inputBuffer).metadata()
  const width = meta.width ?? 400
  const height = meta.height ?? 560

  switch (name) {
    case 'clean-resize': {
      // Simulates a well-framed but lower-resolution phone capture. No distortion beyond scale.
      return sharp(inputBuffer)
        .resize(Math.round(width * 0.6))
        .jpeg({ quality: 90 })
        .toBuffer()
    }
    case 'perspective-rotate': {
      const angle = rangeFrom(rng, -6, 6)
      return sharp(inputBuffer)
        .rotate(angle, { background: { r: 20, g: 20, b: 20, alpha: 1 } })
        .resize(Math.round(width * 0.75))
        .jpeg({ quality: 88 })
        .toBuffer()
    }
    case 'brightness-contrast': {
      const brightness = rangeFrom(rng, 0.75, 1.3)
      const saturation = rangeFrom(rng, 0.8, 1.15)
      return sharp(inputBuffer)
        .modulate({ brightness, saturation })
        .linear(rangeFrom(rng, 0.9, 1.25), -10)
        .resize(Math.round(width * 0.7))
        .jpeg({ quality: 85 })
        .toBuffer()
    }
    case 'blur-jpeg': {
      const sigma = rangeFrom(rng, 0.6, 1.8)
      return sharp(inputBuffer)
        .resize(Math.round(width * 0.65))
        .blur(sigma)
        .jpeg({ quality: 55 })
        .toBuffer()
    }
    case 'glare-overlay': {
      // A soft bright ellipse composited over one corner, approximating sleeve glare.
      const outWidth = Math.round(width * 0.7)
      const outHeight = Math.round(height * 0.7)
      const glareSvg = Buffer.from(
        `<svg width="${outWidth}" height="${outHeight}">
          <defs><radialGradient id="g" cx="30%" cy="20%" r="45%">
            <stop offset="0%" stop-color="white" stop-opacity="0.85"/>
            <stop offset="100%" stop-color="white" stop-opacity="0"/>
          </radialGradient></defs>
          <rect width="100%" height="100%" fill="url(#g)"/>
        </svg>`,
      )
      return sharp(inputBuffer)
        .resize(outWidth, outHeight)
        .composite([{ input: glareSvg, blend: 'screen' }])
        .jpeg({ quality: 80 })
        .toBuffer()
    }
    case 'shadow-color-shift': {
      const hueShift = Math.round(rangeFrom(rng, -8, 8))
      const outWidth = Math.round(width * 0.68)
      const outHeight = Math.round(height * 0.68)
      const shadowSvg = Buffer.from(
        `<svg width="${outWidth}" height="${outHeight}">
          <defs><linearGradient id="s" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stop-color="black" stop-opacity="0"/>
            <stop offset="100%" stop-color="black" stop-opacity="0.45"/>
          </linearGradient></defs>
          <rect width="100%" height="100%" fill="url(#s)"/>
        </svg>`,
      )
      return sharp(inputBuffer)
        .resize(outWidth, outHeight)
        .modulate({ hue: hueShift })
        .composite([{ input: shadowSvg, blend: 'multiply' }])
        .jpeg({ quality: 75 })
        .toBuffer()
    }
    default:
      throw new Error(`Unknown augmentation profile: ${name}`)
  }
}

/** Applies every profile to one reference image buffer, seeded from the card id so re-runs are
 *  reproducible. Returns { profile, buffer }[]. */
export async function augmentAll(imageBuffer, cardId) {
  const baseSeed = [...cardId].reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) | 0, 7)
  const results = []
  for (let i = 0; i < AUGMENTATION_PROFILES.length; i += 1) {
    const profile = AUGMENTATION_PROFILES[i]
    const buffer = await applyProfile(profile, imageBuffer, baseSeed + i * 97)
    results.push({ profile, buffer })
  }
  return results
}
