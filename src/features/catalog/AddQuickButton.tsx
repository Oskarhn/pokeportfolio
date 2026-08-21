import { useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { getCardVariants } from '../../data/catalog'
import { PlusIcon } from '../../ui/icons'

/**
 * The per-result quick-add + (M7 prompt §15-17). Independently clickable from the card row it
 * sits beside — a sibling `<button>`, never a `<button>` nested inside the row's own `<Link>`,
 * which both stops a tap on + from also navigating to card detail and avoids the invalid-HTML
 * interactive-inside-interactive shape a nested version would produce.
 *
 * Reuses the exact M6 add flow, nothing new: a card with exactly one ownable variant goes
 * straight to `/add`; a card with several is sent to its detail page, which already lists every
 * variant with its own "Add to collection" action — that page *is* the required variant-selection
 * step, so this button does not duplicate it.
 */
export function AddQuickButton({ cardId, cardName }: { cardId: string; cardName: string }) {
  const navigate = useNavigate()
  const [state, setState] = useState<'idle' | 'checking' | 'error'>('idle')

  async function handleClick() {
    setState('checking')
    try {
      const variants = await getCardVariants(cardId)
      const onlyVariant = variants.length === 1 ? variants[0] : undefined
      if (onlyVariant) {
        await navigate({ to: '/add', search: { variantId: onlyVariant.id } })
        return
      }
      await navigate({ to: '/catalog/$cardId', params: { cardId } })
    } catch {
      setState('error')
      return
    }
    setState('idle')
  }

  return (
    <button
      type="button"
      aria-label={`Add ${cardName} to your Portfolio`}
      disabled={state === 'checking'}
      onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        void handleClick()
      }}
      className="flex size-9 shrink-0 items-center justify-center rounded-full border border-slate-700 text-slate-300 hover:border-sky-500 hover:bg-sky-600/20 hover:text-sky-200 disabled:opacity-60"
      title={state === 'error' ? 'Could not check variants — try again' : 'Add to Portfolio'}
    >
      <PlusIcon className="size-4" />
    </button>
  )
}
