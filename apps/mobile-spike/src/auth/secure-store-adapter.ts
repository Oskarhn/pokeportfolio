import * as SecureStore from 'expo-secure-store'
import type { KeyValueStore } from './chunked-session-storage'

/**
 * expo-secure-store as a {@link KeyValueStore}: iOS Keychain / Android Keystore-backed.
 * `WHEN_UNLOCKED_THIS_DEVICE_ONLY`: readable only while the device is unlocked and never migrated to
 * another device through a backup. The app refreshes tokens in the foreground only, so it never needs
 * the session while the device is locked. PROVISIONAL choice; a security review owns the final one.
 */
const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
}

export const secureStoreAdapter: KeyValueStore = {
  getItemAsync: (key) => SecureStore.getItemAsync(key, OPTIONS),
  setItemAsync: (key, value) => SecureStore.setItemAsync(key, value, OPTIONS),
  deleteItemAsync: (key) => SecureStore.deleteItemAsync(key, OPTIONS),
}
