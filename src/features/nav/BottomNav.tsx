import { useState, type ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import {
  HomeIcon,
  SearchIcon,
  PortfolioIcon,
  MoreIcon,
  ProfileIcon,
  PlusIcon,
} from '../../ui/icons'
import { QuickAddMenu } from './QuickAddMenu'

/**
 * Mobile primary navigation (M7 prompt §9-10, §97). Five direct destinations plus a visually
 * prominent central + action. All five stay individually reachable — the + is an action, never a
 * sixth destination, and none of the five is ever folded into another to make the row look tidier.
 *
 * GEOMETRY. Six equal flex slots: Home, Search, an empty spacer, Portfolio, More, Profile. With
 * six equal-width slots the bar's true horizontal centre falls exactly on the boundary between
 * slot 3 (the spacer) and slot 4 (Portfolio) — so the raised circular + button, positioned
 * independently at `left-1/2`, sits centred over that gap rather than on top of any label. This
 * is what lets five (an odd number) destinations coexist with a genuinely centred action without
 * either a lopsided bar or a cramped six-column label grid (M7 prompt §10).
 *
 * `env(safe-area-inset-bottom)` keeps every tap target clear of the iPhone home indicator
 * (DESIGN_SYSTEM.md §4.2, M7 prompt §97) — the parent AppShell adds matching bottom padding to
 * scrollable content so the bar never covers it.
 */
export function BottomNav() {
  const [addOpen, setAddOpen] = useState(false)

  return (
    <>
      <nav
        aria-label="Primary"
        className="fixed inset-x-0 bottom-0 z-40 border-t border-slate-800 bg-slate-950/95 backdrop-blur md:hidden"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        <div className="relative mx-auto flex h-16 max-w-md items-stretch">
          <NavTab to="/" label="Home" icon={<HomeIcon className="size-6" />} />
          <NavTab to="/catalog" label="Search" icon={<SearchIcon className="size-6" />} />
          <div className="flex-1" aria-hidden />
          <NavTab to="/portfolio" label="Portfolio" icon={<PortfolioIcon className="size-6" />} />
          <NavTab to="/more" label="More" icon={<MoreIcon className="size-6" />} />
          <NavTab to="/profile" label="Profile" icon={<ProfileIcon className="size-6" />} />

          <button
            type="button"
            onClick={() => {
              setAddOpen(true)
            }}
            aria-label="Add"
            className="absolute left-1/2 top-0 flex size-14 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-sky-600 text-white shadow-lg ring-4 ring-slate-950 hover:bg-sky-500 active:bg-sky-700"
          >
            <PlusIcon className="size-7" />
          </button>
        </div>
      </nav>
      <QuickAddMenu
        open={addOpen}
        onClose={() => {
          setAddOpen(false)
        }}
      />
    </>
  )
}

function NavTab({ to, label, icon }: { to: string; label: string; icon: ReactNode }) {
  return (
    <Link
      to={to}
      activeOptions={{ exact: to === '/' }}
      className="flex flex-1 flex-col items-center justify-center gap-0.5 text-slate-400"
      activeProps={{ className: 'text-sky-400' }}
    >
      {icon}
      <span className="text-[10px] font-medium leading-none">{label}</span>
    </Link>
  )
}
