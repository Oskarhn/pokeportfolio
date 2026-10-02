# External Data Sources and Services

One entry per candidate. Status is one of **Selected**, **Fallback**, **Rejected**, **Evaluating**.

No API keys, tokens or credentials appear in this file, ever.

---

## TCGdex — card catalog, images, raw market prices

**Status: Selected** (catalog, images, raw card pricing)

| | |
|---|---|
| Docs | https://tcgdex.dev · https://tcgdex.dev/faq |
| Database source | https://github.com/tcgdex/cards-database — MIT, ~1 000 stars, active |
| Base URL | `https://api.tcgdex.net/v2/{lang}/...` |
| Authentication | **None.** No API key. |
| Cost | Free |
| Rate limits | None published. FAQ: *"There are no published hard rate limits, but please be considerate."* |
| Verified | 2026-08-16, re-verified 2026-08-20 for M5 (ingest), by direct request from the development machine |

### Coverage verified by live request (2026-08-20)

| Probe | Result |
|---|---|
| `/v2/en/sets` | 218 sets (unchanged since 2026-08-16) |
| `/v2/ja/sets` | 177 sets, native Japanese names |
| `/v2/en/cards` | 23 444 cards (lite list: `id`, `localId`, `name`, `image?`) |
| `/v2/ja/cards` | 8 159 cards |
| `/v2/en/cards/{id}`, `/v2/ja/cards/{id}` | Full card with `variants_detailed[]` including pricing |
| `/v2/en/sets/{id}` | Full set detail: `serie{id,name}`, `cardCount{official,total,firstEd,holo,normal,reverse}`, lite `cards[]` |
| `/v2/en/series`, `/v2/en/series/{id}` | Series list and detail, `sets[]` |
| GraphQL, `/v2/graphql` | Reachable, but the `cards`/`card` root fields have **no language argument** and the docs page (`tcgdex.dev/graphql`) states documentation is in progress — **rejected for M5** in favour of REST, which is fully documented and where language scoping is unambiguous (per-path, `/v2/{lang}/...`) |
| Bulk/database dump | None found. `github.com/tcgdex/cards-database` is per-card JSON files meant to be consumed via the API/SDKs, not a bulk export — REST per-set is the practical ingest path |
| **Identifier collision across languages** | `/v2/en/sets` and `/v2/ja/sets` both contain a set id `neo1`; both series lists contain a series id `neo`. **Provider ids are not globally unique — they are unique only within a language.** Drove D-034. |
| Image CDN | `https://assets.tcgdex.net/{lang}/{series}/{set}/{localId}/{quality}.{ext}`, `quality` ∈ `low` (245×337) / `high` (600×825), `ext` ∈ `webp` (recommended, transparent) / `png` / `jpg` (opaque, avoid). `image_base_url` stores the URL up to `{localId}`; the app appends `/{quality}.webp`. |
| **Set assets** (probed 2026-08-24, P27) | Set endpoints return extension-less image identifiers (`.../sets/{id}/logo`, `.../symbol`). The CDN 404s on the bare path; the client must append an extension — `.webp`/`.png` work. Symbols for series-independent marks may live under `/univ/`. `src/data/catalog.ts#setImageUrl` normalizes this: it appends `.webp` to the path segment only, preserving any query string or fragment, and leaves URLs that already carry an extension verbatim. |

### `variants_detailed[]` — real, but not the whole story

Confirmed live (not assumed from an older note): TCGdex does expose a per-variant `variants_detailed[]`
array with `type` (finish: `normal`/`holo`/`reverse`), an optional `subtype` (print-run/era —
`shadowless`, `unlimited`, `1999-2000-copyright`, `no-rarity` all observed), an optional `stamp[]`
array (`1st-edition` observed), `size`, and per-variant `variantId`/`pricing`. Base Set Charizard's
response has a variant that is holo, shadowless *and* first-edition at once — three dimensions on
one row, which is what drove the finish/stamp/subtype schema correction (D-033) rather than reusing
the flat `variant_type` enum M3 shipped.

Two things it does **not** reliably provide, found only by inspecting real payloads:

