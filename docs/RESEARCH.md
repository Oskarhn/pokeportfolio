# Research Log

Only findings that changed a decision or are likely to be re-litigated. Not a search history.

Confidence: **Verified** (primary source or direct probe) · **Reported** (secondary source) ·
**Uncertain** (contradictory or undeterminable).

---

## R1 — Cardmarket API is closed to new applicants

**2026-08-16 · Verified**

**Question:** can a small private project obtain Cardmarket API access?

**Finding:** no. Cardmarket's own help page states verbatim: *"Currently, we are not accepting
applications for access to the Cardmarket API"*, and prohibits sharing credentials with
third-party software.

**Source:** https://help.cardmarket.com/en/cardmarket-api

**Consequence:** European price data must come indirectly. Drove the search that found TCGdex
(R3). Removes any option that depends on holding Cardmarket credentials.

---

## R2 — TCGplayer API is closed to new developers

**2026-08-16 · Reported**

Public developer applications closed around late 2024 following the eBay acquisition; access is
limited to existing partners and large sellers, with reports of existing keys being deprecated.
Multiple secondary sources agree; no primary announcement located.

**Consequence:** no direct US price feed either. Combined with R1, every direct marketplace API
route is closed, which is what makes TCGdex load-bearing.

---

## R3 — TCGdex relays Cardmarket and TCGplayer prices, free and unauthenticated

**2026-08-16 · Verified by direct probe**

**Question:** is there any free, legitimate route to European (EUR) card prices?

**Finding:** yes. `GET https://api.tcgdex.net/v2/en/cards/swsh3-136` returns
`variants_detailed[].pricing` containing a `cardmarket` object in EUR (`avg`, `low`, `trend`,
`avg1`, `avg7`, `avg30`, plus `-holo` variants, with `idProduct` and an `updated` timestamp) and
a `tcgplayer` object in USD with per-finish price points. No API key. Observed `updated`
timestamp was the same morning as the probe.

Catalog coverage probed the same day: 218 English sets, 23 444 English cards, 177 Japanese sets.

**Consequence:** this is the foundation of the pricing architecture. Documented fully in
[API_SOURCES.md](API_SOURCES.md).

**Residual risk:** community-run, no SLA, no contract, FAQ describes pricing accuracy as
"actively being improved". Mitigated by the provider abstraction and by owning our own snapshots.

---

## R4 — No free source of historical EUR card prices

**2026-08-16 · Verified by probe + Reported**

**Question:** can portfolio history be backfilled rather than accumulated?

**Finding:** no. TCGdex has no history endpoint (`/pricing` and `/prices` both 404). Its
`avg1`/`avg7`/`avg30` are moving averages, not a series. Cardmarket's API is closed (R1).
PriceCharting has some history but is paid and US-market. No free EUR series was identified.

**Consequence:** portfolio history is built from our own daily snapshots and begins at first
tracking. The chart shows an explicit origin. Applying today's price backwards was considered
and rejected as fabricated data — it is precisely the failure mode this product exists to avoid.
Codified in FINANCIAL_MODEL §3 and DATA_MODEL §4.2.

---

## R5 — No free sealed-product pricing for the European market

**2026-08-16 · Verified by probe**

TCGdex has no product endpoint (`/products` → 404). TCGCSV mirrors TCGplayer's catalog including
sealed products, free and daily, but is USD/US-market and has undocumented terms. Cardmarket's
newly public Product Catalogue may cover this but requires authentication to inspect (R6).

**Consequence:** sealed valuation is manual in MVP. A US reference may appear later, explicitly
labelled and never used in collection value. European sealed prices diverge substantially from
US ones, so silently substituting them would be misleading, not approximate.

---

## R6 — Cardmarket Price Guide and Product Catalogue are now publicly downloadable

**2026-08-16 · Reported; blocked on authenticated verification**

Cardmarket announced that the Price Guide and Product Catalogue, previously restricted to API
users, are downloadable by all users from `cardmarket.com/Data/Download`. Price guide daily,
catalogue on new releases. A Pokémon-specific version of the announcement exists.

An unauthenticated request to the download page returned **HTTP 403**, so content, schema,
sealed coverage and reuse terms could not be determined.

**Source:** https://news.cardmarket.com/en/Pokemon/were-making-the-price-guide-and-product-catalogue-available-for-download

