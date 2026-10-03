import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react'
import type { Runtime } from '../wiring/runtime'

const RuntimeContext = createContext<Runtime | null>(null)

export function RuntimeProvider({ runtime, children }: { runtime: Runtime; children: ReactNode }) {
  return <RuntimeContext.Provider value={runtime}>{children}</RuntimeContext.Provider>
}

export function useRuntime(): Runtime {
  const runtime = useContext(RuntimeContext)
  if (runtime === null) throw new Error('useRuntime outside RuntimeProvider')
  return runtime
}

interface ExternalStore<T> {
  subscribe: (listener: () => void) => () => void
  getSnapshot: () => T
}

export function useStore<T>(store: ExternalStore<T>): T {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}
