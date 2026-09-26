import { createContext, useContext, type ComponentType, type ReactNode } from 'react'
import type { P169Feature } from './feature'
import type { AddToCollectionIntent } from './price-check/price-check-flow-store'

/**
 * ROUTE / REGISTRATION CONTRACT of the Search / Price Check feature, as integrated in the shell
 * (src/ui/MainNavigator.tsx, src/ui/AppRoot.tsx). The feature never creates a navigator or an
 * identity system: the composition root (src/wiring/runtime.ts) builds it over the runtime's own
 * IdentityAuthority and ScopedRegistry, so an identity change resets its stores synchronously with
 * every other user-scoped store, and its requests are leased from that one authority. The shell
 *
 *   - adds P169_SCREENS to ONE native stack (the Search tab's), alongside the shell's own screens,
 *   - wraps the identity-keyed subtree in {@link P169FeatureProvider} so the screens find the feature,
 *   - maps host.onAddToCollection to a screen that says nothing was saved (an intent only).
 *
 * The host stack's param list must include {@link P169StackParams} (an intersection is fine).
 *
 * RETURN STATES: the feature never navigates outside its own routes. The only thing it hands back
 * is an {@link AddToCollectionIntent} (card id + CONFIRMED variant id, `requiresConfirmation: true`)
 * through `host.onAddToCollection`; performing an acquisition is the host's job, after the person
 * confirms it there. Back navigation is plain stack pop.
 */

export type P169StackParams = {
  /** Catalog search. */
  P169Search: undefined
  /** Card + printing confirmation + Price Check. `variantId` is honoured only if it belongs to the card. */
  P169Card: { cardId: string; variantId?: string }
  /** Photo entry: explains that native recognition is not available and routes to manual search. */
  P169PhotoEntry: undefined
}

export type P169RouteName = keyof P169StackParams

export interface P169Host {
  /** Navigation intent only. Must not write; the collection flow asks for confirmation. */
  onAddToCollection(intent: AddToCollectionIntent): void
}

interface P169Context {
  readonly feature: P169Feature
  readonly host: P169Host
}

const Context = createContext<P169Context | null>(null)

export function P169FeatureProvider({
  feature,
  host,
  children,
}: {
  feature: P169Feature
  host: P169Host
  children: ReactNode
}) {
  return <Context.Provider value={{ feature, host }}>{children}</Context.Provider>
}

export function useP169(): P169Context {
  const value = useContext(Context)
  if (value === null) throw new Error('P169 screens must be rendered inside P169FeatureProvider')
  return value
}

export interface P169ScreenRegistration {
  readonly name: P169RouteName
  readonly title: string
  // Screens are typed against P169StackParams; the host's navigator accepts them structurally.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly component: ComponentType<any>
}