**Consequence:** potentially the best available European sealed source. Does not block MVP
because sealed valuation is manual by design. One authenticated inspection resolves it; scheduled
against the V1 sealed milestone rather than now.

---

## R7 — Graded pricing has no viable free source

**2026-08-16 · Reported**

PSA's public API was reduced to roughly one call per day for anonymous and free tokens in
mid-2026; cert and spec lookups now require a paid plan. No public API for population reports.
Scrydex offers graded prices from ~$29/month. PriceCharting covers all grades at ~$59/year but
is US-market.

**Consequence:** graded holdings use manual valuation. Invariant F10 forbids substituting a raw
price for a graded card — a PSA 10 commonly trades at a large multiple of raw, so the
substitution would not be an approximation but a fabrication.

---

## R8 — pokemontcg.io is not viable

**2026-08-16 · Verified by probe**

Two requests (`/v2/cards`, `/v2/sets`) both returned **HTTP 500**. The maintaining team has
publicly shifted to the commercial Scrydex.

**Consequence:** eliminated as a catalog candidate despite being the best-known option.

---

## R9 — iOS standalone PWA re-prompts for camera permission on URL change

**2026-08-16 · Reported, corroborated across sources**

**Question:** can a bulk scanning session work inside an installed iOS PWA?

**Finding:** WebKit does not persist camera permission for standalone web apps across URL
changes. Bug 215884 (hash-change re-prompt) remains open in 2026. Reported workarounds amount to
granting Safari blanket camera access, which is not acceptable to require.

**Sources:** https://bugs.webkit.org/show_bug.cgi?id=215884 · https://kb.strich.io/article/29-camera-access-issues-in-ios-pwa

**Consequence:** architectural, and decided now rather than discovered later. The scanner is a
single route holding one `MediaStream` for the whole session; per-card confirmation happens in
an in-route overlay with no navigation and no URL mutation. Recorded in ARCHITECTURE §6 and
[SCANNER_RESEARCH.md](SCANNER_RESEARCH.md).

---

## R10 — Fully on-device browser card recognition is demonstrated

**2026-08-16 · Reported, single credible implementation**

A published implementation runs detection and recognition entirely client-side: YOLO11n (~5 MB)
for card localisation, MobileCLIP-S2 (FP16) for embeddings, WebGPU with WebGL/WASM fallback,
matching against embeddings generated from ~20 000 TCGdex card images. Reported timings: ~10 ms
detection plus 50–80 ms recognition on desktop; a few hundred milliseconds on mobile, "never
more than a second" on good devices. No accuracy figures published.

**Source:** https://ankush.one/blogs/pokemon-scanner/

**Consequence:** an on-device scanner with zero recurring API cost and no images leaving the
device is realistic. Not committed to these specific models — the model landscape will have
moved by the time the scanner is built, and it is re-researched then. What is committed now is
the architectural shape that makes it possible.

---

## R11 — Supabase Auth: email OTP stable, passkeys experimental

**2026-08-16 · Verified**

Magic links and email OTP share an implementation; substituting `{{ .Token }}` for
`{{ .ConfirmationURL }}` in the email template yields a six-digit code. Passkeys require
`auth.experimental.passkey: true` and are documented as experimental with an API that may change
without notice.

**Sources:** https://supabase.com/docs/guides/auth/passkeys · https://supabase.com/docs/reference/javascript/auth-signinwithotp

**Consequence at the time:** email OTP for MVP, passkeys deferred until stable.

**Superseded by R18.** The rate-limit finding made OTP unworkable, and the choice became email
and password. A magic link opened from Mail on iOS also launches Safari rather than the installed
PWA, so neither email-based flow survived. Passkeys remain deferred on the same grounds.

---

## R18 — Supabase built-in email is limited to 2 auth emails per hour, project-wide

**2026-08-16 · Verified**

**Question:** is email-based login sustainable for 5–10 users at zero cost?

**Finding:** no, not with the built-in provider. The documented limit is **2 emails per hour for
the whole project** — not per user — covering signup, password recovery and email changes.
Supabase's own documentation describes the built-in provider as unsuitable for production and
subject to change without notice. With a custom SMTP provider the limit rises to 30 new users
per hour and becomes configurable.