- `variantId` is sometimes the literal string `"generated"` — TCGdex's own placeholder meaning "no
  real cross-reference to a marketplace product", not a value that identifies anything, and it
  repeats across unrelated cards. The adapter maps it to `NULL`.
- `pricing.cardmarket.idProduct` and `pricing.tcgplayer.<finish>.productId` are not one-per-variant:
  `swsh1-2` (Roselia) has both a `normal` and a `reverse` variant sharing the same TCGplayer
  `productId`. Stored as plain indexed columns, never unique (D-034).

`variants_detailed` is sometimes absent or empty for older/sparsely-catalogued cards; the adapter
falls back to the boolean `variants{firstEdition,holo,normal,reverse,wPromo}` flags so every card
still gets at least one ownable variant row.

### Pokémon TCG Pocket exclusion

TCGdex's `en` catalog includes Pokémon TCG Pocket — a **digital-only** product line, out of scope
for this physical-inventory app (M5 prompt §8). It is its own series, `serie.id === "tcgp"` (15 sets
as of 2026-08-20: `A1`, `A1a`, `A2`, …, `P-A` for promos). The ingest orchestrator filters these
sets out before requesting them, and `sync-catalog` refuses them independently if asked (defense in
depth — the set-detail response's `serie.id` is checked server-side, not trusted from the caller).
No Pocket series was found in the Japanese catalog as of this date.

### Price data shape

Per entry in `variants_detailed[].pricing`:

**`cardmarket`** — `unit: "EUR"`, `idProduct`, `updated`, and price points
`avg`, `low`, `trend`, `avg1`, `avg7`, `avg30`, plus `-holo` suffixed equivalents.

**`tcgplayer`** — `unit: "USD"`, `updated`, and per-finish objects (`normal`,
`reverse-holofoil`, …) with `productId`, `lowPrice`, `midPrice`, `highPrice`,
`marketPrice`, `directLowPrice`.

Observed `updated` timestamp: `2026-08-16T08:03:04Z` — refreshed the same morning. Cadence
appears daily; treated as daily and verified by our own ingest logs over time.

### What it does not provide

| Gap | Probe | Consequence |
|---|---|---|
| Price history | `/pricing`, `/prices` → 404 | We build history from our own snapshots |
| Sealed products | `/products` → 404 | Sealed valuation is manual |
| Graded prices | Absent | Graded valuation is manual |
| Condition-specific prices | Absent | No condition adjustment; see FINANCIAL_MODEL §6.1 |

**Reverified for M11 (2026, sealed inventory milestone).** Before building the sealed-product
catalog, re-checked whether a sealed-product endpoint had appeared since the row above was written:
fetched `tcgdex.dev`'s REST reference and `/rest/other-fields` directly. Confirmed unchanged — the
documented resource categories are still exactly cards, sets and series (plus card-level metadata:
rarities, illustrators, energy types, regulation marks); no sealed/booster-box/ETB endpoint exists
anywhere in the current documentation. The one sealed-adjacent mention on the whole site is the TCG
Pocket integration's "check which card is in which Booster" — card-distribution metadata, not a
sealed-product catalog or sealed pricing. M11's architecture (curated + user-created sealed catalog,
manual-only valuation) is unchanged by this reverification.

### Licensing — three separate questions

Conflating these would be a real error, so they are answered separately.

1. **Database content (names, numbers, set structure, rarities).** MIT, per the repository
   licence. Reuse and caching are permitted.

2. **Card artwork served from `assets.tcgdex.net`.** Copyright of The Pokémon Company /
   Nintendo / Creatures / GAME FREAK. An MIT licence on a community-maintained database does
   **not** convey rights over third-party artwork, and TCGdex is not in a position to grant
   them. Our position: hotlink images from the provider CDN, do not copy them into our storage,
   do not redistribute them, keep the application private. This is normal practice for fan
   tools and is low risk at private scale — but it is a considered position, not an established
   permission, and it must be re-examined before any public release.

3. **Cardmarket and TCGplayer price points relayed through TCGdex.** Provenance and terms are
   not documented by TCGdex. Neither marketplace has granted us anything. Our position: cache
   for the user's own portfolio, do not republish as a price feed, do not build a public price
   service. **Unresolved:** whether TCGdex has an arrangement with either marketplace. Recorded
   as an open uncertainty in [RESEARCH.md](RESEARCH.md) rather than assumed either way.

