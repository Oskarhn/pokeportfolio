import { useEffect, useRef, type ReactNode } from 'react'

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * A bottom sheet on mobile, a centred panel on desktop — the one dismissible-overlay primitive
 * the M7 toolbar (sort/density/filters) and quick-add action reuse (DESIGN_SYSTEM.md §5: "own it
 * outright", no component-library runtime dependency). Dismissed by backdrop click, Escape, or an
 * explicit close control inside `children`. 150–250ms transition, `motion-reduce` disables it
 * without breaking layout (DESIGN_SYSTEM.md §10).
 *
 * P112: `role="dialog" aria-modal="true"` is a contract, not just a label — the ARIA Authoring
 * Practices Guide's modal pattern requires focus to move INTO the dialog on open and stay trapped
 * there until it closes. This had neither: a real keyboard-navigation test (Tab through the whole
 * sheet) found focus could leave it after a single Tab press straight into background content.
 * Fixed by focusing the dialog panel itself on open (restoring the trigger's focus on close) and
 * wrapping Tab/Shift+Tab at the panel's own first/last focusable descendant.
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
  const panelRef = useRef<HTMLDivElement>(null)
  const previouslyFocusedRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!open) return
    previouslyFocusedRef.current = document.activeElement as HTMLElement | null
    panelRef.current?.focus()
    return () => {
      previouslyFocusedRef.current?.focus()
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose()
        return
      }
      if (event.key !== 'Tab' || panelRef.current === null) return
      const focusable = Array.from(
        panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      )
      if (focusable.length === 0) {
        event.preventDefault()
        return
      }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const active = document.activeElement
      if (event.shiftKey) {
        if (active === first || !panelRef.current.contains(active)) {
          event.preventDefault()
          last?.focus()
        }
      } else if (active === last || !panelRef.current.contains(active)) {
        event.preventDefault()
        first?.focus()
      }
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
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className="relative w-full max-w-lg rounded-t-2xl border border-slate-800 bg-slate-900 p-4 shadow-xl outline-none motion-reduce:transition-none sm:rounded-2xl sm:p-5"
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
