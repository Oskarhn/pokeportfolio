import { useEffect, type ReactNode } from 'react'

/**
 * A bottom sheet on mobile, a centred panel on desktop — the one dismissible-overlay primitive
 * the M7 toolbar (sort/density/filters) and quick-add action reuse (DESIGN_SYSTEM.md §5: "own it
 * outright", no component-library runtime dependency). Dismissed by backdrop click, Escape, or an
 * explicit close control inside `children`. 150–250ms transition, `motion-reduce` disables it
 * without breaking layout (DESIGN_SYSTEM.md §10).
 */
export function Sheet({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
}) {
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-slate-950/60 motion-reduce:transition-none"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="relative w-full max-w-lg rounded-t-2xl border border-slate-800 bg-slate-900 p-4 shadow-xl motion-reduce:transition-none sm:rounded-2xl sm:p-5"
        style={{ paddingBottom: 'max(1rem, env(safe-area-inset-bottom))' }}
      >
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-slate-100">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="min-h-9 min-w-9 rounded-lg text-slate-400 hover:bg-slate-800 hover:text-slate-200"
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}
