import { useState } from 'react'
import { cardImageUrl, type ImageQuality } from '../../data/catalog'

/**
 * TCGdex has occasional missing assets, and every catalog row is valid with or without one
 * (M5 prompt §25/§55) — a broken or absent image degrades to a neutral placeholder that still
 * carries the card name, never a browser broken-image icon or a blank block.
 */
export function CardImage({
  imageBaseUrl,
  alt,
  quality,
  className = '',
}: {
  imageBaseUrl: string | null
  alt: string
  quality: ImageQuality
  className?: string
}) {
  const [failed, setFailed] = useState(false)
  const src = cardImageUrl(imageBaseUrl, quality)

  if (!src || failed) {
    return (
      <div
        role="img"
        aria-label={alt}
        className={`flex items-center justify-center rounded-md border border-slate-700 bg-slate-800 p-2 text-center text-xs text-slate-400 ${className}`}
      >
        {alt}
      </div>
    )
  }

  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      className={`rounded-md border border-slate-700 bg-slate-900 object-contain ${className}`}
      onError={() => {
        setFailed(true)
      }}
    />
  )
}
