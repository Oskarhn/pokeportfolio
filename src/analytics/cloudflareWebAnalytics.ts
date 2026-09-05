/**
 * Cloudflare Web Analytics (P101, D-118; route-gated since P110, D-119) — opt-in, off by default.
 * No-ops entirely when `VITE_CF_ANALYTICS_TOKEN` is unset (the default in every environment until
 * the owner configures it — see .env.example). `vite.config.ts`'s `buildContentSecurityPolicy`
 * only grants the `static.cloudflareinsights.com`/`cloudflareinsights.com` CSP allowances when
 * this same token is present at build time, so an unset token means both "the script never loads"
 * and "the policy never widens for it" — the two cannot drift apart.
 *
 * Snippet shape confirmed against Cloudflare's current official docs (developers.cloudflare.com/
 * web-analytics, 2026-09): `<script defer src="https://static.cloudflareinsights.com/beacon.min.js"
 * data-cf-beacon='{"token":"…"}'>`.
 *
 * ROUTE GATING (P110, D-119 — see analyticsRoutePolicy.ts for the full reasoning). P107 found the
 * default snippet shape (no `"spa": false"`) auto-tracks EVERY SPA route change via the History
 * API and reports `location.href` for each one — meaning the moment the token is set, every
 * authenticated page load (holding/sale/opening/card UUIDs included) would be sent to Cloudflare.
 * Fixed with `"spa": false`, which disables that automatic history hook entirely: this script now
 * only ever reports the ONE pageview it fires on its own initial injection, never a later
 * navigation. `initCloudflareWebAnalytics` is called with the location it should evaluate (never
 * reads `window.location` itself, so it stays trivially testable) and injects the script exactly
 * once, only when that location is analytics-eligible (`isAnalyticsEligibleLocation`) — a private
 * route is therefore NEVER tracked, not even the first one visited in a session.
 *
 * DISCLOSED TRADEOFF: because the automatic history hook is off and this module deliberately never
 * re-injects the script for a later navigation, at most ONE pageview is ever reported per browser
 * session, even across several eligible page visits (e.g. /faq then /privacy). This undercounts
 * genuine multi-page public browsing. The alternative — re-injecting a fresh `<script>` element on
 * every eligible navigation to fire another pageview — was considered and rejected: Cloudflare's
 * own documentation does not describe this as a supported manual-tracking mechanism (unlike some
 * other privacy-focused analytics products that expose an explicit `track()` function), so relying
 * on it would be exactly the kind of unverified assumption this project's honesty bar avoids. A
 * single, guaranteed-private-route-free pageview per session is the safe, defensible default;
 * revisit only if Cloudflare documents a supported manual-pageview API.
 *
 * Per Cloudflare's own documentation, this does not use cookies or any client-side storage and
 * does not fingerprint visitors — see /privacy for the user-facing statement of the same fact.
 */
import { isAnalyticsEligibleLocation } from './analyticsRoutePolicy'

export interface AnalyticsLocation {
  readonly pathname: string
  readonly search: string
}

let injected = false

/** Test-only: resets the "already injected this session" latch. Never called from app code. */
export function resetCloudflareWebAnalyticsStateForTests(): void {
  injected = false
}

export function initCloudflareWebAnalytics(location: AnalyticsLocation): void {
  const token = import.meta.env.VITE_CF_ANALYTICS_TOKEN as string | undefined
  if (!token) return
  if (injected) return
  if (!isAnalyticsEligibleLocation(location.pathname, location.search)) return

  const script = document.createElement('script')
  script.defer = true
  script.src = 'https://static.cloudflareinsights.com/beacon.min.js'
  script.setAttribute('data-cf-beacon', JSON.stringify({ token, spa: false }))
  document.head.appendChild(script)
  injected = true
}
