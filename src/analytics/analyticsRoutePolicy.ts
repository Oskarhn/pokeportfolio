/**
 * Explicit allowlist gating Cloudflare Web Analytics initialization/tracking to genuinely public,
 * non-identifying routes (P110, prompt §13-16 — P107's ANALYTICS_PRIVACY_VERDICT: "a real,
 * confirmed automatic page-view leak, not a hypothetical," the day `VITE_CF_ANALYTICS_TOKEN` is
 * ever set).
 *
 * Every authenticated route in this app embeds an entity id directly in its path — router.tsx's
 * "Three route classes" comment lists `/portfolio/$holdingId`, `/catalog/$cardId`, and more —
 * and Cloudflare's beacon script reports `location.href` (the full URL) for every pageview it
 * tracks. Enabling analytics without a route gate would leak those ids (and any card/holding a
 * user is looking at) to Cloudflare the moment the token is configured.
 *
 * Deliberately mirrors `public/robots.txt`'s `Allow:` list, `public/sitemap.xml`'s URLs, and
 * `scripts/check-links.mjs`'s own `PUBLIC_ROUTES` constant — the exact three pages this app has
 * already decided are safe to expose to a third party for a DIFFERENT reason (crawling, D-116).
 * The same three pages are safe for analytics for the same underlying reason: no entity id, no
 * secret token, no financial data, ever appears in their path. `/login`, `/forgot-password`,
 * `/invite/$token` and `/reset-password` are public but deliberately NOT included here, matching
 * D-116's own reasoning for excluding them from robots/sitemap — `/invite/$token` and
 * `/reset-password` carry a live single-use secret token in the URL, which must never leave the
 * origin under any circumstance, analytics included.
 *
 * Not imported by `scripts/check-links.mjs` directly (that script is plain `.mjs`, loaded by Node
 * without a build step; pulling in a TypeScript module there is disproportionate for one constant
 * array) — kept in sync by `tests/data/analytics-route-policy.test.ts`'s explicit cross-check
 * against that script's own `PUBLIC_ROUTES`.
 */

export const ANALYTICS_ELIGIBLE_PATHS: readonly string[] = ['/privacy', '/terms', '/faq']

/**
 * A location is analytics-eligible only when its pathname is an EXACT match against the allowlist
 * AND it carries no query string. Fails closed on anything else, including:
 *   - any route not explicitly listed (a new authenticated route added later is excluded by
 *     default, not by omission — the same deny-by-default posture D-116 already established);
 *   - an otherwise-eligible path carrying a query string. This app's public pages never
 *     legitimately carry one (LAUNCH_CHECKLIST.md item 14: a canonical tag is only ever set on a
 *     route with no query string) — a query string here is itself a signal that something
 *     unexpected is being asked of a page that should have none, and Cloudflare's beacon has no
 *     supported way to report a sanitized URL, so the only way to guarantee "query parameters are
 *     never transmitted" is to refuse to track a location that has one at all.
 */
export function isAnalyticsEligibleLocation(pathname: string, search: string): boolean {
  if (search !== '') return false
  return ANALYTICS_ELIGIBLE_PATHS.includes(pathname)
}
