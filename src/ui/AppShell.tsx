import type { ReactNode } from 'react'

interface AppShellProps {
  children: ReactNode
}

/**
 * Minimal application frame. Proves the routing and styling stack works;
 * intentionally has no product content — that starts at M6.
 */
export function AppShell({ children }: AppShellProps) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header
        className="flex items-center border-b border-slate-800 px-4 py-3"
        style={{ paddingTop: 'max(0.75rem, env(safe-area-inset-top))' }}
      >
        <span className="text-sm font-medium tracking-wide text-slate-300">PokePortfolio</span>
      </header>
      <main
        className="flex-1 px-4 py-6"
        style={{ paddingBottom: 'max(1.5rem, env(safe-area-inset-bottom))' }}
      >
        {children}
      </main>
    </div>
  )
}
