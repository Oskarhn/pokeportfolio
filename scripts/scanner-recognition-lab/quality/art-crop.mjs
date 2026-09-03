// Central-artwork crop (§28): removes the outer border/frame/text region, keeping roughly the
// artwork box a standard Pokemon TCG layout places in the upper-middle 2/3 of the card. A fixed
// fractional crop (not layout-detected) — crude but real and cheap, matching this lab's
// no-new-dependency discipline.
import sharp from 'sharp'

export async function artCrop(buffer) {
  const meta = await sharp(buffer).metadata()
  const width = meta.width ?? 400
  const height = meta.height ?? 560
  const left = Math.round(width * 0.08)
  const top = Math.round(height * 0.12)
  const cropWidth = Math.round(width * 0.84)
  const cropHeight = Math.round(height * 0.5)
  return sharp(buffer)
    .extract({ left, top, width: cropWidth, height: cropHeight })
    .jpeg({ quality: 90 })
    .toBuffer()
}
