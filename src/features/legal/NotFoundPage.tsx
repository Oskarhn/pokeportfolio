import { Link } from '@tanstack/react-router'
import { useDocumentMeta } from '../../ui/useDocumentMeta'
import { PublicFooter } from './LegalLayout'

/**
 * TanStack Router's `notFoundComponent` (wired on the root route in router.tsx — there was none
 * before this). Deliberately shows no path, stack trace or error detail: this is what any unknown
 * URL renders as, authenticated or not, so it must never leak which routes exist or don't.
 */
export function NotFoundPage() {
  useDocumentMeta({ title: 'Page not found', robots: 'noindex, nofollow' })

  return (
    <div className="mx-auto flex w-full max-w-sm flex-1 flex-col items-center justify-center gap-4 py-12 text-center">
      <p className="text-sm font-medium tracking-wide text-slate-500">404</p>
      <h1 className="text-xl font-semibold text-slate-100">Page not found</h1>
      <p className="text-sm text-slate-400">
        There's nothing at this address. It may have moved, or the link may be wrong.
      </p>
      <Link
        to="/"
        className="rounded-full bg-sky-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-sky-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500"
      >
        Go to PokePortfolio
      </Link>
      <div className="mt-8 w-full">
        <PublicFooter />
      </div>
    </div>
  )
}