**Source:** https://supabase.com/docs/guides/auth/rate-limits · https://supabase.com/docs/guides/auth/auth-smtp

**Free SMTP options evaluated:** SMTP2GO (1 000/month, 200/day, 25/hour without a verified
domain, five single-sender verifications, no card — the only one confirmed to work without owning
a domain), Brevo (300/day), Mailjet (6 000/month). **Resend was excluded** despite a 3 000/month
allowance because it requires a verified domain, and a domain is a purchase — a free plan with a
paid prerequisite fails the zero-cost test.

**Consequence:** authentication changed to email and password, which sends no email during normal
login and removes the dependency rather than working around it. Password reset stays on the
built-in provider — a handful of events per year against a limit of two per hour — with an
admin-assisted fallback and a documented trigger for adding SMTP2GO if that ever changes.
Recorded as [D-022](DECISIONS.md).

---

## R19 — All-card tracking does not threaten the storage ceiling

**2026-08-16 · Derived, from verified inputs**

**Question:** does tracking every physical card, including energies and commons, break the 500 MB
free-tier database limit?

**Finding:** no, because price history is keyed per *card variant*, not per *physical copy*.
Eighty identical energies produce one snapshot row per day, not eighty. Snapshot volume therefore
scales with distinct printings owned — which plateaus as duplicates and playsets collapse — rather
than with cards owned, which does not.

A 10 000-card collection realistically spans 3 000–4 000 distinct variants: ~105 MB/year at two
price kinds, with thinning after twelve months. Holdings and lots are roughly 200 bytes each, so
10 000 lots is ~2 MB.

**Consequence:** all-card tracking was adopted without a storage compromise. The real costs are
query and rendering shaped — keyset pagination, virtualisation, lazy image loading sized to grid
density, and dashboard figures read from precomputed snapshots. Recorded as
[D-017](DECISIONS.md) and [D-019](DECISIONS.md).

---

## R12 — Supabase free tier: no backups, pauses after 7 days

**2026-08-16 · Verified**

Free plan: 500 MB database, 1 GB storage, 5 GB egress, 50 000 MAU, 500 000 edge invocations,
2 active projects. **No automated backups** — the documentation explicitly recommends free-tier
projects run `supabase db dump` regularly and keep off-site copies. Projects pause after roughly
7 days without database activity, require manual resume, and are restorable within 90 days.
`pg_cron` is enabled on all plans including Free. EU regions include `eu-north-1` (Stockholm).

**Sources:** https://supabase.com/docs/guides/platform/backups · https://supabase.com/docs/guides/platform/free-project-pausing · https://supabase.com/docs/guides/platform/regions

**Consequence:** the 500 MB ceiling drives the decision to snapshot only held variants rather
than the full catalog (DATA_MODEL §4.2). The absence of backups is stated plainly in
ARCHITECTURE §3 and must never be papered over in the UI. `eu-north-1` selected.

---

## R13 — Storage sizing for price history

**2026-08-16 · Derived**

Snapshotting all ~23 400 English variants daily at ~48 bytes per row is roughly 410 MB/year —
over 80% of the free tier for data nobody reads. Snapshotting only held variants, at an assumed
3 000 variants × 2 price kinds, is roughly 105 MB/year.

**Consequence:** `watched_card_variants` view drives the ingest job; rows older than 12 months
thin to weekly. Accepted limitation: a variant's history begins at acquisition.

---

## R14 — Vite SPA beats a meta-framework for this application

**2026-08-16 · Judgement, informed by current framework landscape**

Next.js 16 is stable with React 19.2, Cache Components and Turbopack. TanStack Start reached 1.0
and benchmarks higher than React Router v7 and Next.js. All three are viable.

None of the server-rendering capability is usable here: every screen is authenticated and
personalised, the backend is Supabase, and the only real secret lives in Edge Functions. Against
that, a meta-framework adds hydration boundaries and a runtime, and the scanner needs precise
control over client-side component lifetime (R9).

Vercel Hobby's non-commercial restriction is a further argument against coupling to that model
for a repository intended as a portfolio piece.

**Consequence:** Vite + React SPA on Cloudflare Pages. Recorded as [D-004](DECISIONS.md).

---

## R15 — shadcn/ui now defaults to Base UI

**2026-08-16 · Reported**

