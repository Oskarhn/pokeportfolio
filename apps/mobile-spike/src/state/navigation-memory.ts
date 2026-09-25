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
