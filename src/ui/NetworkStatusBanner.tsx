import { useSyncExternalStore } from 'react'

function subscribe(onChange: () => void): () => void {
  window.addEventListener('online', onChange)
  window.addEventListener('offline', onChange)
  return () => {
    window.removeEventListener('online', onChange)
    window.removeEventListener('offline', onChange)
  }
}

const getSnapshot = () => navigator.onLine
// Server snapshot (never used in this client-only SPA) assumes online so nothing flashes.
const getServerSnapshot = () => true

/**
 * Tells the user the device is offline (P202).
 *
 * The service worker precaches the app shell, so an installed PWA still opens with no network —
 * and then every query fails, which used to surface as a scatter of unrelated "could not be loaded"
 * messages with no shared explanation. Private data is never cached (vite.config.ts workbox
 * comment), so offline means read-only-nothing, and saying so once, up front, is the honest state.
 */
export function NetworkStatusBanner() {
  const online = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
  if (online) return null
  return (
    <div
      role="status"
      className="border-b border-slate-700 bg-slate-800 px-4 py-2 text-center text-sm text-slate-200"
    >
      You're offline. Your data can't load or save until the connection is back.
    </div>
  )
}
