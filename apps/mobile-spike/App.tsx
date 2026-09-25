import { useEffect } from 'react'
import { AppState, ScrollView, Text } from 'react-native'
import { StatusBar } from 'expo-status-bar'
import { createRuntime, type Runtime } from './src/wiring/runtime'
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

/**
 * One runtime per JS runtime, not per mount. When Android recreates the Activity (font size, display
 * size, language) React Native mounts a NEW root in the SAME JS runtime: a runtime created in a hook
 * was then created again, with empty stores, a second auth subscription and no memory of the screen
 * the person was on, while the old one lived on unseen (P167).
 */
let appRuntime: Runtime | null = null
function getAppRuntime(): Runtime {
  appRuntime ??= createRuntime({
    auth: supabase.auth,
    removeStoredSession: clearStoredSession,
    collection: createSharedCollectionPort(),
    priceCheck: {
      released: createReleasedPriceCheckPort(),
      fixture: createFixturePriceCheckPort(),
    },
    photo: createExpoPhotoPort(),
  })
  return appRuntime
}

function ConfiguredApp({ host }: { host: string }) {
  const runtime = getAppRuntime()
  useEffect(() => attachForegroundRefresh(supabase.auth, AppState, AppState.currentState), [])
  // A picker copy shown when the previous process died was never released: remove it before anyone
  // signs in (P167).
  useEffect(() => void runtime.photo.purgeOrphans(), [runtime])
  return (
    <>
      <AppRoot runtime={runtime} backendHost={host} />
      <StatusBar style="auto" />
    </>
  )
}
