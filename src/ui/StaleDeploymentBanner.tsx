import { useSyncExternalStore } from 'react'
import {
  getStaleDeploymentSnapshot,
  retryStaleDeploymentAction,
  subscribeStaleDeployment,
} from '../platform/build-freshness-runtime'
import { hasAnyUnsavedWork } from '../platform/unsaved-work-registry'
import { Button } from './form'

/**
 * Mounted once in AppShell (P83 §6/§7, D-100) — the ONLY visible surface for a detected stale
 * deployment. When the recovery policy already reloaded automatically (no unsaved work, no recent
 * reload loop) this renders nothing: the page is navigating away. It renders a blocking notice
 * only for the case the prompt explicitly protects — a nonempty scanner batch, or a reload
 * already attempted too recently — so the owner is told to act instead of either losing work
 * silently or staring at a raw "text/html is not a valid JavaScript MIME type" crash.
 */
export function StaleDeploymentBanner() {
  const snapshot = useSyncExternalStore(subscribeStaleDeployment, getStaleDeploymentSnapshot)

  if (snapshot.action !== 'prompt') {
    return null
  }

  // F-40 (P89): registry-wide, not the scanner alone.
  const unsaved = hasAnyUnsavedWork()

  return (
    <div
      role="alert"
      className="fixed inset-x-0 top-0 z-[60] flex flex-col gap-2 border-b border-amber-500/40 bg-amber-950/95 px-4 py-3 text-sm text-amber-100 shadow-lg"
      style={{ paddingTop: 'max(0.75rem, env(safe-area-inset-top))' }}
    >
      <p className="font-medium">
        {unsaved
          ? 'App update required. Save or cancel what you were doing before reloading.'
          : 'A new version of PokePortfolio is available.'}
      </p>
      <div className="max-w-xs">
        <Button type="button" onClick={retryStaleDeploymentAction} className="min-h-9 py-1.5">
          Reload now
        </Button>
      </div>
    </div>
  )
}
