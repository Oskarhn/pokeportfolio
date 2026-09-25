import { createContext, useContext, type ComponentType, type ReactNode } from 'react'
import type { P169Feature } from './feature'
import type { AddToCollectionIntent } from './price-check/price-check-flow-store'

/**
 * ROUTE / REGISTRATION CONTRACT for integrating P169 into the app's real navigator (owned by P167).
 * Nothing here creates a navigator or changes the shell: the host adds these screens to ONE of its
 * native stacks and wraps that subtree in {@link P169FeatureProvider}.
 *
 *   const feature = createP169Feature({ authority, registry, invoke, readFx, photo })  // once, next to createRuntime
 *   <P169FeatureProvider feature={feature} host={{ onAddToCollection }}>
 *     <Stack.Navigator>
 *       {P169_SCREENS.map((s) => <Stack.Screen key={s.name} name={s.name} component={s.component} options={{ title: s.title }} />)}
 *     </Stack.Navigator>
 *   </P169FeatureProvider>
 *
 * The host stack's param list must include {@link P169StackParams} (an intersection is fine). The
 * provider must sit INSIDE the identity-keyed subtree the shell already remounts on A -> B, and the
 * feature's stores must be created with the runtime's own authority and registry (createP169Feature
 * does the registration), so an identity change resets them synchronously.
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