### Catalog ingest strategy (M5)

REST, one Edge Function invocation per `(language, set)` — chosen over GraphQL (undocumented,
no language argument on the list queries) and a bulk dump (none exists). `supabase/functions/
sync-catalog` fetches one set's detail plus every card in it (bounded concurrency, 5 in flight),
upserts series → set → cards → variants on `(language, tcgdex_*_id)` / `(card_id, finish, stamp,
subtype, size)` keys, and writes one `catalog_sync_runs` row per attempt. `scripts/
run-catalog-sync.mjs` drives it set-by-set with a pause and jitter between calls and capped
retries with backoff on transient failure — see DEVELOPMENT.md for the exact command. A set is a
safe unit of work against Supabase's Edge Function wall-clock budget (the largest observed set is
~450 cards; at concurrency 5 that is comfortably under a minute). Idempotent by construction:
re-running a set changes only `last_seen_at`. A card TCGdex stops listing for a set is marked
`is_active = false`, never deleted — DATA_MODEL.md §3.1.

### Failure strategy

Retry with backoff, per-variant error isolation, never write a zero price, last known snapshot
retained and aged (F9). If TCGdex disappears permanently, our accumulated `price_snapshots`
survive intact because internal `uuid` identity is canonical and provider ids are only mapping
columns.

### Risk

Community-run, no SLA, no contract, self-described as actively improving pricing accuracy.
This is the single largest external dependency in the project. Mitigated by the provider
abstraction (ARCHITECTURE §5) and by owning our own price history.

---

## Norges Bank — FX rates

**Status: Selected**

| | |
|---|---|
| Docs | https://www.norges-bank.no/en/topics/statistics/open-data/guide-data-warehouse/ |
| Endpoint | `https://data.norges-bank.no/api/data/EXR/B.{BASE}.NOK.SP` |
| Authentication | None |
| Cost | Free |
| Format | SDMX-JSON or CSV |
| Manual contract check | `node scripts/verify-norges-bank-contract.mjs` — never run in CI (M8 prompt §93); `tests/data/norges-bank.test.ts` is the deterministic regression that does run there |
| Publication | ~16:00 CET, business days only |
| Verified | 2026-08-16 — live request returned EUR/NOK `10.986` (2026-08-13), `10.9325` (2026-08-14). Re-verified 2026-08-24 (M8): identical values for the same dates, requested with `format=sdmx-json&startPeriod=2026-08-10&endPeriod=2026-08-14&locale=en`. Confirmed from the real response structure — not assumed — that `BASE_CUR` is the first currency in the pair, and that a date with no trading (weekend/holiday) simply has no observation in the series rather than a null value; the fixed captured payload and this reasoning are pinned as a regression test in `tests/data/norges-bank.test.ts`. |
| UNIT_MULT (P130-02 / P134) | Re-verified live 2026-09-14: the returned number is **not** always NOK per one unit of `BASE_CUR` — it is NOK per `10^UNIT_MULT` units. Confirmed by fetching `B.EUR.NOK.SP`, `B.USD.NOK.SP` and `B.JPY.NOK.SP` directly: EUR and USD both carry the series-level attribute `UNIT_MULT: 0` ("Units" — the printed value already is NOK per 1 unit), while **JPY carries `UNIT_MULT: 2` ("Hundreds")** — a printed `6.0375` means NOK per **100** JPY, i.e. `0.060375` NOK per 1 JPY. `supabase/functions/_shared/norges-bank.ts` resolves `UNIT_MULT` from `structure.attributes.series` (by attribute `id`, not by array position) and divides every observation by `10^UNIT_MULT` before returning it, so every caller and `fx_rates.rate` always hold the canonical per-unit `fx_rate_to_nok` shape (FINANCIAL_MODEL.md §7) regardless of which currency Norges Bank happens to rescale. See `tests/data/norges-bank.test.ts` for the EUR/USD/JPY fixtures and the generic-multiplier/malformed/missing-metadata regression tests. |

Official central-bank reference rates. Business-day only, so the resolver falls back to the most
recent prior date and records which date was used. Manual per-purchase override supported
because a card statement's effective rate differs from the reference rate.

