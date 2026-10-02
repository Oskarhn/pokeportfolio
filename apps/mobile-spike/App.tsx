import { useEffect } from 'react'
import { AppState, ScrollView, Text } from 'react-native'
import { createRuntime, type Runtime } from './src/wiring/runtime'
import { attachForegroundRefresh } from './src/auth/auth-controller'
import { secureStoreAdapter } from './src/auth/secure-store-adapter'
import { createSharedCollectionPort } from './src/collection/shared-data-adapter'
import { logP169Event, logRuntimeCreated } from './src/diagnostics/feature-events'
import { fxRateReaderFor } from './src/features/price-check/fx-source'
import { createExpoPhotoPort } from './src/photo/expo-photo-port'
import { createFixturePriceCheckPort } from './src/price-check/fixture-adapter'
import { createReleasedPriceCheckPort } from './src/price-check/released-adapter'
import {
  createNativeCardRecognitionPort,
  defaultRecognitionDeps,
} from './src/features/scanner-native/recognition-pipeline'
import { P184_PROOF_ENABLED, withProofDelay } from './src/diagnostics/p184-proof'
import { backendConfig, clearStoredSession, supabase } from './src/seam/supabase-client'
import { AppRoot } from './src/ui/AppRoot'
import { AppThemeProvider, ThemedStatusBar } from './src/ui/theme'
import { createAccountDeletionPorts } from './src/account/account-request-client'
import { PendingWriteJournal } from './src/write/pending-write-journal'
import { purchaseExistsCheckerFor, saleExistsCheckerFor } from './src/write/pending-write-exists'
import { createWriteDbBinder } from './src/write/write-db'

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
  if (appRuntime !== null) return appRuntime
  if (!backendConfig.ok) throw backendConfig.error // only called from ConfiguredApp, see App()
  logRuntimeCreated()
  // One reader instance, shared: Price Check and the purchase/sale write screens read the SAME
  // `fx_rates` table through the SAME ambient client (P180) — never two independent FX sources.
  const readFx = fxRateReaderFor(supabase)
  appRuntime = createRuntime({
    auth: supabase.auth,
    removeStoredSession: clearStoredSession,
    collection: createSharedCollectionPort(),
    priceCheck: {
      released: createReleasedPriceCheckPort(),
      fixture: createFixturePriceCheckPort(),
    },
    // The feature's function calls and fx reads go through the SAME client as everything else.
    priceFeature: {
      invoke: (name, options) => supabase.functions.invoke(name, options),
      readFx,
      onEvent: logP169Event,
      recognition: createNativeCardRecognitionPort(
        P184_PROOF_ENABLED ? withProofDelay(defaultRecognitionDeps) : defaultRecognitionDeps,
      ),
    },
    readFx,
    photo: createExpoPhotoPort(),
    // P175: the finance write seam's own per-lease client, bound to THIS app's session — never the
    // ambient `supabase` singleton itself (see write/leased-write-client.ts for why).
    writeDb: createWriteDbBinder({
      url: backendConfig.config.url,
      publishableKey: backendConfig.config.publishableKey,
      getSession: () => supabase.auth.getSession(),
    }),
    // P180: SecureStore-backed (same device-secure medium as the session itself), holding only
    // idempotency keys and non-secret summaries — never card/price data. Reconciliation reads go
    // through the SAME ambient `supabase` client as every other read in this app.
    // P189: the same delete-account contract as the web app, through the app's ONE client.
    // P189: its OWN wire seam (one request allowed: POST delete-account), never the read-only client.
    accountDeletion: createAccountDeletionPorts({
      url: backendConfig.config.url,
      publishableKey: backendConfig.config.publishableKey,
      getSession: () => supabase.auth.getSession(),
      accountIsGone: async () => {
        try {
          const { data } = await supabase.auth.getSession()
          if (data.session === null) return false
          const { error } = await supabase.auth.getUser(data.session.access_token)
          return (error as { code?: string } | null)?.code === 'user_not_found'
        } catch {
          return false
        }
      },
    }),
    pendingWrites: {
      journal: new PendingWriteJournal(secureStoreAdapter),
      existsCheckers: {
        create_purchase: purchaseExistsCheckerFor(supabase),
        create_sale: saleExistsCheckerFor(supabase),
      },
    },
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
    <AppThemeProvider>
      <AppRoot runtime={runtime} backendHost={host} />
      <ThemedStatusBar />
    </AppThemeProvider>
  )
}
