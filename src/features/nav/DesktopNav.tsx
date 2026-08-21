import { useState, type ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { useAuth } from '../../auth/useAuth'
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
 * Desktop navigation (M7 prompt §11): the same five destinations plus Add, in a layout suited to
 * a wide viewport rather than a literal copy of the mobile bottom bar (DESIGN_SYSTEM.md §4.2:
 * sidebar/top nav at ≥768px, not a stretched phone tab bar).
 */
export function DesktopNav() {
  const { signOut } = useAuth()
  const [addOpen, setAddOpen] = useState(false)

  return (
    <>
      <header
        className="hidden items-center gap-1 border-b border-slate-800 px-4 py-2 md:flex"
        style={{ paddingTop: 'max(0.5rem, env(safe-area-inset-top))' }}
      >
        <span className="mr-4 text-sm font-medium tracking-wide text-slate-300">PokePortfolio</span>
        <nav aria-label="Primary" className="flex items-center gap-1">
          <NavLink to="/" label="Home" icon={<HomeIcon className="size-4" />} />
          <NavLink to="/catalog" label="Search" icon={<SearchIcon className="size-4" />} />
          <NavLink to="/portfolio" label="Portfolio" icon={<PortfolioIcon className="size-4" />} />
          <NavLink to="/more" label="More" icon={<MoreIcon className="size-4" />} />
          <NavLink to="/profile" label="Profile" icon={<ProfileIcon className="size-4" />} />
        </nav>
        <button
          type="button"
          onClick={() => {
            setAddOpen(true)
          }}
          className="ml-4 flex min-h-9 items-center gap-1.5 rounded-lg bg-sky-600 px-3 text-sm font-semibold text-white hover:bg-sky-500"
        >
          <PlusIcon className="size-4" />
          Add
        </button>
        <button
          type="button"
          onClick={() => {
            void signOut()
          }}
          className="ml-auto min-h-9 text-sm text-slate-400 underline-offset-4 hover:text-slate-200 hover:underline"
        >
          Sign out
        </button>
      </header>
      <QuickAddMenu
        open={addOpen}
        onClose={() => {
          setAddOpen(false)
        }}
      />
    </>
  )
}

function NavLink({ to, label, icon }: { to: string; label: string; icon: ReactNode }) {
  return (
    <Link
      to={to}
      activeOptions={{ exact: to === '/' }}
      className="flex min-h-9 items-center gap-1.5 rounded-lg px-3 text-sm font-medium text-slate-400 hover:bg-slate-800 hover:text-slate-200"
      activeProps={{ className: 'bg-slate-800 text-slate-100' }}
    >
      {icon}
      {label}
    </Link>
  )
}