Ingested daily for EUR, USD → NOK (on demand for any other supported currency, incl. JPY and GBP,
via `fetch-fx-rate` when a purchase/sale actually uses it — `ingest-fx`'s scheduled currency list
is narrower than this sentence previously implied; not changed by P134, noted here only because it
was found stale while re-verifying this section).

---

## Cardmarket — direct API

**Status: Rejected** (unavailable)

| | |
|---|---|
| Help page | https://help.cardmarket.com/en/cardmarket-api |
| API docs | https://api.cardmarket.com/ws/documentation |
| Verified | 2026-08-16 |

Official text: *"Currently, we are not accepting applications for access to the Cardmarket API"*.
Credentials may not be shared with third-party software.

No direct access is obtainable. Cardmarket price points reach us only indirectly via TCGdex.

---

## Cardmarket — downloadable Price Guide and Product Catalogue

**Status: Evaluating — blocked on authenticated access**

| | |
|---|---|
| Announcement | https://news.cardmarket.com/en/Pokemon/were-making-the-price-guide-and-product-catalogue-available-for-download |
| Download page | `https://www.cardmarket.com/Data/Download` |
| Verified | 2026-08-16 — unauthenticated request returns HTTP 403 |

Cardmarket has made the Price Guide and Product Catalogue downloadable to all users, not only
API holders. Price guide updates daily; catalogue updates on new releases. A Pokémon-specific
version of the announcement exists.

**Why this matters:** if the Product Catalogue includes sealed products, it is the only
identified first-party route to European sealed pricing in EUR, which would close the largest
data gap in the project.

**Unknown, and not determinable without an authenticated session:**

- Whether Pokémon appears in the download list
- Whether sealed products are represented
- File format and schema
- Terms attached to reuse, caching and redistribution

**Position:** does not block MVP, because sealed valuation is manual by design until a
legitimate source is confirmed. Revisit when sealed valuation improvement is scheduled (V1),
at which point one authenticated inspection answers all four questions at once.

---

## TCGplayer — direct API

**Status: Rejected** (unavailable)

Public developer applications closed since approximately late 2024; access limited to existing
partners and large sellers, with reports of existing keys being deprecated. Verified 2026-08-16.
TCGplayer prices reach us only indirectly via TCGdex, as a secondary USD reference.

---

## TCGCSV — TCGplayer catalog mirror

**Status: Fallback, not currently used**

| | |
|---|---|
| Site | https://tcgcsv.com/ |
| Cost | Free |
| Update | Daily, ~20:00 UTC |
| Coverage | TCGplayer categories, groups, products — **including sealed products** — and prices. No SKU-level (condition) pricing. |

The only identified free source of sealed-product pricing. USD, US market, which does not
represent Norwegian or European sealed prices well — European ETB and box prices diverge
substantially from US ones.

Terms of use are not documented on the site, and it mirrors an API we have no rights to.
Not adopted. If used later, it would appear only as an explicitly labelled secondary reference,
never as `CMV` input.

---

## PriceCharting

**Status: Rejected for now — cost**

| | |
|---|---|
| Docs | https://www.pricecharting.com/api-documentation |
| Cost | API requires the "Legendary" subscription, ~$6/month or ~$59/year |
| Coverage | Raw, sealed, and all major grades (PSA, BGS, CGC, SGC, TAG, ACE); some history |

Would close both the sealed and graded gaps in one purchase, and is genuinely inexpensive.
Rejected for MVP because the stated target is zero recurring cost and because it is a US market
in USD. The provider abstraction makes adoption a contained change if the manual-valuation
workflow proves too tedious in practice. Terms of service could not be retrieved
programmatically (HTTP 403) and must be read before any adoption.

---

## PSA — certification and population data

**Status: Rejected** (effectively unavailable)

The public API was reduced to roughly one call per day for anonymous and free registered tokens
in mid-2026. Certification and specification lookups now require a paid plan. There is no public
API for population reports or price data.

Consequence: no automated PSA cert verification and no graded pricing. Graded holdings use
manual valuation, and a raw price is never substituted (F10). Cert numbers are stored as
user-entered text.

---

