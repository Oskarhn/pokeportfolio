import 'react-native-url-polyfill/auto'
import { Platform } from 'react-native'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@shared/data/database.types'
import { createChunkedSessionStorage } from '../auth/chunked-session-storage'
import { createNativeClient, removeStoredSession } from '../auth/create-client'
import { secureStoreAdapter } from '../auth/secure-store-adapter'
import { BackendConfigError, loadBackendConfig, type BackendConfig } from '../config/backend-config'

/**
 * THE SEAM. Metro redirects the web data modules' `import { supabase } from './supabase-client'`
 * (only inside ../../src/data) to this file, so `src/data/portfolio.ts`, `collection.ts`,
 * `catalog.ts` and `pricing.ts` run in the native app unchanged, on the native client.
 *
 * `process.env.EXPO_PUBLIC_*` must be read as literal property accesses: Expo inlines exactly those
 * into the bundle at build time. They are PUBLIC by construction (the bundle is readable), which is
 * why only a publishable key is accepted (config/backend-config.ts).
 *
 * If the configuration is refused (Production URL, secret key, missing values) the app still starts,
 * shows the refusal, and every attempt to use the client throws that same error.
 */

const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)

type ConfigResult = { ok: true; config: BackendConfig } | { ok: false; error: BackendConfigError }

function load(): ConfigResult {
  try {
    const config = loadBackendConfig(
      {
        profile: str(process.env.EXPO_PUBLIC_BUILD_PROFILE),
        url: str(process.env.EXPO_PUBLIC_SUPABASE_URL),
        publishableKey: str(process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY),
        androidEmulatorHost: str(process.env.EXPO_PUBLIC_ANDROID_EMULATOR_HOST),
        androidLoopback: str(process.env.EXPO_PUBLIC_ANDROID_LOOPBACK),
      },
      Platform.OS === 'ios' || Platform.OS === 'android' ? Platform.OS : 'web',
    )
    return { ok: true, config }
  } catch (error) {
    if (error instanceof BackendConfigError) return { ok: false, error }
    throw error
  }
}

export const backendConfig: ConfigResult = load()

export const sessionStorage = createChunkedSessionStorage(secureStoreAdapter)

function refused(error: BackendConfigError): never {
  throw error
}

export const supabase: SupabaseClient<Database> = backendConfig.ok
  ? createNativeClient(backendConfig.config, { storage: sessionStorage })
  : (new Proxy({}, { get: () => refused(backendConfig.error) }) as SupabaseClient<Database>)

export function clearStoredSession(): Promise<void> {
  return removeStoredSession(sessionStorage)
}
