/**
 * Cloudflare Web Analytics (P101, D-111) — opt-in, off by default. No-ops entirely when
 * `VITE_CF_ANALYTICS_TOKEN` is unset (the default in every environment until the owner
 * configures it — see .env.example). `vite.config.ts`'s `buildContentSecurityPolicy` only grants
 * the `static.cloudflareinsights.com`/`cloudflareinsights.com` CSP allowances when this same
 * token is present at build time, so an unset token means both "the script never loads" and "the
 * policy never widens for it" — the two cannot drift apart.
 *
 * Snippet shape confirmed against Cloudflare's current official docs (developers.cloudflare.com/
 * web-analytics, 2026-09): `<script defer src="https://static.cloudflareinsights.com/beacon.min.js"
 * data-cf-beacon='{"token":"…"}'>`. The default (no `"spa": false"`) auto-tracks route changes via
 * the History API/Navigation API — exactly right for a client-side-routed SPA like this one, so no
 * manual per-navigation tracking call is added anywhere.
 *
 * Per Cloudflare's own documentation, this does not use cookies or any client-side storage and
 * does not fingerprint visitors — see /privacy for the user-facing statement of the same fact.
 */
export function initCloudflareWebAnalytics(): void {
  const token = import.meta.env.VITE_CF_ANALYTICS_TOKEN as string | undefined
  if (!token) return

  const script = document.createElement('script')
  script.defer = true
  script.src = 'https://static.cloudflareinsights.com/beacon.min.js'
  script.setAttribute('data-cf-beacon', JSON.stringify({ token }))
  document.head.appendChild(script)
}
