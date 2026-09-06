import { useState } from 'react'
import type { SealedProductType } from '../../data/sealedProducts'
import { SEALED_PRODUCT_TYPE_LABEL } from '../../data/sealedProducts'
import { BoxIcon } from '../../ui/icons'

/**
 * CardImage's sealed-product counterpart (M11). Two real differences from CardImage: `imageUrl`
 * is already a complete URL rather than a base needing a `/quality.webp` suffix (sealed products
 * have no per-quality asset pipeline), and there is no image-upload path at all yet (prompt §13) —
 * so the placeholder is not a fallback for an occasional missing asset, it is the common case,
 * seeded curated rows mostly carry no `image_url`. The placeholder still identifies what the
 * product *is* by product type, never a blank block or a broken-image icon.
 */
export function SealedProductImage({
  imageUrl,
  productType,
  alt,
  className = '',
}: {
  imageUrl: string | null
  productType: SealedProductType
  alt: string
  className?: string
}) {
  const [failed, setFailed] = useState(false)

  if (!imageUrl || failed) {
    return (
      <div
        role="img"
        aria-label={alt}
        className={`flex flex-col items-center justify-center gap-1 rounded-md border border-slate-700 bg-slate-800 p-2 text-center text-slate-300 ${className}`}
      >
        <BoxIcon className="size-6 shrink-0" />
        <span className="text-[10px] leading-tight">{SEALED_PRODUCT_TYPE_LABEL[productType]}</span>
      </div>
    )
  }

  return (
    <img
      src={imageUrl}
      alt={alt}
      loading="lazy"
      className={`rounded-md border border-slate-700 bg-slate-900 object-contain ${className}`}
      onError={() => {
        setFailed(true)
      }}
    />
  )
}
