import { Fragment, useEffect, useMemo } from 'react'
import { AppState, ScrollView, Text, View, useColorScheme } from 'react-native'
import {
  DarkTheme,
  DefaultTheme,
  NavigationContainer,
  createNavigationContainerRef,
} from '@react-navigation/native'
import {
  createNativeStackNavigator,
  type NativeStackScreenProps,
} from '@react-navigation/native-stack'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { StatusBar } from 'expo-status-bar'
import { attachForegroundRefresh } from '../../auth/auth-controller'
import { createSharedCollectionPort } from '../../collection/shared-data-adapter'
import { createExpoPhotoPort } from '../../photo/expo-photo-port'
import { createFixturePriceCheckPort } from '../../price-check/fixture-adapter'
import { createReleasedPriceCheckPort } from '../../price-check/released-adapter'
import { backendConfig, clearStoredSession, supabase } from '../../seam/supabase-client'
import { Body, Heading, Loading } from '../../ui/components'
import { RuntimeProvider, useStore } from '../../ui/runtime-context'
import { LoginScreen } from '../../ui/screens/LoginScreen'
import { SPACE, usePalette } from '../../ui/theme'
import { createRuntime, identityKey, type Runtime } from '../../wiring/runtime'
import { createP169Feature, type P169Feature } from '../feature'
import { P169FeatureProvider, type P169Host, type P169StackParams } from '../navigation'
import { fxRateReaderFor } from '../price-check/fx-source'
import type { AddToCollectionIntent } from '../price-check/price-check-flow-store'
import type { SearchPricesInvoker } from '../price-check/search-prices-source'
import { P169_SCREENS } from '../screens'
import { ActionButton, Label, Section } from '../ui/kit'
import { logP169Event } from './instrumentation'

/**
 * P169 DEVELOPMENT HARNESS (a separate app entry, ./index.ts). It mounts the P169 screens on the
 * SAME runtime, auth controller, identity authority, scoped registry, Supabase client and Login
 * screen as the P166 app, without touching the P167-owned shell (MainNavigator, AppRoot, tabs,
 * theme). Built as its own Android application id by scripts/p169/build-harness.mjs so it can sit
 * next to the P166/P167 app on one emulator. Two harness-only screens exist: an account screen
 * (identity + sign out, for A -> B runs) and a screen that shows the Add-to-Collection INTENT the
 * feature handed back, proving it is navigation only.
 */

type HarnessParams = P169StackParams & {
  HarnessAccount: undefined
  HarnessIntent: { intent: AddToCollectionIntent }
}

const Stack = createNativeStackNavigator<HarnessParams>()
/** The host callback has no navigation object of its own; it navigates through the root ref. */
const navigationRef = createNavigationContainerRef<HarnessParams>()

const invoke: SearchPricesInvoker = (name, options) => supabase.functions.invoke(name, options)

function AccountScreen({ runtime }: { runtime: Runtime }) {
  const session = useStore(runtime.auth)
  return (
    <ScrollView contentContainerStyle={{ padding: SPACE.lg, gap: SPACE.md }} testID="p169-account">
      <Heading>Account</Heading>
      <Label testID="p169-account-email">{session.email ?? '—'}</Label>
      <ActionButton
        testID="p169-sign-out"
        label="Sign out"
        onPress={() => void runtime.auth.signOut()}
      />
    </ScrollView>
  )
}

function IntentScreen({ route }: NativeStackScreenProps<HarnessParams, 'HarnessIntent'>) {
  const { intent } = route.params
  return (
    <ScrollView contentContainerStyle={{ padding: SPACE.lg, gap: SPACE.md }} testID="p169-intent">
      <Heading>Add to collection</Heading>
      <Section>
        <Label testID="p169-intent-text">
          Intent received for card {intent.cardId.slice(0, 8)}…, printing{' '}
          {intent.variantId.slice(0, 8)}…. Nothing was saved. The collection flow (not part of this
          build) would ask you to confirm.
        </Label>
      </Section>
    </ScrollView>
  )
}

