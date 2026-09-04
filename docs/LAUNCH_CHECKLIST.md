# Launch checklist

Owner-required pre-launch checklist (P101). Every item below is one of `IMPLEMENTED` /
`ALREADY_CORRECT_AND_VERIFIED` / `NOT_APPLICABLE_WITH_EVIDENCE` / `OWNER_CONFIGURATION_REQUIRED` —
never silently skipped. This is a release gate: no item may be marked done merely because a file
exists for it.

**Context that shapes several items below.** PokePortfolio is invite-only and explicitly not a
public platform (`docs/PRODUCT_SPEC.md` §1.1). Almost the entire app requires a session
(`docs/router.tsx`'s "Three route classes" comment). The genuinely public surface is exactly three
pages — `/privacy`, `/terms`, `/faq` — plus the sign-in/recovery screens, which are public but
deliberately not indexed (no discovery value for a closed tool). Everything requiring
authentication was verified by code review + automated tests against the placeholder-backend
Playwright preview server; nothing requiring a *real, signed-in* session was exercised, per the
standing no-sign-in boundary carried since M7.1 (restated throughout `HANDOVER.md`) — those items
carry an explicit owner manual-check action below, exactly like every other milestone.

---

## 1. Privacy policy — `IMPLEMENTED`

**Implementation.** `/privacy` (`src/features/legal/PrivacyPage.tsx`), written from a real
data-flow inventory of this codebase — not a template. Covers: account/auth data (Supabase,
EU/Paris), portfolio/purchase/sale/opening data and RLS scoping, the scanner (photos processed
on-device, never uploaded — traced to `docs/ARCHITECTURE.md`'s "Captured image bytes never cross
the network" claim, itself enforced by a static audit test), card artwork/market data sourcing,
local storage inventory (session + theme preference only — see item 15), Cloudflare Web Analytics
(item 9), export/backup/reset, and contact. No invented company, postal address, or DPO — the page
says plainly there isn't one, and gives a real contact address instead (owner's choice this
session: oskarhn06@outlook.com).

**Test.** `tests/e2e/a11y.spec.ts` (renders, axe-clean); `tests/e2e/launch-readiness.spec.ts`
(title/meta/canonical correctness, footer links).

**Owner action.** None required to ship. If this repository or product is ever made genuinely
public beyond the current ~10 invited people, re-review this page against
`docs/PUBLICATION_CHECKLIST.md` first.

---

## 2. Terms page — `IMPLEMENTED`

**Implementation.** `/terms` (`src/features/legal/TermsPage.tsx`). States plainly: every price is
an informational estimate, never investment advice (mirrors `PRODUCT_SPEC.md` §1.3's explicit
non-goal), the user is responsible for the accuracy of what they enter, the service is limited/
private/free/no-SLA, and the unofficial/unaffiliated disclaimer (consistent with
`PUBLICATION_CHECKLIST.md` §8, linked in spirit rather than duplicated). No fabricated legal entity.

**Test.** Same as item 1.

**Owner action.** None required to ship.

---

## 3. Clear CTA — `ALREADY_CORRECT_AND_VERIFIED`

**Finding.** `LoginPage.tsx`/`InvitePage.tsx` already got this right before this session — an
explicit code comment states there is deliberately no "Create account" link, since account
creation only happens by redeeming an invitation. `tests/e2e/auth.spec.ts`'s existing
`'there is no way to create an account from the sign-in screen'` test already pinned this.

**What this session added.** A subtle Privacy/Terms/FAQ footer link row on the sign-in screen
(`PublicFooter`, rendered from `LoginPage.tsx`), so the primary CTA ("Sign in") stays completely
unambiguous while the legal pages are still one tap away.

**Test.** `tests/e2e/auth.spec.ts` (pre-existing), `tests/e2e/launch-readiness.spec.ts`'s
`'legal page footer links'` describe block.

**Owner action.** None.

---

## 4. FAQ — `IMPLEMENTED`

**Implementation.** `/faq` (`src/features/legal/FaqPage.tsx`) — 10 entries covering only real,
shipped behavior: what the product is, how values are estimated, raw/graded/sealed support,
unknown cost basis, scanner limitations (does NOT auto-add — confirmed by reading, not editing,
`docs/ARCHITECTURE.md`'s scanner description: commits go through the existing
`add_card_acquisition` RPC, implying a review step), scanner privacy, a privacy pointer, an
export/backup pointer, invite-only access, and how to report a wrong card/price.

**Test.** `tests/e2e/a11y.spec.ts`.

**Owner action.** None.

---

## 5. robots.txt — `IMPLEMENTED`

**Implementation.** `public/robots.txt` — deny-by-default (`Disallow: /`), explicit `Allow:` for
exactly `/privacy`, `/terms`, `/faq`. Never allows `/invite/$token` or `/reset-password` (both
carry live secret tokens). Decision and full reasoning: `docs/DECISIONS.md` D-116.

**Test.** `scripts/check-links.mjs` asserts robots.txt disallows everything by default, never
allows a token-bearing route, and matches sitemap.xml + the script's own `PUBLIC_ROUTES` exactly —
29/29 passed against a real production build.

**Owner action.** None.

---

## 6. sitemap.xml — `IMPLEMENTED`

**Implementation.** `public/sitemap.xml` — exactly `/privacy`, `/terms`, `/faq`. Hand-written
(three URLs; no build-time generator needed), cross-checked against robots.txt by
`scripts/check-links.mjs` so a future private route can't silently end up listed.

**Test.** Same as item 5.

**Owner action.** None.

---

## 7. Custom 404 — `IMPLEMENTED`

**Finding.** There was no `notFoundComponent`/404 handling anywhere before this session (confirmed
by grep across `router.tsx`) — an unmatched path fell through to TanStack Router's bare default.

**Implementation.** `notFoundComponent: NotFoundPage` on `createRootRoute` (`router.tsx`).
`NotFoundPage` (`src/features/legal/NotFoundPage.tsx`) matches the design system, links back to
`/` (resolves correctly signed-in or signed-out), no stack/error leakage, keyboard-focusable
action button with a visible focus ring.

**Test.** `tests/e2e/a11y.spec.ts` (axe-clean), `tests/e2e/launch-readiness.spec.ts` (title/robots
correctness for the 404 case).

**Owner action.** None.

---

## 8. Alt text — `IMPLEMENTED` (lint gate) + `ALREADY_CORRECT_AND_VERIFIED` (existing hygiene)

**Finding.** A full sweep (not just a sample) found existing alt/aria hygiene already good:
descriptive `alt`/`aria-label` on every meaningful image/icon-only control, correct `alt=""` on
decorative images. `eslint-plugin-jsx-a11y`'s recommended ruleset, newly added, surfaced 10 REAL
pre-existing issues once enabled — see the breakdown below, since "added a lint rule" alone isn't
evidence of a fix.

**What was found and what happened to each:**
- 4× `label-has-associated-control` (Purchase/Sale add+edit forms' "Notes" field lacked a
  `htmlFor`/`id` pairing) — **fixed**, trivial two-line addition, no behavior change:
  `PurchaseFormPage.tsx`, `PurchaseEditPage.tsx`, `SaleFormPage.tsx`, `SaleEditPage.tsx`.
- 4× `no-autofocus` (Profile's inline display-name edit, the Openings pull picker, the Sale item
  picker, the scanner) — **rule disabled with reasoning recorded in `eslint.config.js`**: every
  real usage moves focus into a field that just appeared in response to a user action (the
  accessible pattern for a newly revealed inline edit/sheet), which this blanket rule cannot
  distinguish from page-load autofocus.
- 2× scanner-specific findings (`media-has-caption` on the live silent camera-preview `<video>` —
  a false positive, there is no dialogue track to caption; `img-redundant-alt` wording on a
  captured-photo preview) — **left untouched, rule scoped off for `src/features/scanner/**`
  specifically**, since scanner internals are P99/P100's active territory this session.

**Test.** `pnpm lint` — 0 errors (was 10 before the fixes/scoping above).

**Owner action.** None to ship. The two scanner findings remain for whichever session next touches
`ScannerPage.tsx` — see `eslint.config.js`'s comment at the scoped-off block.

---

## 9. Analytics — `IMPLEMENTED` (code) / `OWNER_CONFIGURATION_REQUIRED` (activation)

**Implementation.** Cloudflare Web Analytics — $0, no new account (same Cloudflare account already
used for Pages hosting), confirmed cookieless/no-fingerprinting against current official docs
(not assumed). `src/analytics/cloudflareWebAnalytics.ts`, loaded from `main.tsx`, no-ops entirely
unless `VITE_CF_ANALYTICS_TOKEN` is set at build time. `vite.config.ts`'s CSP only grants the
Cloudflare analytics hosts when that same token is present, so an unset token means both "script
never loads" and "policy never widens" — the two cannot drift apart. Full reasoning:
`docs/DECISIONS.md` D-118.

**Test.** `tests/config/security-headers.test.ts` (CSP pins unchanged with the new parameter
defaulted off); `pnpm build` with no token set, `dist/_headers` confirmed unchanged from the
pre-P101 CSP shape.

**Owner action required.** Cloudflare dashboard → Analytics & Logs → Web Analytics → Add a site
(the existing account) → copy the token → set `VITE_CF_ANALYTICS_TOKEN` as a Cloudflare Pages
build environment variable. Until then analytics ships code-complete but genuinely inactive.

---

## 10-11. Meta titles / meta descriptions — `IMPLEMENTED`, with a disclosed SPA limitation

**Implementation.** `src/ui/useDocumentMeta.ts` — a small `useEffect`-based hook (no new
dependency; DOM mutation from already-permitted bundle JS stays inside the existing strict CSP,
unlike a new inline `<script>` would). Sets `document.title` (`"<Page> · PokePortfolio"`) and
`<meta name="description">` on the public pages; every other route reverts to the safe static
default on unmount so a stale public-page value can never leak onto a private route.

**Disclosed limitation.** This is a client-rendered SPA with no server-side rendering or
prerendering. A JS-set per-route tag is real for the browser tab and for any crawler that executes
JavaScript (Googlebot does); it is invisible to a crawler that only fetches raw HTML (most chat-app
link unfurlers — see item 12). A true per-route static tag would need a prerender build step,
judged disproportionate for an invite-only tool with ~10 users and is not implemented.

**Test.** `tests/e2e/launch-readiness.spec.ts`'s `'per-route document metadata'` describe block —
title/robots/canonical set correctly while a public page is mounted, and reverting correctly on
navigation away (a real regression this test would have caught: without the revert-on-unmount
logic, visiting `/privacy` then `/portfolio` would have left the whole rest of the app indexable).

**Owner action.** None.

---

## 12. Social share metadata — `IMPLEMENTED`

**Implementation.** Static, app-level Open Graph/Twitter-card tags in `index.html` (`og:type`,
`og:site_name`, `og:title`, `og:description`, `og:image` → the existing `icons/icon-512.png`,
`twitter:card`). Static rather than per-route, deliberately: per item 10-11's limitation, a
JS-injected per-route tag is invisible to the non-JS-executing unfurlers most chat apps use, so a
single static generic card is the *more* correct choice here, not a shortcut — and it structurally
cannot leak portfolio values, holdings, or auth state the way a dynamic per-page one might by
accident (the prompt's own explicit warning). `og:image` uses the existing square 512×512 icon,
not the ideal 1200×630 — no new art commissioned, per the prompt's "don't require a paid image
service."

**Test.** `scripts/check-links.mjs` confirms `og:image` resolves to a real file in the build output.

**Owner action.** None.

---

## 13. Favicon / app icons — `ALREADY_CORRECT_AND_VERIFIED`

**Finding.** `index.html`'s `<link rel="icon">`/`apple-touch-icon` and `vite-plugin-pwa`'s manifest
icon set (`icon-192`, `icon-512`, `icon-512-maskable`) were already correctly wired before this
session, all four files exist under `public/icons/`. A literal `/favicon.ico` was never present;
judged not needed — modern browsers fully honor the existing PNG `<link rel="icon">`, and
manufacturing a low-quality hand-rolled `.ico` (no image-processing library installed) would be
worse than the status quo, not better.

**Test.** `scripts/check-links.mjs` confirms every icon `index.html`/the manifest references
resolves to a real file in the build output (manifest icon checks + the generic `href`/`src`
resolution sweep) — all passed.

**Owner action.** None.

---

## 14. Canonical URLs — `IMPLEMENTED`

**Implementation.** `useDocumentMeta`'s `canonicalPath` option, set only on `/privacy`, `/terms`,
`/faq` — never on a route carrying a query string, invite token, or auth callback. Removed
entirely on unmount (not left stale) when navigating to a route that doesn't set one.

**Test.** `tests/e2e/launch-readiness.spec.ts` asserts the canonical `href` on each public page and
asserts it is absent after navigating away.

**Owner action.** None.

---

## 15. Cookie/consent audit — `NOT_APPLICABLE_WITH_EVIDENCE` (no banner shown, by design)

**Finding.** A real inventory (not an assumption) of every client-side storage mechanism in this
app: Supabase's own session token (strictly necessary — the app cannot function signed-in without
it) and `pp-theme` (a user-set UI preference, not tracking). Nothing else. Cloudflare Web Analytics
(item 9) is, per Cloudflare's own current documentation, cookieless and uses no client-side storage
at all. No non-essential or third-party tracking mechanism exists in this app. Full reasoning and
the revisit condition if that ever changes: `docs/DECISIONS.md` D-117.

**Decision.** No cookie-consent banner is shown, deliberately — the prompt's own instruction is
explicit that a banner should not be added "simply because a checklist says so" when nothing
non-essential is actually collected, and adding one here would be decorative.

**Owner action.** None, unless a future session adds a non-essential/third-party storage mechanism
— see D-117's revisit condition.

---

## 16. Mobile version — `IMPLEMENTED` (public pages, live-tested) / owner check required (private)

**Implementation/test — public pages (live, automated).** `tests/e2e/launch-readiness.spec.ts`'s
viewport sweep covers 320×568, 768×1024 and 1920×1080 on `/login` and `/privacy` (no horizontal
scroll at any size); the existing Playwright project matrix additionally runs literally every spec
at both a 1440×900 desktop viewport and a real iPhone-14 device profile, so the new legal pages and
404 page are exercised at three distinct size classes each, not just one.

**Private routes (Portfolio tables/forms/charts/scanner shell/modals) — code review only.** Cannot
be live-tested this session (standing no-sign-in boundary). Existing conventions reviewed:
`docs/DESIGN_SYSTEM.md` §4's mobile-first 390px baseline, 768/1280 breakpoints, and
`env(safe-area-inset-*)` handling are already used consistently across the codebase (confirmed by
reading, not modifying, the relevant components) — no scanner-owned code was touched regardless of
what a review might have surfaced there.

**Owner action required.** A signed-in walkthrough of Portfolio (grid/list/table views), the
purchase/sale/opening forms, and the scanner shell on a real phone — same standing item every prior
milestone has carried since M7.1, not new to this session.

---

## 17. Accessibility — `IMPLEMENTED` (public pages) / owner check required (private)

**Implementation/test — public pages (live, automated, WCAG 2.2 AA).** `tests/e2e/a11y.spec.ts` —
`@axe-core/playwright` against `/login`, `/forgot-password`, `/invite/$token` (invalid-token
state), `/privacy`, `/terms`, `/faq`, and the 404 page. **Real findings from this run, not a clean
pass claimed without evidence:**
- A genuine WCAG AA contrast failure in `--pp-text-tertiary`'s light-mode value (4.41:1, just under
  the 4.5:1 threshold) — **fixed**: `src/styles/index.css`, one CSS custom property, corrected to
  `#6e6d61` (~4.95:1), which re-themes every `text-slate-500`/`text-slate-600` consumer app-wide at
  once (the codebase's own documented mechanism for exactly this kind of fix), not just the new
  pages that happened to surface it.
- A separate, more serious, pre-existing finding surfaced by Lighthouse (not axe): primary buttons
  app-wide (`bg-sky-600 text-white`, e.g. "Sign in") render at only **2.53:1** contrast in dark
  mode (`--pp-accent: #c99a66` with white text) — well under the 4.5:1 AA requirement. **FIXED
  (P103):** see item 17a below — this was CLOSED, not left as an owner design decision.

**P103 keyboard test.** `tests/e2e/a11y.spec.ts` additionally drives real Tab/Shift+Tab/Enter over
the login form and asserts a real visible focus indicator (`box-shadow` — this codebase's inputs
use `outline-none` plus a focus-visible ring/border-color change instead of the native outline, see
`src/ui/form.tsx`), not just DOM focusability.

**Private routes — code-level review only**, per the standing no-sign-in boundary. Existing
patterns reviewed (not modified): landmark/heading structure, form labeling, focus-visible rings
and `DESIGN_SYSTEM.md` §9's already-documented accessibility baseline are used consistently in the
files read.

**Owner action required.** A real signed-in keyboard/screen-reader pass over Portfolio, the
purchase/sale/opening forms and the scanner — cannot be automated this session.

---

## 17a. Dark-mode primary-button contrast — `IMPLEMENTED` (P103, CLOSED)

**Finding (P101).** `bg-sky-600 text-white` (the shared `Button` primary variant, plus 14 more
call sites app-wide that hardcoded the same pairing instead of using the shared component) renders
at **2.53:1** in dark mode (`--pp-accent: #c99a66` with white text) — a real WCAG AA failure
(normal-size text needs ≥4.5:1).

**Fix.** The FOREGROUND token changes, not the accent color itself (`DESIGN_SYSTEM.md`'s
bronze/copper direction is unchanged, per the prompt's own preference for this shape of fix). A new
`--pp-accent-foreground` token (`src/styles/index.css`, mapped to a `text-accent-foreground`
Tailwind utility via `@theme`) is white in light mode (unchanged, already ~5.44:1 — AA) and
`#101113` in dark mode (measured **~7.46:1** against `#c99a66`, comfortably past the 4.5:1 floor —
not just barely over it). `src/ui/form.tsx`'s shared `Button` primary variant and all 14
independent call sites that had hardcoded `text-white` (`HomePage`, `PurchasesListPage`,
`ListAndTableViews` ×2, `BottomNav`, `GridTile`, `NotFoundPage`, `DesktopNav`,
`SealedProductDetailPage`, `CardDetailPage`, `PortfolioPage`) now use `text-accent-foreground`
instead — an app-wide fix, not a partial one covering only the shared component.

**Audit of adjacent states.** Hover (`hover:bg-sky-500`) and the nav FAB's `active:bg-sky-700`
resolve to the identical `--pp-accent` value, so the same foreground fix covers them structurally.
Disabled state (`disabled:opacity-60`) is WCAG-exempt for contrast (1.4.3 excludes inactive
controls) and unchanged. Focus indication uses a separate `outline-sky-500` ring, not text
color — unaffected and unchanged. The `quiet`/secondary Button variant does not share the accent
token at all (`border-slate-700 text-slate-200`) and was never affected.

**Verified three independent ways:**
1. `tests/config/color-contrast.test.ts` (new) — reads the actual hex values out of
   `src/styles/index.css`, computes the real WCAG relative-luminance/contrast-ratio formulas (no
   rendering infrastructure exists in this project), and asserts ≥4.5:1 in all three theme blocks
   (light, system-dark, explicit dark override), plus a static grep-equivalent audit that NO
   `.tsx` file anywhere pairs `bg-sky-[567]00` with `text-white` any more.
2. A live, real Playwright + `@axe-core/playwright` run against the 404 page (the one
   unauthenticated route rendering this exact button surface) with `page.emulateMedia({
   colorScheme: 'dark' })` — real browser, real computed styles, zero contrast violations.
3. Lighthouse against `/login` (also rendering a primary button): accessibility **92 → 100** — see
   item 20's updated table.

**Before/after:** 2.53:1 → ~7.46:1 (dark mode); light mode unchanged at ~5.44:1.

---

## 18. Forms — `IMPLEMENTED` (public forms, live-tested) / read-only review (private forms)

**Implementation/test — public forms (live, automated).** Login (empty/invalid input via the
pre-existing `auth.spec.ts`, keyboard submit via `Enter`, double-submit guard — both new in
`tests/e2e/launch-readiness.spec.ts`), invite redemption, forgot/reset password — all exercised
against a real rendered form with a real (placeholder-backend) network round trip.

**Private forms (purchase/sale/opening/settings/admin-invite) — read-only review only.** No live
authenticated exercise this session. The one real code change touching these files (item 8's
`label`/`id` fix on the shared "Notes" field pattern in `PurchaseFormPage.tsx`/
`PurchaseEditPage.tsx`/`SaleFormPage.tsx`/`SaleEditPage.tsx`) is a two-line, purely additive
accessibility fix, verified not to touch `SaleForm`'s async-prefill logic (P99/P100's territory) —
confirmed by reading the surrounding code before editing (a static textarea block, unrelated to
any prefill state/effect).

**Owner action required.** A real signed-in exercise of each private form (empty/invalid/
double-submit/slow-response/mobile) — standing item, not new to this session.

---

## 19. Broken links — `IMPLEMENTED`

**Implementation.** `scripts/check-links.mjs` (new, `pnpm check:links`) — static mode (default,
CI-safe, no network) checks a real production build: robots.txt/sitemap.xml/`PUBLIC_ROUTES`
three-way consistency (including the never-allow-a-token-route and deny-by-default assertions),
every local `href`/`src` `index.html` references resolves to a real file, the PWA manifest and its
icons resolve, `og:image` resolves, the P83/D-100 nested asset-directory 404 pages exist, `_headers`
exists. Optional live mode (manual, `DEPLOYMENT_URL` env var, matching
`deployment-check.mjs`/`remote-security-check.mjs`'s no-remote-credentials-in-CI convention)
additionally re-fetches robots.txt/sitemap.xml/the three public pages against a real deployment.

**Test.** Run against this session's own real production build: **29/29 checks passed.**

**Owner action.** Optionally run live mode (`$env:DEPLOYMENT_URL = "https://pokeportfolio-dev.pages.dev"; node scripts/check-links.mjs`) after this deploys, for the belt-and-suspenders live confirmation — not required, the static check already covers the actual risk (a drifted private/public route list).

---

## 20. Performance — `IMPLEMENTED` (measured, public pages) / code review (private pages)

**Bundle stats (real, measured this session, `pnpm build`):** main entry chunk
**~398 KB raw / ~119-121 KB gzip** — unchanged in shape from P101's baseline (398.75 KB / 120.64 KB);
the small movement is the CSP hash constant, the new `--pp-accent-foreground` token and doc
comments, not a real size regression. Scanner assets (105 KB `ScannerPage` chunk, visual-recognition
worker, WASM) confirmed to remain OUTSIDE the install-time precache manifest
(`scripts/verify-scanner-platform-build.mjs`: "scanner assets are absent from the precache manifest
— 0 scanner entries"; "the app shell is still precached — 61 entries") — the scanner stays
lazy-loaded exactly as required; nothing in this session's changes added a new eager import
anywhere.

**Lighthouse (real, re-measured against the local production preview server, P103, after the CSP
and contrast fixes below):**

| Page | Performance | Accessibility | Best Practices | SEO |
|---|---|---|---|---|
| `/login` | 94 | **100** (was 92*) | 100 | 63** |
| `/privacy` | 95 | 100 | 100 | 100 |
| `/terms` | 95 | 100 | 100 | 100 |
| `/faq` | 93 | 100 | 100 | 100 |

\* The dark-mode primary-button contrast finding from item 17a (2.53:1) — CLOSED this session; the
100 above is the real, re-measured result, not a projection. \*\* Deliberately low: Lighthouse's SEO
category penalizes "blocked from indexing," which is the correct, intentional state for `/login`
per D-116 — a high SEO score here would mean the deny-by-default policy had failed.

**Private/authenticated pages (Portfolio virtualized lists, charts, API waterfalls) — code review
only.** Real measurement needs a signed-in session, out of reach this session. Existing patterns
reviewed: TanStack Query caching and `react-virtual` (already in use for large lists) were not
modified.

**Owner action.** None required to ship; optionally run Lighthouse against authenticated pages once
signed in.

---

## Other items resolved as part of this pass

**Security headers (prompt §23) — `ALREADY_CORRECT_AND_VERIFIED`, with one finding CLOSED (P103).**
CSP/Referrer-Policy/X-Content-Type-Options/Permissions-Policy/HSTS were already correctly generated
(`vite.config.ts`'s `cloudflareHeaders()` plugin, pre-existing) and remain unchanged in shape apart
from the item-9 analytics allowance (off by default) and the fix below.

**P101 finding:** `dist/index.html` contained the theme-bootstrap inline `<script>` (no nonce/hash)
while `script-src` granted no `'unsafe-inline'` — per CSP spec this script was BLOCKED by the
browser on the real Cloudflare Pages deployment (`_headers` is enforced only there; `vite preview`
ignores it, so this was never visible locally), meaning the flash-of-wrong-theme prevention it
exists for likely silently no-op'd in production.

**Fix (P103): exact `sha256-…` CSP hash, never `'unsafe-inline'`.** `THEME_BOOTSTRAP_SCRIPT`
(`vite.config.ts`) is now the ONE place the script's source is authored. Two consumers read that
exact same string, so they cannot drift apart the way an independently hand-computed hash could:
`themeBootstrapHtml()` injects it as index.html's first-in-head inline `<script>` via Vite's
standard `transformIndexHtml` hook (both `vite dev` and `vite build` — never hand-written HTML
again), and `buildContentSecurityPolicy` hashes the same string into `script-src` as a `'sha256-…'`
source expression. Chosen over an external same-origin file (the other option considered) because
it stays truly inline — zero added network round trip, earliest possible execution before first
paint — while still being exactly as simple to maintain: one constant, two readers, no
independently-tracked hash to forget to update.

**Verified three ways, against the ACTUAL built artifacts, not just the source:**
1. `tests/config/security-headers.test.ts` — pins the exact hash is present in the CSP the config
   function generates, is a valid CSP3 sha256 expression, and appears whether or not analytics is
   enabled.
2. `scripts/verify-scanner-platform-build.mjs` (extended) — after a real `pnpm build`, reads the
   ACTUAL `dist/index.html`'s inline `<script>` text, computes ITS OWN sha256 hash, and asserts
   that hash appears in the ACTUAL `dist/_headers` CSP — a real-artifact proof, immune to any future
   Vite/minifier change that might reformat the injected script differently than assumed.
   Real run: **27/27 checks passed**, including this one.
3. `dist/index.html` was inspected directly after a real build — exactly one inline `<script>`,
   136 characters, hash `sha256-t0quyCFNdpK+drpB8vRMfX45phqmcxdlqpJo9S4pr6Y=` (this exact hash will
   change if the script's literal text ever changes — that's the point; checks 1-2 above assert the
   two stay equal to EACH OTHER, not to this literal value, so no test needed updating by hand here).

`script-src` still grants no `'unsafe-inline'` anywhere, and the scanner's own
`'wasm-unsafe-eval'`/`blob:` allowances are untouched.

**Scanner accessibility — directory-wide lint suppression narrowed (P103).** P101 disabled
`jsx-a11y/media-has-caption` and `jsx-a11y/img-redundant-alt` for the ENTIRE
`src/features/scanner/**` glob in `eslint.config.js` — a blind spot that could mask a real,
unrelated accessibility regression anywhere else the scanner grows. P103 removed that
directory-wide block entirely and fixed both original findings narrowly instead:
- `media-has-caption` on the live camera preview `<video>` — audited and confirmed a genuine false
  positive (the element is muted, real-time self-view of the device's own camera; there is no
  audio/dialogue track at any point in its lifetime to caption, unlike the prerecorded/broadcast
  media the rule targets). Suppressed with a single `eslint-disable-next-line` directly above that
  one `<video>` in `ScannerPage.tsx`, carrying the justification inline — not app-wide, not even
  scanner-directory-wide.
- `img-redundant-alt` on the captured-photo preview — genuinely fixed, not suppressed:
  `alt="Captured card photo"` → `alt="The card you captured"` (screen readers already announce the
  element as an image; repeating "photo" was the actual redundancy the rule caught).

Also audited per the prompt's named list — shutter/close/retake/manual-search controls, candidate
selection, debug controls, status announcements — and found already correctly instrumented
(explicit `aria-label`s on icon-adjacent buttons, `aria-pressed` on candidate-selection toggles,
`role="status"`/`aria-live="polite"` on every processing/result/no-match announcement). No further
scanner UI changes were needed.

`tests/ui/scanner-a11y-audit.test.ts` (new, 8 assertions) pins all of this as a static source-text
audit — no model loading, no DB, no rendering infrastructure (this project has none, see the
D-109/D-110 notes in DECISIONS.md) — including a permanent regression guard that `eslint.config.js`
never reintroduces the directory-wide suppression. `pnpm lint`: 0 errors, 28 warnings — the same
pre-existing baseline, confirming the narrower fix satisfies the linter exactly as well as the
broad suppression did.

**Error/empty/loading states (prompt §24).** The 404 page (item 7) and the existing
`AppErrorComponent` (`router.tsx`, pre-existing from P83/D-100) cover the two concrete cases the
prompt names. One targeted fix: `AppErrorComponent`'s non-chunk-load branch previously delegated to
TanStack Router's own `ErrorComponent`, which ships a "Show Error" toggle that renders the raw
error/stack **in production, not just development** — a genuine raw-exception-text leak. Gated to
`import.meta.env.DEV` only; production now shows a generic "Something went wrong" + reload action.
D-100's chunk-load-vs-generic split and the P89 unsaved-work logic are untouched.

---

## Test summary — P103 (this session, real runs, on top of the P99 base + P101 delta)

| Check | Result |
|---|---|
| `pnpm typecheck` | clean |
| `pnpm lint` | 0 errors (28 pre-existing warnings, unrelated to this session — same baseline as P101) |
| `pnpm format:check` | clean |
| `pnpm test` (unit/domain) | 1181/1181 |
| `pnpm build` | green — see bundle stats above |
| `pnpm test:e2e` (non-authenticated, both projects) | 128/130 — the 2 failures are BOTH the identical pre-existing `visual-worker-real-browser.spec.ts` assertion (`cardCount` 0, expected >0), confirmed to reproduce IDENTICALLY on the unmodified P99 base BEFORE any P101/P103 change — an environment/catalog-state issue in the real visual-index staging pipeline, not a regression, and explicitly out of this session's scope (scanner recognition/visual-index internals) |
| `node scripts/check-links.mjs` | 29/29 |
| `node scripts/verify-scanner-platform-build.mjs` | 27/27 (new: the theme-bootstrap CSP hash cross-check) |
| Lighthouse (4 public pages) | see updated table above — login accessibility 92 → 100 |

## Not covered by this session (owner-facing, standing since before P101)

- Any real signed-in mobile/accessibility/forms/performance exercise of private routes.
- Live deployment verification of `scripts/check-links.mjs` and the analytics CSP allowance (needs
  a real deploy with the token set).
- The pre-existing `visual-worker-real-browser.spec.ts` `cardCount` failure above — belongs to
  whoever owns the visual-index staging pipeline (P97/P100 territory), not this session.