Base UI shipped 1.0 in December 2025 and is maintained in part by engineers who originally built
Radix. As of July 2026 shadcn/ui defaults to Base UI for new projects; Radix is not deprecated
but its velocity has slowed on complex components. shadcn/ui's copy-into-repo model means no
runtime dependency on either.

**Consequence:** Tailwind v4 + shadcn/ui on Base UI. The ownership model matters more than the
primitive choice here: owning the component source is what allows the design system to avoid
looking like a default component library.

---

## R16 — Chart library

**2026-08-16 · Reported + judgement**

TradingView `lightweight-charts` is Apache 2.0, canvas-rendered, explicitly touch-optimised for
phones and tablets, and provides area and histogram series — covering both time-indexed charts
this product needs. Recharts is the popular React default but renders SVG per point, degrading
on multi-year daily series, and carries the generic dashboard aesthetic the design brief rejects.
ECharts has the best touch handling of the general-purpose libraries but is heavy for two charts.

**Consequence:** `lightweight-charts` for time series; plain SVG/CSS for breakdowns and
sparklines; no second chart library. Validated by a spike before the dashboard is built;
fallback is `visx`.

---

## R17 — Node.js LTS

**2026-08-16 · Verified by install**

Node 24 is Active LTS; Node 22 is Maintenance; Node 26 is Current and enters LTS in October 2026.
Installed **24.19.0** via `winget install OpenJS.NodeJS.LTS`.

Note for later: from October 2026 Node moves to one major release per year with calendar-aligned
version numbers and every release becoming LTS. Worth revisiting the pin then.

---

## R21 — Supabase Before User Created hook, and what GoTrue actually invokes it from

**2026-08-20 · Verified against official documentation and the GoTrue source**

Supabase's Auth Hooks documentation lists **Before User Created** as available on Free and Pro. It
receives the event as JSON, returns `{}` to allow or an `{ error: { http_code, message } }`
object to reject, and can be implemented as a Postgres function or an HTTP endpoint. Postgres hooks
run inside the auth transaction with a 2-second budget, and their errors propagate to the client
rather than being retried. Configurable as code:
`[auth.hook.before_user_created] enabled/uri` in `config.toml`, pushed to a project with
`supabase config push`.

The load-bearing fact is not in the documentation, and was established by reading
`supabase/auth` at master. `triggerBeforeUserCreated` is invoked from `signup.go`,
`mail.go`, `anonymous.go`, `external.go`, `web3.go`, `samlacs.go`, `token_oidc.go` and
`invite.go` — every self-service account-creation path — and **`internal/api/admin.go`, which
serves the Auth Admin API, contains no hook invocation at all.** A GitHub code search for
`BeforeUserCreated` across the repository returns those files and not `admin.go`.

**Consequence:** the hook can deny unconditionally while `auth.admin.createUser` still works, which
is the entire basis of D-028. (Note the numbering: R18 and R19 were already taken by the email
rate-limit and storage findings, so the M4 research starts at R21.) Because this is a source-level
fact rather than a documented
guarantee, it is verified continuously rather than trusted: the authorization suite asserts both
that public signup fails *and* that redemption succeeds, so a change in either direction fails CI.

**Re-verified 2026-08-20 (M4.1)** against `supabase/auth` at commit
`bc32168e13fdc928c98b449fc76bc3fdb9a293c5` (`master`, 2026-08-20; latest release `v2.196.0`,
2026-08-18; the dev project runs GoTrue `v2.195.0`). Unchanged: a repository code search for
`triggerBeforeUserCreated` returns nine files — `hooks.go`, where it is defined, and the eight
self-service paths listed above. `internal/api/admin.go` at that commit contains no occurrence of
`BeforeUserCreated`, and `adminUserCreate` constructs the user through `models.NewUser` /
`models.NewUserWithPasswordHash` and persists it directly, with no hook call anywhere in the
function.

Pin the version, not the branch, when reading this later: `master` moves, and the point of
recording a commit is that a future session can tell whether it is looking at the same code.

**What protects this if it changes.** Not the assumption — the triangle around it. Public signup
must fail, Admin creation without a claim must fail, and a valid redemption must succeed; all three
are asserted, and no two of them can be satisfied by an accident. If a future GoTrue started
invoking the hook from the Admin API, redemption would break loudly and CI would fail, which is the
safe direction: the gate would close too far rather than open. Gate 2, the `auth.users` trigger,
holds regardless of what GoTrue does, because it is not GoTrue's to change.

