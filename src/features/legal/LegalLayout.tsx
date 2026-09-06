import type { ReactNode } from 'react'
import { Link } from '@tanstack/react-router'

/**
 * Container for the small set of genuinely public, long-form pages (Privacy/Terms/FAQ). Reuses
 * `AuthLayout`'s centred-column idea (`src/ui/form.tsx`) but wider — `max-w-2xl` instead of
 * `max-w-sm` — since these are prose pages, not forms, and don't need `AuthLayout`'s iOS
 * keyboard-offset tuning (no text input on these pages).
 */
export function LegalLayout({
  title,
  updated,
  children,
}: {
  title: string
  /** ISO date the content was last reviewed, shown so "informational, not legal counsel" reads
   *  honestly rather than implying a maintained compliance document. */
  updated: string
  children: ReactNode
}) {
  return (
    <div className="mx-auto w-full max-w-2xl space-y-6 py-6">
      {/* `/` resolves correctly either way: signed-in it's Home, signed-out `RequireSession`
          redirects to `/login` — one link works for both an unauthenticated visitor and a
          signed-in user who reached this page from Profile. */}
      <Link to="/" className="text-sm text-sky-400 underline-offset-4 hover:underline">
        ← Back
      </Link>
      <div className="space-y-1.5">
        <h1 className="text-2xl font-semibold tracking-tight text-slate-100">{title}</h1>
        <p className="text-xs text-slate-500">Last reviewed {updated}</p>
      </div>
      <div className="space-y-4 text-sm leading-relaxed text-slate-300">{children}</div>
      <PublicFooter />
    </div>
  )
}

export function PublicFooter() {
  return (
    <footer className="flex flex-wrap gap-x-4 gap-y-1 border-t border-slate-800 pt-4 text-xs text-slate-500">
      <Link to="/privacy" className="hover:text-slate-300 hover:underline">
        Privacy
      </Link>
      <Link to="/terms" className="hover:text-slate-300 hover:underline">
        Terms
      </Link>
      <Link to="/faq" className="hover:text-slate-300 hover:underline">
        FAQ
      </Link>
    </footer>
  )
}
