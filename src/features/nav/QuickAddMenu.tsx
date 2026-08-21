import { Link } from '@tanstack/react-router'
import { Sheet } from '../../ui/Sheet'
import { SearchIcon, PlusIcon } from '../../ui/icons'

/**
 * The central + action (M7 prompt §12): the universal fast-add entry point, mobile and desktop
 * alike. Shows only what genuinely exists today — Search/add a catalog card, or add a card the
 * catalog does not list. No Purchase/Sealed/Sale/Scan/Opening entries: those features do not
 * exist yet (UX_FLOWS.md F11.1 — "new actions appear as their milestones land"), and a menu of
 * dead actions is worse than a short one.
 */
export function QuickAddMenu({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Sheet open={open} onClose={onClose} title="Add">
      <div className="flex flex-col gap-2">
        <Link
          to="/catalog"
          onClick={onClose}
          className="flex min-h-14 items-center gap-3 rounded-lg border border-slate-800 px-4 text-sm font-medium text-slate-100 hover:bg-slate-800/60"
        >
          <SearchIcon className="size-5 text-slate-400" />
          <span>
            Search cards
            <span className="block text-xs font-normal text-slate-500">
              Find a card in the catalog and add it
            </span>
          </span>
        </Link>
        <Link
          to="/portfolio/manual/new"
          onClick={onClose}
          className="flex min-h-14 items-center gap-3 rounded-lg border border-slate-800 px-4 text-sm font-medium text-slate-100 hover:bg-slate-800/60"
        >
          <PlusIcon className="size-5 text-slate-400" />
          <span>
            Add card manually
            <span className="block text-xs font-normal text-slate-500">
              For a card the catalog does not list
            </span>
          </span>
        </Link>
      </div>
    </Sheet>
  )
}
