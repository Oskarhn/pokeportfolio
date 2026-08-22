import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { Sheet } from '../../ui/Sheet'
import { SearchIcon, PlusIcon, CameraIcon, ChartIcon, TagIcon } from '../../ui/icons'

/**
 * The central + action (M7.1 prompt §24). Shows only what genuinely exists today. "Scan card"
 * establishes the layout the real scanner (M15) will occupy, but never requests camera
 * permission and never runs any capture code — tapping it shows an honest unavailable message
 * (UX_FLOWS.md F11.1, D-006's "scanner owns one route" still applies once it's built).
 */
export function QuickAddMenu({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [scanNotice, setScanNotice] = useState(false)

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
          <button
            type="button"
            onClick={() => {
              setScanNotice(true)
            }}
            className="flex min-h-14 items-center gap-3 rounded-xl border border-slate-800 px-4 text-left text-sm font-medium text-slate-300 hover:bg-slate-800/60"
          >
            <CameraIcon className="size-5 text-slate-500" />
            <span>
              Scan card
              <span className="block text-xs font-normal text-slate-500">Coming later</span>
            </span>
          </button>
        </div>
      </Sheet>
      <Sheet
        open={scanNotice}
        onClose={() => {
          setScanNotice(false)
        }}
        title="Scan card"
      >
        <p className="text-sm text-slate-300">Card scanner is not available yet.</p>
      </Sheet>
    </>
  )
}
