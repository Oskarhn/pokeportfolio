import { useEffect, useMemo } from 'react'
import { AppState, ScrollView, Text } from 'react-native'
import { StatusBar } from 'expo-status-bar'
import { createRuntime } from './src/wiring/runtime'
import { attachForegroundRefresh } from './src/auth/auth-controller'
import { createSharedCollectionPort } from './src/collection/shared-data-adapter'
import { createExpoPhotoPort } from './src/photo/expo-photo-port'
import { createFixturePriceCheckPort } from './src/price-check/fixture-adapter'
import { createReleasedPriceCheckPort } from './src/price-check/released-adapter'
import { backendConfig, clearStoredSession, supabase } from './src/seam/supabase-client'
import { AppRoot } from './src/ui/AppRoot'

/**
 * Entry component. Real wiring only: the native Supabase client (through the seam), SecureStore-backed
 * chunked session storage, the released shared data layer behind ports, and the expo-image-picker
 * adapter. A refused backend configuration (Production URL, secret key, missing values) renders the
 * refusal instead of the app.
 */
export default function App() {
  if (!backendConfig.ok) {
    return (
      <ScrollView contentContainerStyle={{ padding: 24, paddingTop: 64 }} testID="config-error">
        <Text accessibilityRole="header" style={{ fontSize: 20, fontWeight: '700' }}>
          Backend configuration refused
        </Text>
        <Text style={{ marginTop: 12 }}>{backendConfig.error.message}</Text>
        <Text style={{ marginTop: 12 }}>Code: {backendConfig.error.code}</Text>
      </ScrollView>
    )
  }
  return <ConfiguredApp host={backendConfig.config.host} />
}

function ConfiguredApp({ host }: { host: string }) {
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
  useEffect(() => attachForegroundRefresh(supabase.auth, AppState, AppState.currentState), [])
  return (
    <>
      <AppRoot runtime={runtime} backendHost={host} />
      <StatusBar style="auto" />
    </>
  )
}
