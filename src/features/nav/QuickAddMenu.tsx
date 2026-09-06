import { Link } from '@tanstack/react-router'
import { Sheet } from '../../ui/Sheet'
import { SearchIcon, PlusIcon, CameraIcon, ChartIcon, TagIcon, BoxIcon } from '../../ui/icons'

/**
 * The central + action. "Scan card" opens the real M15 scanner route (one dedicated /scan route,
 * D-006): on-device recognition with explicit confirmation before anything is added.
 */
export function QuickAddMenu({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <>
      <Sheet open={open} onClose={onClose} title="Add">
        <div className="flex flex-col gap-2">
          <Link
            to="/catalog"
            onClick={onClose}
            className="flex min-h-14 items-center gap-3 rounded-xl border border-slate-800 px-4 text-sm font-medium text-slate-100 hover:bg-slate-800/60"
          >
            <SearchIcon className="size-5 text-slate-400" />
            <span>
              Add card
              <span className="block text-xs font-normal text-slate-500">
                Find a single card in the catalog and add it
              </span>
            </span>
          </Link>
          <Link
            to="/portfolio/sealed/new"
            onClick={onClose}
            className="flex min-h-14 items-center gap-3 rounded-xl border border-slate-800 px-4 text-sm font-medium text-slate-100 hover:bg-slate-800/60"
          >
            <BoxIcon className="size-5 text-slate-400" />
            <span>
              Add sealed product
              <span className="block text-xs font-normal text-slate-500">
                Booster box, ETB, tin and more
              </span>
            </span>
          </Link>
          <Link
            to="/openings/new"
            onClick={onClose}
            className="flex min-h-14 items-center gap-3 rounded-xl border border-slate-800 px-4 text-sm font-medium text-slate-100 hover:bg-slate-800/60"
          >
            <BoxIcon className="size-5 text-slate-400" />
            <span>
              Open sealed product
              <span className="block text-xs font-normal text-slate-500">
                Record packs you opened and the cards you pulled
              </span>
            </span>
          </Link>
          <Link
            to="/purchases/new"
            onClick={onClose}
            className="flex min-h-14 items-center gap-3 rounded-xl border border-slate-800 px-4 text-sm font-medium text-slate-100 hover:bg-slate-800/60"
          >
            <ChartIcon className="size-5 text-slate-400" />
            <span>
              Record purchase
              <span className="block text-xs font-normal text-slate-500">
                Add a receipt with cards, shipping or accessories
              </span>
            </span>
          </Link>
          <Link
            to="/sales/new"
            onClick={onClose}
            className="flex min-h-14 items-center gap-3 rounded-xl border border-slate-800 px-4 text-sm font-medium text-slate-100 hover:bg-slate-800/60"
          >
            <TagIcon className="size-5 text-slate-400" />
            <span>
              Record sale
              <span className="block text-xs font-normal text-slate-500">
                Sell cards you own, with the exact lot and price
              </span>
            </span>
          </Link>
          <Link
            to="/portfolio/manual/new"
            onClick={onClose}
            className="flex min-h-14 items-center gap-3 rounded-xl border border-slate-800 px-4 text-sm font-medium text-slate-100 hover:bg-slate-800/60"
          >
            <PlusIcon className="size-5 text-slate-400" />
            <span>
              Add card manually
              <span className="block text-xs font-normal text-slate-500">
                For a card the catalog does not list
              </span>
            </span>
          </Link>
          <Link
            to="/scan"
            onClick={onClose}
            className="flex min-h-14 items-center gap-3 rounded-xl border border-slate-800 px-4 text-sm font-medium text-slate-100 hover:bg-slate-800/60"
          >
            <CameraIcon className="size-5 text-slate-400" />
            <span>
              Scan card
              <span className="block text-xs font-normal text-slate-500">
                Identify cards with your camera, then confirm
              </span>
            </span>
          </Link>
        </div>
      </Sheet>
    </>
  )
}
