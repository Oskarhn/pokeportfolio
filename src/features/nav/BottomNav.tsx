import { useState, type ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { HomeIcon, SearchIcon, PortfolioIcon, ProfileIcon, PlusIcon } from '../../ui/icons'
import { QuickAddMenu } from './QuickAddMenu'

/**
 * Mobile primary navigation (M7.1 prompt §7-8, owner decision — supersedes M7's five-tab bar).
 * More is gone; the final structure is intentionally symmetrical:
 *
 *   Home | Search | + | Portfolio | Profile
 *
 * Five equal grid columns — Home, Search, an empty centre column, Portfolio, Profile — puts the
 * bar's true horizontal centre in the middle of that centre column, exactly where the raised
 * circular + sits (absolutely positioned, independent of the grid, per M7's original geometry
 * note — still the correct technique, just over four labelled tabs instead of five). Two
 * destinations left of +, two right: no six-slot spacer trick needed this time, because four is
 * already even.
 *
 * Translucent, blurred chrome (DESIGN_SYSTEM.md §11/owner direction) — content scrolls underneath;
 * AppShell reserves matching bottom padding so the bar never covers it.
 * `env(safe-area-inset-bottom)` keeps every tap target clear of the iPhone home indicator.
 */
export function BottomNav() {
  const [addOpen, setAddOpen] = useState(false)

  return (
    <>
      <nav
        aria-label="Primary"
        className="fixed inset-x-0 bottom-0 z-40 border-t border-slate-800/70 bg-slate-950/85 backdrop-blur-xl md:hidden"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        <div className="relative mx-auto grid h-16 max-w-md grid-cols-5">
          <NavTab to="/" label="Home" icon={<HomeIcon className="size-6" />} />
          <NavTab to="/catalog" label="Search" icon={<SearchIcon className="size-6" />} />
          <div aria-hidden className="pointer-events-none" />
          <NavTab to="/portfolio" label="Portfolio" icon={<PortfolioIcon className="size-6" />} />
          <NavTab to="/profile" label="Profile" icon={<ProfileIcon className="size-6" />} />

          <button
            type="button"
            onClick={() => {
              setAddOpen(true)
            }}
            aria-label="Add"
            className="absolute left-1/2 top-0 flex size-14 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-sky-600 text-accent-foreground shadow-lg ring-4 ring-slate-950/90 transition-transform hover:bg-sky-500 active:scale-95 active:bg-sky-700"
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
      aria-label={label}
      className="flex flex-col items-center justify-center gap-0.5 text-slate-400"
      activeProps={{ 'aria-current': 'page', className: 'text-sky-400' }}
    >
      {icon}
      <span className="text-[10px] font-medium leading-none">{label}</span>
    </Link>
  )
}