function Authenticated({ runtime }: { runtime: Runtime }) {
  const scheme = useColorScheme()
  return (
    <NavigationContainer ref={navigationRef} theme={scheme === 'dark' ? DarkTheme : DefaultTheme}>
      <Stack.Navigator>
        {P169_SCREENS.map((s) => (
          <Stack.Screen
            key={s.name}
            name={s.name}
            component={s.component}
            options={({ navigation }) => ({
              title: s.title,
              headerRight:
                s.name === 'P169Search'
                  ? () => (
                      <Text
                        testID="p169-open-account"
                        accessibilityRole="button"
                        onPress={() => navigation.navigate('HarnessAccount')}
                        style={{
                          padding: 12,
                          fontSize: 16,
                          color: scheme === 'dark' ? '#7da2ff' : '#1f4fd8',
                        }}
                      >
                        Account
                      </Text>
                    )
                  : undefined,
            })}
          />
        ))}
        <Stack.Screen name="HarnessAccount" options={{ title: 'Account' }}>
          {() => <AccountScreen runtime={runtime} />}
        </Stack.Screen>
        <Stack.Screen
          name="HarnessIntent"
          component={IntentScreen}
          options={{ title: 'Add to collection' }}
        />
      </Stack.Navigator>
    </NavigationContainer>
  )
}

function Gate({
  runtime,
  feature,
  host,
}: {
  runtime: Runtime
  feature: P169Feature
  host: P169Host
}) {
  const session = useStore(runtime.auth)
  const p = usePalette()
  useEffect(() => runtime.auth.start(), [runtime])
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
        <ActionButton
          testID="retry-session"
          label="Try again"
          onPress={() => void runtime.auth.retrySessionCheck()}
        />
      </View>
    )
  }
  if (session.status === 'signed_out')
    return <LoginScreen notice={session.notice?.message ?? null} />
  // Same rule as the P166 shell: a new identity (or epoch) remounts the whole subtree.
  return (
    <Fragment key={identityKey(session.userId, session.epoch)}>
      <P169FeatureProvider feature={feature} host={host}>
        <Authenticated runtime={runtime} />
      </P169FeatureProvider>
    </Fragment>
  )
}

function ConfiguredHarness() {
  const runtime = useMemo(
    () =>
      createRuntime({
        auth: supabase.auth,
        removeStoredSession: clearStoredSession,
        collection: createSharedCollectionPort(),
        priceCheck: {
          released: createReleasedPriceCheckPort(),
          fixture: createFixturePriceCheckPort(),
        },
        photo: createExpoPhotoPort(),
      }),
    [],
  )
  const feature = useMemo(
    () =>
      createP169Feature({
        authority: runtime.authority,
        registry: runtime.registry,
        invoke,
        readFx: fxRateReaderFor(supabase),
        photo: runtime.photo,
        onEvent: logP169Event,
      }),
    [runtime],
  )
  const host = useMemo<P169Host>(
    () => ({
      onAddToCollection: (intent) => {
        logP169Event({ type: 'add_to_collection_intent' })
        if (navigationRef.isReady()) navigationRef.navigate('HarnessIntent', { intent })
      },
    }),
    [],
  )
  useEffect(() => attachForegroundRefresh(supabase.auth, AppState, AppState.currentState), [])
  return (
    <SafeAreaProvider>
      <RuntimeProvider runtime={runtime}>
        <Gate runtime={runtime} feature={feature} host={host} />
      </RuntimeProvider>
      <StatusBar style="auto" />
    </SafeAreaProvider>
  )
}

export function P169HarnessApp() {
  if (!backendConfig.ok) {
    return (
      <ScrollView contentContainerStyle={{ padding: 24, paddingTop: 64 }} testID="config-error">
        <Text accessibilityRole="header" style={{ fontSize: 20, fontWeight: '700' }}>
          Backend configuration refused
        </Text>
        <Text style={{ marginTop: 12 }}>{backendConfig.error.message}</Text>
      </ScrollView>
    )
  }
  return <ConfiguredHarness />
}
