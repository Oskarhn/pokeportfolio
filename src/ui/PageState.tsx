import type { ReactNode } from 'react'

/**
 * Loading and unavailable states for whole pages (detail, edit and add routes).
 *
 * Two defects these replace (P202): the old skeleton was a bare pulsing <div>, so a screen reader
 * heard nothing for the seconds a slow or retried request took, and the old "could not be found"
 * paragraph had no heading, so a page in that state had no <h1> to land on or navigate by. It also
 * told the user a record was missing when the request had merely failed. Callers now say which
 * of the two happened: pass `onRetry` for a failed load and omit it for a genuinely absent record.
 */

export function PageLoading({
  label = 'Loading',
  className = 'h-64 max-w-2xl rounded-lg',
}: {
  label?: string
  className?: string
}) {
  return (
    <div
      role="status"
      aria-busy="true"
      className={`mx-auto w-full animate-pulse bg-slate-800/60 ${className}`}
    >
      <span className="sr-only">{label}…</span>
    </div>
  )
}

export function PageUnavailable({
  title,
  message,
  onRetry,
  children,
  className = 'max-w-2xl',
}: {
  /** The page heading, e.g. "Sale". Rendered as the <h1> (visually hidden: the message below is the visible text). */
  title: string
  message: string
  /** Present only when the request failed (as opposed to the record not existing). */
  onRetry?: () => void
  /** Navigation out, normally a <Link className={BACK_LINK_CLASS}>. */
  children?: ReactNode
  className?: string
}) {
  return (
    <div className={`mx-auto w-full space-y-4 py-2 ${className}`}>
      <h1 className="sr-only">{title}</h1>
      <p
        role="alert"
        className="rounded-lg border border-rose-900/60 bg-rose-950/40 p-3 text-sm text-rose-200"
      >
        {message}
      </p>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="min-h-11 rounded-lg border border-slate-700 px-4 text-sm font-medium text-slate-200 hover:bg-slate-800"
        >
          Try again
        </button>
      ) : null}
      {children}
    </div>
  )
}

/**
 * Text links inside a sentence-like block must not rely on colour alone (WCAG 1.4.1; axe
 * `link-in-text-block`), so the underline is permanent here rather than hover-only.
 */
export const BACK_LINK_CLASS = 'inline-block text-sm text-sky-400 underline underline-offset-4'

export function unavailableMessage(subject: string, failed: boolean): string {
  return failed
    ? `${subject} could not be loaded. Check your connection and try again.`
    : `${subject} could not be found.`
}