## Graded price sources — status and integration plan (P153, verified 2026-09-20)

**Status: NO authorized source exists. Price Check's graded section reports "not available".**

Re-checked against the official pages on 2026-09-20 (no scraping, no authenticated access):

| Source | Finding | URL |
|---|---|---|
| TCGdex | The FAQ does not mention graded prices. It says pricing is "matched to Cardmarket and TCGPlayer listings" without saying whether a figure is a sale or a listing, and publishes "no published hard rate limits" (be considerate; cache instead of refetching). | https://tcgdex.dev/faq |
| PSA public API | Offers only Cert Verification by cert number. No prices, no population data. | https://www.psacard.com/publicapi/documentation |
| PriceCharting API | Returns graded prices per company (PSA, BGS, CGC, SGC and others) and grade, but requires a paid subscription and is limited to 1 call per second. Rejected for cost above; adopting it needs the owner's explicit approval under COST_POLICY §1a. | https://www.pricecharting.com/api-documentation |

**Consequences implemented in P153.**

- Raw prices come only from the TCGdex relay (Cardmarket EUR, TCGplayer USD). Every relayed
  metric is labelled an **index** — a provider-computed statistic — never "sold" or "listing",
  because TCGdex documents neither. No per-condition breakdown exists, so "condition not
  specified by source" is shown instead of an invented NM/LP.
- Graded prices are modelled (company + grade + qualifier + price kind + currency + observed date)
  and validated (`src/domain/price-check/graded.ts`), but no source is wired, so no graded number
  is ever shown. A graded price is never derived from a raw price and one company's grade is
  never treated as another's.

**Integration plan if a graded source is later approved.** (1) An owner-approved provider whose
terms allow display and caching. (2) A server-side adapter (an Edge Function; the provider token
never reaches the client) returning `{ company, grade, qualifier?, kind, currency, valueMinor,
observedAt }` rows — `kind` mandatory (`sold`, `listing` or `index`); a row without it is
dropped, not defaulted. (3) Register it in the graded-source list consulted by the result page
and add its own rate-limit handling (PriceCharting: 1 call/second). (4) Real fixtures captured
from the provider replace the synthetic ones, and this section changes from "none" to the
provider's verified terms. Until then graded data is `PARTIAL`, not `WORKING`.

---

## `search-prices` response contract and deployment order (P153, checked in P161)

The Edge Function gained ONE additive field: each result row carries `observations[]` (every provider
value the exact variant has, exact integer minor units as decimal strings, provider timestamps). The
headline fields are unchanged.

| Client | Function | Result |
|---|---|---|
| old | new | The old consumer (`src/data/pricing.ts`) reads named fields and ignores the new one. |
| new | old | Price Check uses the single headline value, marks the section "partial" and says so. A missing price stays "no price". |

Deploy order: **(1) the function, (2) the frontend.** Rollback: redeploy the previous function version;
the deployed frontend degrades as above. Neither step needs a migration. Not done in P161 (no hosted
change); the hosted project is the Production project, so deploying is an owner action after a green
release gate. Graded prices remain `PARTIAL_NO_AUTHORIZED_PROVIDER`: no authorized source exists (see
"Graded price sources" above); nothing derives a graded price from a raw one.

### Release order for the integrated candidate (P164)

Edge Functions that differ from the released base (`d8682e0`) in this candidate — every one is a separate hosted deploy, and a Cloudflare
frontend deploy does not update any of them:

| Function | Changed by | Why it matters |
|---|---|---|
| `search-prices` | P161 (`index.ts` +8, new `_shared/price-observations.ts`) and P149 (`_shared/tcgdex.ts`) | additive `observations[]`; an absurd provider price is absent instead of `Number()`-rounded |
| `ingest-prices` | P149 (`_shared/tcgdex.ts`) | the same rule for `price_snapshots.value_minor` |
| `sync-catalog` | bundles `tcgdex.ts`, calls none of the changed pricing code | no redeploy required (harmless if redeployed) |
| `fetch-fx-rate`, `ingest-fx`, `redeem-invitation` | unchanged | — |

