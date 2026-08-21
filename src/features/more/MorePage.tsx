import { Link } from '@tanstack/react-router'
import { useAuth } from '../../auth/useAuth'

/**
 * More: secondary real functionality (M7 prompt §21/§91). Only what genuinely exists today — no
 * disabled future-feature graveyard. Admin invitations moves here from the top-level nav it used
 * to occupy, matching the owner's requirement that More, not the primary bar, hosts it.
 */
export function MorePage() {
  const { isAdmin } = useAuth()

  return (
    <div className="mx-auto w-full max-w-md space-y-6 py-2">
      <h1 className="text-2xl font-semibold tracking-tight text-slate-100">More</h1>

      <nav className="divide-y divide-slate-800 rounded-lg border border-slate-800">
        {isAdmin ? (
          <Link
            to="/admin/invitations"
            className="flex min-h-14 items-center justify-between px-4 text-sm font-medium text-slate-100 hover:bg-slate-800/60"
          >
            Invitations
            <span aria-hidden className="text-slate-500">
              ›
            </span>
          </Link>
        ) : null}
        <Link
          to="/profile"
          className="flex min-h-14 items-center justify-between px-4 text-sm font-medium text-slate-100 hover:bg-slate-800/60"
        >
          Profile and display settings
          <span aria-hidden className="text-slate-500">
            ›
          </span>
        </Link>
      </nav>

      <section className="space-y-1 rounded-lg border border-slate-800 p-4 text-sm text-slate-400">
        <p className="font-medium text-slate-300">PokePortfolio</p>
        <p>A private, invite-only Pokémon TCG collection and spending tracker.</p>
      </section>
    </div>
  )
}
