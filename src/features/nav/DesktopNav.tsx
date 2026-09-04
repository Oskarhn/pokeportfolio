import { useState, type ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { useAuth } from '../../auth/useAuth'
import { HomeIcon, SearchIcon, PortfolioIcon, ProfileIcon, PlusIcon } from '../../ui/icons'
import { QuickAddMenu } from './QuickAddMenu'

/**
 * Desktop navigation (M7.1 prompt §9): Home / Search / Portfolio / Profile plus Add — the same
 * four primary destinations as the mobile bar, no More. No wordmark here any more (§10) — brand
 * lives on Home and the auth screens, not repeated in every screen's chrome.
 */
export function DesktopNav() {
  const { signOut } = useAuth()
  const [addOpen, setAddOpen] = useState(false)

  return (
    <>
      <header
        className="sticky top-0 z-30 hidden items-center gap-1 border-b border-slate-800/70 bg-slate-950/85 px-4 py-2 backdrop-blur-xl md:flex"
        style={{ paddingTop: 'max(0.5rem, env(safe-area-inset-top))' }}
      >
        <nav aria-label="Primary" className="flex items-center gap-1">
          <NavLink to="/" label="Home" icon={<HomeIcon className="size-4" />} />
          <NavLink to="/catalog" label="Search" icon={<SearchIcon className="size-4" />} />
          <NavLink to="/portfolio" label="Portfolio" icon={<PortfolioIcon className="size-4" />} />
          <NavLink to="/profile" label="Profile" icon={<ProfileIcon className="size-4" />} />
        </nav>
        <button
          type="button"
          onClick={() => {
            setAddOpen(true)
          }}
          className="ml-4 flex min-h-9 items-center gap-1.5 rounded-full bg-sky-600 px-3 text-sm font-semibold text-accent-foreground hover:bg-sky-500"
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
      className="flex min-h-9 items-center gap-1.5 rounded-full px-3 text-sm font-medium text-slate-400 hover:bg-slate-800 hover:text-slate-200"
      activeProps={{ className: 'bg-slate-800 text-slate-100' }}
    >
      {icon}
      {label}
    </Link>
  )
}