Order: (1) fresh backup, then P149's two migrations (hosted 104 → 106); (2) deploy `search-prices` and `ingest-prices`; (3) the frontend.
The functions do not depend on the migrations and the migrations do not depend on the functions; the frontend needs both. Skew, tested in
`tests/data/p164-search-prices-skew.test.ts`: released client + new function reads the same headline (extra field ignored); new client + released
function shows the single headline value, marked partial; a function that still emits an unsafe JSON number is refused by the new client (whole
response) and produces no price in the existing pricing consumer. Rollback of a function: redeploy the previous version. Nothing is deployed by
these sessions.

### Independent check of the function half (P165)

Which shared modules each function bundles (import graph, multi-line imports included): `search-prices` → `tcgdex.ts`, `service-key.ts`,
`price-observations.ts`; `ingest-prices` → `tcgdex.ts`, `service-key.ts`; `sync-catalog` → `tcgdex.ts` (only `fetchCardDetail`, `fetchSetDetail`,
`isPocketSeries`, `TcgdexNotFoundError`; none reaches the changed `asFiniteNumber`), `service-key.ts`; `fetch-fx-rate` and `ingest-fx` →
`norges-bank.ts`, `service-key.ts`; `redeem-invitation` → `service-key.ts`. So exactly `search-prices` and `ingest-prices` need a deploy.

The real `search-prices` code was run under Deno (`scripts/p165/edge-harness`, `tests/data/p165-search-prices-real-function.test.ts`) with the provider's
answer controlled — **not** against the live provider and **not** against a deployed function:

- The candidate can never emit an unsafe number itself: `asFiniteNumber` drops a provider price whose minor units exceed 2^53 − 1 *before* it becomes a
  `bigint`, so `Number(valueMinor)` is exact and every `observations[].valueMinor` is a decimal string. The rewrite marker (D-164) therefore defends
  against the **released** function, not the new one.
- The released function (d8682e0), given a provider value of 99999999999999.99 EUR, answers `"sourceValueMinor":9999999999999998` (already rounded) and a
  `valueNokMinor` string computed from that rounded number. The guard flags the bare number, the marker refuses the whole response, so the string next to
  it is never shown either. Frozen in the test as the old-function/new-frontend half.
- When the preferred provider's price is dropped, the headline falls back to the other provider under the existing D-052 rule (a USD TCGplayer value
  can become the headline of a variant whose Cardmarket price is absurd); `observations[]` shows only what exists.
- Consumer dependency worth knowing: both consumers read the marker from `invoked.response`, which `@supabase/functions-js` 2.112.3 returns. A dependency
  upgrade that drops `response` would make both consumers fail open; the frozen-wire tests fail in that case.
- Behaviour when a number that is not a price is unsafe: any unsafe integer literal anywhere in the response refuses the whole response (fail-closed); a
  large but safe integer does not; an exponent-form number (`1.5e+21`) is not an integer literal to the guard, and no consumer accepts it as a price.

## Scrydex

**Status: Rejected for now — cost**

Commercial successor to pokemontcg.io by the same team. From ~$29/month for 5 000 credits.
Adds graded prices and population reports. Priced for commercial use; disproportionate for a
ten-user private app.

---

## pokemontcg.io

**Status: Rejected — unreliable**

Two live probes on 2026-08-16 (`/v2/cards`, `/v2/sets`) both returned **HTTP 500**. The team
has publicly shifted focus to Scrydex. Not a viable foundation.

---

## Supabase

**Status: Selected** — database, auth, storage, edge functions, scheduling

| | |
|---|---|
| Docs | https://supabase.com/docs |
| Region | `eu-north-1` (Stockholm) planned; the dev project actually runs in `eu-west-3` (Paris) — still EU, see HANDOVER.md |
| Plan | Free |
| Free limits | 500 MB database, 1 GB storage, 5 GB egress, 50 000 MAU, 500 000 edge invocations, 2 active projects |
| Pausing | Free projects pause after ~7 days without database activity; manual resume; restorable within 90 days |
| Backups | **None on Free.** Supabase recommends regular `supabase db dump`. Pro ($25/mo) adds 7 days of daily backups. |
| Scheduling | `pg_cron` on all plans including Free; `pg_net` for HTTP from SQL |
| Auth: email + password | Stable. Built-in email limited to 2/hour project-wide, so login must not depend on it. |
| Auth: passkeys | Experimental, requires `auth.experimental.passkey: true` |
| Verified | 2026-08-16 |

