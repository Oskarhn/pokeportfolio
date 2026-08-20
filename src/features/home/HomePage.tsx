import { useAuth } from '../../auth/useAuth'

/**
 * The signed-in landing page. Still a placeholder for product content — collection, purchases and
 * the dashboard arrive from M5 onwards — but it now proves the thing M4 is about: a session
 * exists, it belongs to a specific account, and it got here by redeeming an invitation.
 */
export function HomePage() {
  const { email, isAdmin } = useAuth()

  return (
    <div className="space-y-3">
      <h1 className="text-2xl font-semibold tracking-tight">PokePortfolio</h1>
      <p className="text-sm text-slate-400">
        Signed in as <span className="text-slate-200">{email ?? '—'}</span>
        {isAdmin ? ' · administrator' : ''}
      </p>
      <p className="text-sm text-slate-400">
        Authentication is in place. Collection, purchases and portfolio screens have not been built
        yet.
      </p>
    </div>
  )
}
