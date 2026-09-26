import { Fragment, useEffect, useMemo } from 'react'
import { View } from 'react-native'
import {
  NavigationContainer,
  createNavigationContainerRef,
  type InitialState,
  type NavigationContainerRefWithCurrent,
} from '@react-navigation/native'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { P169FeatureProvider, type P169Host } from '../features/navigation'
import { identityKey, type Runtime } from '../wiring/runtime'
import { Body, Button, FailureView, Loading } from './components'
import { MainNavigator } from './MainNavigator'
import { RuntimeProvider, useStore } from './runtime-context'
import { LoginScreen } from './screens/LoginScreen'
import type { TabParams } from './navigation-types'
import { SPACE, useNavigationTheme, usePalette } from './theme'

/**
 * The app shell. The authenticated subtree is mounted under a key derived from (user id, identity
 * epoch): a real identity change (A -> B, A -> signed out -> A) remounts it, so NO component state and
 * NO navigation state of the previous identity can exist under the next. A same-user token refresh
 * leaves the key (and therefore the screens, including unsaved drafts) untouched. The stores are reset
 * by the same event (createRuntime), synchronously, before this re-renders.
 *
 * The navigation state is restored from `runtime.navigation` when React Native mounts a new root after
 * an Android Activity recreation (P167); that memory is user-scoped and reset by the same boundary.
 */
type NavRef = NavigationContainerRefWithCurrent<TabParams>

function Gate({
  runtime,
  backendHost,
  navigationRef,
}: {
  runtime: Runtime
  backendHost: string
  navigationRef?: NavRef | undefined
}) {
  const session = useStore(runtime.auth)
  const p = usePalette()
  const navTheme = useNavigationTheme()

  useEffect(() => runtime.auth.start(), [runtime])

  // "Add to collection" from Price Check is an intent: navigate to the screen that says what happens
  // next. It carries only ids; it never writes (the feature has no way to).
  const ownRef = useMemo(() => createNavigationContainerRef<TabParams>(), [])
  const containerRef = navigationRef ?? ownRef
  const host = useMemo<P169Host>(
    () => ({
      onAddToCollection: (intent) => {
        if (!containerRef.isReady()) return
        containerRef.navigate('SearchTab', {
          screen: 'P170AddIntent',
          params: { cardId: intent.cardId, variantId: intent.variantId },
        })
      },
    }),
    [containerRef],
  )

  if (session.status === 'initializing') {
    return (
      <View
        style={{ flex: 1, backgroundColor: p.background, justifyContent: 'center' }}
        testID="restoring"
      >
        <Loading label="Restoring your session" />
      </View>
    )
  }
  if (session.status === 'session_check_failed') {
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: p.background,
          padding: SPACE.xl,
          gap: SPACE.md,
          justifyContent: 'center',
        }}
        testID="session-check-failed"
      >
        <Body>We could not check whether you are still signed in.</Body>
        {session.notice !== null ? <FailureView failure={session.notice} /> : null}
        <Button
          testID="retry-session"
          label="Try again"
          onPress={() => void runtime.auth.retrySessionCheck()}
        />
      </View>
    )
  }
  if (session.status === 'signed_out') {
    return <LoginScreen notice={session.notice?.message ?? null} />
  }
  return (
    <Fragment key={identityKey(session.userId, session.epoch)}>
      <P169FeatureProvider feature={runtime.feature} host={host}>
        <NavigationContainer
          ref={containerRef}
          theme={navTheme}
          initialState={runtime.navigation.get() as InitialState | undefined}
          onStateChange={(state) => runtime.navigation.set(state)}
        >
          <MainNavigator backendHost={backendHost} />
        </NavigationContainer>
      </P169FeatureProvider>
    </Fragment>
  )
}

export function AppRoot({
  runtime,
  backendHost,
  navigationRef,
}: {
  runtime: Runtime
  backendHost: string
  navigationRef?: NavRef | undefined
}) {
  return (
    <SafeAreaProvider>
      <RuntimeProvider runtime={runtime}>
        <Gate runtime={runtime} backendHost={backendHost} navigationRef={navigationRef} />
      </RuntimeProvider>
    </SafeAreaProvider>
  )
}