First paid tier if outgrown: Pro, $25/month, adding 8 GB database, backups, and no pausing.
Escape path documented in ARCHITECTURE §3.

---

## Cloudflare Pages

**Status: Selected** — static hosting

Free plan: unlimited bandwidth, 500 builds/month, commercial use permitted, no egress charges.
Chosen over Vercel Hobby, whose free tier is restricted to non-commercial use.

---

## Attribution obligations

To be honoured in the application footer and README once the UI exists:

- Card data and images: TCGdex (MIT database) and, ultimately, The Pokémon Company International.
- Price data: Cardmarket and TCGplayer, relayed via TCGdex.
- Exchange rates: Norges Bank.
- The application is unofficial and unaffiliated with The Pokémon Company, Nintendo, Creatures
  or GAME FREAK. No official logos or brand assets are used as application branding.

---

## Tesseract.js — on-device OCR library (NOT an external service)

**Status: Selected** (M15 scanner, D-094) — recorded here because it is the scanner's entire
recognition "provider", and the entry documents why NO new external runtime service exists.

| | |
|---|---|
| What | Apache-2.0 WASM port of Tesseract (LSTM-only OEM), pinned 	esseract.js 7.0.0 / 	esseract.js-core 7.0.0 / @tesseract.js-data/eng 1.0.0 (MIT for the data package wrapper; upstream traineddata per tessdata licensing) |
| Runs where | In the user's browser, inside a same-origin Web Worker; assets staged from the pinned npm packages into /scanner-assets/v7/ at build time |
| Network behaviour | **Zero runtime calls to any third party.** No CDN, no API host, no keys. The only scanner network traffic is same-origin asset GETs, textual Supabase catalog queries and ordinary catalog thumbnail GETs |
| Cost |  recurring; static bytes served free by Cloudflare Pages |
| Verification | Real smoke executed on the development machine 2026-08-26 (synthetic card fixture read at confidence 93); see docs/SCANNER_RESEARCH.md §7 |

Deployment dependency: WASM compilation requires the 'wasm-unsafe-eval' CSP exception —
pending P69 security PR.

---

## Hugging Face — BUILD-TIME model weight source only (NOT a runtime service)

**Status: Selected** (M15b scanner, D-097) — recorded for the same reason as Tesseract.js above:
Hugging Face is where the pinned model FILES are fetched from once, at build/prepare time, into
this repository's own build output. The deployed application makes **zero runtime requests** to
Hugging Face, or to any other model host — this is the entire point of D-097's same-origin
staging design (verified directly against a real `dist/` build; see docs/SCANNER_RESEARCH.md §7b).

| | |
|---|---|
| What | `Xenova/dinov2-small` (an ONNX conversion of `facebook/dinov2-small`), pinned to revision `c2bb04a51fab207c420665f1946016107bffc701` — never `main`/`latest` |
| License | Apache-2.0 (`facebook/dinov2-small`'s Hugging Face model card: `"license":"apache-2.0"`) — permits commercial use, modification, redistribution |
| Fetched by | `scripts/prepare-scanner-visual-assets.mjs`, part of `prebuild` — downloads the 3 pinned files (config, preprocessor config, quantized ONNX weights) once, verifies each against a recorded SHA-256, caches locally, and stages same-origin copies into `public/scanner-assets/visual-v1/model/` |
| Runtime behaviour | **Zero runtime calls to Hugging Face.** The browser's visual-recognition worker sets `env.allowRemoteModels = false` and `env.localModelPath` to the same-origin staged directory before any model load |
| Cost | $0 recurring; static bytes served free by Cloudflare Pages, same as every other scanner asset |
| Verified | Hash pinned and staging tested on the development machine 2026-08-26; see D-097 and docs/SCANNER_RESEARCH.md §7b |

`onnxruntime-web`'s own WASM runtime binaries are staged same-origin the same way (from the
installed npm package, not a separate download) — its bundled default otherwise points at
`cdn.jsdelivr.net`, confirmed by reading the actual library source, and is overridden explicitly
before first use.