---

## R22 — Supabase API key terminology is mid-migration

**2026-08-20 · Verified against official documentation**

Supabase is replacing the legacy `anon` and `service_role` JWTs with `sb_publishable_…` and
`sb_secret_…` keys. Both work simultaneously; legacy keys stay valid until explicitly disabled and
are documented as deprecated by end of 2026. Secret keys additionally refuse to work from a browser
(matched on the `User-Agent` header) — a backstop, not a substitute for keeping them server-side.

**Consequence:** security semantics are unchanged, so no architecture depends on this. The local
Supabase stack still emits the legacy pair, so both names appear in this repository; remote projects
use the new keys. SECURITY.md §6 carries both names in the secrets table.

---

## R23 — Supabase config as code reaches remote projects

**2026-08-20 · Verified against the CLI reference and `supabase --help`**

`supabase config push` updates a linked remote project from local `supabase/config.toml`. This
matters because Gate 1 of the invite-only enforcement is a config entry, not a migration: without
it, "remember to toggle this in the dashboard" would have been an un-versioned security control.
`supabase projects create` likewise exists, so remote project creation does not require the
dashboard either.

**Consequence:** the invite-only gate is fully reproducible from this repository plus an access
token. DEVELOPMENT.md §3 lists `config push` alongside `db push` and states why skipping it
leaves an environment with one gate missing.

---

## R24 — TCGdex `variants_detailed[]` is real, three-dimensional, and imperfect

**2026-08-20 · Verified by live request, M5**

The M3-era research note that TCGdex exposes `variants_detailed[]` with per-variant pricing was
correct but incomplete — re-verified rather than assumed, per this milestone's own mandate. Live
requests to `/v2/en/cards/base1-4` (Charizard, Base Set), `/v2/en/cards/base1-98` (Fire Energy),
`/v2/en/cards/swsh1-1` and `/v2/en/cards/swsh1-2` (Sword & Shield era) show:

- Each entry carries `type` (finish), an optional `subtype` (print-run/era: `shadowless`,
  `unlimited`, `1999-2000-copyright`, `no-rarity`), an optional `stamp[]` array (`1st-edition`),
  `size`, `variantId`, and per-variant `pricing`.
- Base Set Charizard has a variant that is `holo` + `shadowless` + `1st-edition` at once — three
  independent dimensions, which the M3 `variant_type` enum could not represent as one value. Drove
  D-033.
- `variantId` is sometimes the literal string `"generated"` (Celebi V, Roselia, a promo Grookey all
  observed with it) — TCGdex's own placeholder, not a real cross-reference, and it repeats across
  unrelated cards.
- Pricing product ids are not per-variant: Roselia's `normal` and `reverse` variants share one
  TCGplayer `productId`. Drove D-034.
- `variants_detailed` is sometimes absent or empty; the adapter falls back to the boolean
  `variants{}` flags so no card is left with zero variants.

**Consequence:** `supabase/functions/_shared/tcgdex.ts` is the one place any of this is read;
`tests/data/tcgdex-provider.test.ts` pins the mapping against these exact real payloads so a future
provider change is caught by a failing test rather than a silent ingest defect.

---

## R25 — TCGdex identifiers collide across languages; GraphQL and bulk export were both rejected

**2026-08-20 · Verified by live request, M5**

`/v2/en/sets` and `/v2/ja/sets` both return a set id `neo1`; `/v2/en/series` and `/v2/ja/series`
both return a series id `neo`. TCGdex ids are unique **within a language**, not globally — the
M3-era schema's global unique indexes on `tcgdex_set_id`/`tcgdex_card_id` (and the missing provider
column on `card_series` entirely) would have broken on the second language's ingest. Drove D-034.

Two ingest strategies were evaluated against REST and rejected: **GraphQL** (`/v2/graphql` is
reachable and introspectable, but the `cards`/`card` root query fields carry no language argument at
all, and `tcgdex.dev/graphql` states its documentation is still in progress — not a foundation to
build language-correct ingest on) and a **bulk database dump** (`github.com/tcgdex/cards-database`
is per-card JSON files structured for API/SDK consumption, not a single exportable archive). REST,
one set per request plus one request per card in it, is the strategy actually used —
API_SOURCES.md's "Catalog ingest strategy" section has the shape.

