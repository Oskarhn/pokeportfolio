import { useNavigate } from '@tanstack/react-router'
import { PlusIcon } from '../../ui/icons'

/**
 * Sealed's quick-add + (AddQuickButton's sealed counterpart). Simpler than the card version —
 * there is no variant-selection step to route around, a sealed product identifies a holding on
 * its own, so this goes straight to the add flow with the product pre-selected. A sibling
 * `<button>`, never nested inside the result's own `<Link>`, for the same reason AddQuickButton
 * isn't either: a tap here must not also navigate to product detail.
 */
export function AddSealedQuickButton({ sealedProductId }: { sealedProductId: string }) {
  const navigate = useNavigate()

  return (
    <button
      type="button"
      aria-label="Add to your Portfolio"
      onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        void navigate({ to: '/portfolio/sealed/new', search: { sealedProductId } })
      }}
      className="flex size-9 shrink-0 items-center justify-center rounded-full border border-slate-700 text-slate-300 hover:border-sky-500 hover:bg-sky-600/20 hover:text-sky-200"
      title="Add to Portfolio"
    >
      <PlusIcon className="size-4" />
    </button>
  )
}
