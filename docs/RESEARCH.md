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

**Consequence:** email OTP for MVP. Passkeys deferred until stable.

**Additional reasoning, not from the docs:** a magic link opened from Mail on iOS launches
Safari, not the installed PWA, breaking the flow for the primary target platform. This is an
independent reason to prefer OTP even after passkeys stabilise.

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

## Open uncertainties

Carried deliberately. Each is a real gap, not a guess in disguise.

| # | Uncertainty | Blocks | Resolution path |
|---|---|---|---|
| U1 | Whether TCGdex has any arrangement with Cardmarket or TCGplayer for relaying price data | Nothing at private scale; would matter before public release | Ask maintainers; re-read terms if published |
| U2 | Whether Cardmarket's public Product Catalogue covers Pokémon sealed products, and its terms | Sealed valuation improvement (V1) | One authenticated inspection |
| U3 | TCGdex rate limits in practice | Ingest batch sizing | Observe our own ingest logs; start conservative |
| U4 | TCGdex price update cadence | Snapshot scheduling | Compare `updated` timestamps across our own daily runs |
| U5 | Real-device iOS behaviour of the installed PWA | PWA polish (V1) | Test on hardware |
| U6 | Whether manual sealed and graded valuation is tolerable in daily use | Whether a paid source becomes worth its cost | Reassess after real use |
