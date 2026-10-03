/**
 * Catalog identity and variant confirmation for Price Check.
 *
 * A price belongs to ONE exact card variant, so before a price is shown the variant must be
 * unambiguous: either the card has exactly one active variant, or the person explicitly chose one.
 * A card with several variants never gets a silently chosen default — not "the first", not "the
 * priced one", above all not "the most expensive". A scan in particular can identify a printed
 * card from its artwork but cannot tell normal from reverse holo, so it must never decide that.
 */
import type { CardIdentity, VariantFinish, VariantIdentity } from './types'

const FINISH_LABEL: Readonly<Record<VariantFinish, string>> = {
  normal: 'Normal',
  holo: 'Holo',
  reverse: 'Reverse holo',
  other: 'Other finish',
}

/** Human label for a variant: finish, then print-run subtype, then stamp, then size when not standard. */
export function variantLabel(variant: VariantIdentity): string {
  const parts = [FINISH_LABEL[variant.finish], variant.subtype, variant.stamp].filter(
    (part) => part !== '',
  )
  if (variant.size === 'oversized') parts.push('Oversized')
  return parts.join(' · ')
}

export type VariantResolution =
  | {
      readonly status: 'confirmed'
      readonly variant: VariantIdentity
      readonly basis: 'chosen' | 'only_variant'
    }
  /** Several variants and none chosen. Prices may be listed per variant, but none is "the" price. */
  | { readonly status: 'choice_required'; readonly variants: readonly VariantIdentity[] }
  /** A variant id was requested that does not belong to this card (stale link, tampered URL). */
  | {
      readonly status: 'mismatch'
      readonly requestedVariantId: string
      readonly variants: readonly VariantIdentity[]
    }
  | { readonly status: 'no_variants' }

/**
 * Decides which variant a Price Check is about. `requestedVariantId` is what the URL / the person
 * asked for; it is honoured only if it really is a variant of this card.
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

/**
 * Which cards in a result list are indistinguishable by name alone. Name comparison is
 * case-insensitive and whitespace-normalised; the caller uses the returned ids to say
 * "same name as another result — check set and number", it never de-duplicates them away.
 */
export function cardsSharingAName(
  cards: readonly Pick<CardIdentity, 'cardId' | 'name'>[],
): Set<string> {
  const byName = new Map<string, string[]>()
  for (const card of cards) {
    const key = card.name.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en')
    const ids = byName.get(key)
    if (ids === undefined) byName.set(key, [card.cardId])
    else ids.push(card.cardId)
  }
  const shared = new Set<string>()
  for (const ids of byName.values()) {
    if (ids.length > 1) for (const id of ids) shared.add(id)
  }
  return shared
}

/** The dimensions a source does NOT provide, stated explicitly so the UI can say so instead of
 *  implying a breakdown exists. */
export const RAW_UNSUPPORTED_DIMENSIONS = ['raw condition'] as const

export function languageLabel(language: CardIdentity['language']): string {
  return language === 'ja' ? 'Japanese' : 'English'
}
