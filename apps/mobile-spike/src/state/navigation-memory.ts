import type { Resettable } from './registry'

/**
 * Where the person is in the app, kept in memory for the life of the JS runtime (P167).
 *
 * Android recreates the Activity on a configuration change the app does not declare (font size,
 * display size, language). The JS runtime survives, but React Native mounts a new root, and the
 * navigation tree started again at the collection list: the person lost their place (and, on the
 * photo screen, their photo). The navigation container restores from here instead.
 *
 * User-scoped: registered with the identity boundary, so user B can never be restored into user A's
 * screens (a route can carry a holding id). Nothing is persisted to disk.
 */
export class NavigationMemory<State extends object = object> implements Resettable {
  private state: State | undefined

  get(): State | undefined {
    return this.state
  }

  set(state: State | undefined): void {
    this.state = state
  }

  reset(): void {
    this.state = undefined
  }
}

const TRANSIENT_PARAMS = ['screen', 'state', 'initial', 'params', 'path'] as const

/**
 * A navigation state that is safe to restore.
 *
 * A cross-navigator navigate ("Price Check -> Search / photo entry") leaves the transient
 * `{ screen, params, initial, state }` on the target tab's route params. That is an instruction, not
 * a place: React Navigation applies it again when a restored navigator mounts, on top of the nested
 * state the person had actually reached (seen on the emulator in P170: after an Activity recreation
 * the Search tab jumped back to the photo entry instead of the search screen). The nested `state` is
 * the truth, so the instruction is dropped, at every level.
 */
export function restorableNavigationState<T>(state: T): T {
  if (typeof state !== 'object' || state === null) return state
  const copy = { ...(state as Record<string, unknown>) }
  if (Array.isArray(copy.routes)) {
    copy.routes = (copy.routes as Record<string, unknown>[]).map((route) => {
      const next = { ...route }
      const params = next.params
      if (typeof params === 'object' && params !== null) {
        const kept = Object.fromEntries(
          Object.entries(params as Record<string, unknown>).filter(
            ([key]) => !(TRANSIENT_PARAMS as readonly string[]).includes(key),
          ),
        )
        if (Object.keys(kept).length === 0) delete next.params
        else next.params = kept
      }
      if (next.state !== undefined) next.state = restorableNavigationState(next.state)
      return next
    })
  }
  return copy as T
}
