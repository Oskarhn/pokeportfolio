/**
 * Everything that holds USER-SCOPED state registers here, and everything registered is reset when
 * the identity changes. The web app does the same with `queryClient.clear()` +
 * `draftStore.clearAll()` + `scannerSessionStore.clearAll()` in `applyAuthIdentityBoundary`
 * (src/auth/query-cache-boundary.ts, which cannot be imported: it pulls in web feature modules).
 *
 * The reset is synchronous, so state of user A is gone before user B's first render, not "after a
 * new fetch completes".
 */
export interface Resettable {
  reset(): void
}

export class ScopedRegistry {
  private readonly members = new Map<string, Resettable>()

  register(name: string, member: Resettable): void {
    this.members.set(name, member)
  }

  resetAll(): void {
    for (const member of this.members.values()) member.reset()
  }

  get size(): number {
    return this.members.size
  }
}

/** Minimal external-store plumbing shared by every store (for React's useSyncExternalStore). */
export class Emitter {
  private listeners = new Set<() => void>()

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  emit(): void {
    for (const listener of [...this.listeners]) listener()
  }
}
