import type { VariantIdentity, VariantResolution } from './types'

/**
 * Decides which variant a Price Check is about. Same statuses and rules as P153's `resolveVariant`
 * (src/domain/price-check/identity.ts): a price belongs to ONE exact variant, so it is shown only when
 * the variant is unambiguous. A card with several variants never gets a silently chosen default (not
 * "the first", not "the priced one"); a requested variant id that is not a variant of THIS card is a
 * mismatch and never falls back to another variant.
 *
 * SPIKE_ONLY: replaced by a re-export of P153's function once it is released.
 */
export function resolveVariant(
  variants: readonly VariantIdentity[],
  requestedVariantId: string | undefined,
): VariantResolution {
  if (variants.length === 0) return { status: 'no_variants' }

  if (requestedVariantId !== undefined) {
    const chosen = variants.find((v) => v.variantId === requestedVariantId)
    return chosen !== undefined
      ? { status: 'confirmed', variant: chosen, basis: 'chosen' }
      : { status: 'mismatch', requestedVariantId, variants }
  }

  const active = variants.filter((v) => v.isActive)
  const [onlyActive] = active
  if (active.length === 1 && onlyActive !== undefined) {
    return { status: 'confirmed', variant: onlyActive, basis: 'only_variant' }
  }
  return { status: 'choice_required', variants }
}

const FINISH_LABEL: Record<VariantIdentity['finish'], string> = {
  normal: 'Normal',
  holo: 'Holo',
  reverse: 'Reverse holo',
  other: 'Other finish',
}

export function variantLabel(variant: VariantIdentity): string {
  const parts = [FINISH_LABEL[variant.finish], variant.subtype, variant.stamp].filter(
    (p) => p !== '',
  )
  if (variant.size === 'oversized') parts.push('Oversized')
  return parts.join(' · ')
}