---

## R26 — Pokémon TCG Pocket is a separate, cleanly identifiable series

**2026-08-20 · Verified by live request, M5**

TCGdex's English catalog includes Pokémon TCG Pocket (digital-only, out of scope for this physical-
inventory app per M5 prompt §8) as its own series, `serie.id === "tcgp"` — 15 sets as of this date
(`A1`, `A1a`, `A2`, `A2a`, `A2b`, `A3`, `A3a`, `A3b`, `A4`, `A4a`, `B1`, `B1a`, `B2`, `B2a`, `P-A`).
No Pocket series exists in the Japanese catalog as of this date. The exclusion is exact and
mechanical (a series id equality check), not a heuristic over set names — checked both in the
ingest orchestrator (so a Pocket set is never even requested) and inside `sync-catalog` itself
(so the exclusion holds even if something calls the function directly with a Pocket set id).

---

## R27 — TCGdex rate-limit behaviour, observed (resolves U3)

**2026-08-20 · Observed from the M5 full-catalog ingest run**

The FAQ's "no published hard rate limit, please be considerate" was tested against a real run: ~380
sets (203 English, ~177 Japanese minus Pocket exclusions) fetched sequentially, bounded concurrency
5 within each set for card detail, ~400–600 ms pause with jitter between sets. No `429` or other
rate-limit response was observed across the run. Kept conservative regardless — this is a one-time/
manual-refresh operation (M5 prompt §32), not a pattern that runs often enough to need to find the
provider's actual ceiling.

---

## R28 — Two real ingest gaps, from the full English + Japanese run

**2026-08-20 · Observed from the M5 full-catalog ingest, ~380 sets, 32,690 cards**

Six sets returned 404 specifically when requested from the Supabase Edge Function's network path,
while an identical request from this development machine, at the same moment, returned 200 — and a
sanity-check re-sync of an unrelated known-good set from the Edge Function immediately afterward
succeeded. Points at TCGdex's own edge/CDN infrastructure being inconsistent by request origin
rather than at a defect in the ingest code. Affected: `swsh9.5tg`, `swsh10.5tg`, `swsh11.5tg`,
`swsh12.5tg` (English), `sn10a`, `sn11` (Japanese) — well under 1% of the catalog by card count.

Separately, comparing summed `cardCount.total` against actual ingested rows across 374 sets found 76
mismatches; 72 of them are sets where TCGdex's own set-detail response has a non-zero `cardCount`
but a literally empty `cards[]` array (verified directly, e.g. `ja/CS2b`: `cardCount.total: 101`,
`cards: []`). Most are the same Japanese product cataloged under many set ids (regional SKUs), with
only one of each family actually populated. A provider data-completeness gap, not an ingest defect.
The remaining 4 sets have small (1-14 card) genuine short-counts against their own `cardCount`,
consistent with "provider incompleteness is normal" — not investigated further given the size.

**Consequence:** no code change from either finding. Documented so a future re-sync attempt (for the
six 404s) and a future full re-ingest (which will re-hit the same 72 empty-`cards[]` sets) are not
mistaken for regressions.

---

## Open uncertainties

Carried deliberately. Each is a real gap, not a guess in disguise.

| # | Uncertainty | Blocks | Resolution path |
|---|---|---|---|
| U1 | Whether TCGdex has any arrangement with Cardmarket or TCGplayer for relaying price data | Nothing at private scale; would matter before public release | Ask maintainers; re-read terms if published |
| U2 | Whether Cardmarket's public Product Catalogue covers Pokémon sealed products, and its terms | Sealed valuation improvement (V1) | One authenticated inspection |
| ~~U3~~ | ~~TCGdex rate limits in practice~~ — **resolved, R27**: no rate-limit response observed across a ~380-set full-catalog ingest at bounded concurrency 5 | — | — |
| U4 | TCGdex price update cadence | Snapshot scheduling | Compare `updated` timestamps across our own daily runs |
| U5 | Real-device iOS behaviour of the installed PWA | PWA polish (V1) | Test on hardware |
| U6 | Whether manual sealed and graded valuation is tolerable in daily use | Whether a paid source becomes worth its cost | Reassess after real use |
