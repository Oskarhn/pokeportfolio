# Changelog

Notable changes, newest first. Format loosely follows [Keep a Changelog](https://keepachangelog.com/).

This file records **what changed**. [HANDOVER.md](HANDOVER.md) records **current state**, and
[docs/PROJECT_JOURNAL.md](docs/PROJECT_JOURNAL.md) records **why hard things were done the way
they were**.

---

## [Unreleased]

### Added — 2026-08-27 · M9.1 Pricing closeout

Closes the explicit M9 acceptance gaps found by review before M10 begins. Search result tiles show
batched real prices (honest range/from-price display, no N+1). Card Detail has an exact selected-
variant price/history (fixes the M9 defect where the chart always used the first declared variant).
Market Movers is a real dedicated screen (`/market-movers`, 1D/7D/30D periods, four sort modes,
ranked by per-unit % change never quantity-weighted kroner — D-056). Display currency is a real,
presentation-only NOK↔EUR/USD conversion everywhere a resolved value is shown (D-057).

`price_snapshots` storage capacity is measured against a representative synthetic dataset (245.30
bytes/row, not the earlier estimate) and retention shortened from 12 months daily to 60 days daily
+ weekly beyond — the previous policy projected to exceed the entire free-tier database budget at
documented realistic scale (D-058). The 18-month retention test, the value_desc/value_asc
pagination edge matrix, and the real 10,000-lot Portfolio benchmark are now permanent CI steps
(previously disclosed as "not measured" since M7).

Two real bugs found and fixed before merge: a stale privilege-baseline/grant-audit entry for
`get_market_movers`'s changed signature, and a `search-prices` bug where `fx_rates.rate` arrives as
a JSON number (not decimal text) over a plain PostgREST `select` — would have made every
`search-prices` call fail silently in production. Full account: `claude_outputs/output_16.txt`.

### Added — 2026-08-26 · M9 Pricing and snapshots

Real raw-card market valuation. `price_snapshots` (shared market data, one already-fallback-chosen
row per provider per variant per day — D-053), `watched_card_variants` (service-only, bounds
snapshotting to ever-owned printings), and a single set-oriented resolver
(`resolve_variant_market_values`) implementing FINANCIAL_MODEL.md §6: manual → fresh → stale →
missing, with `use_eu_pricing` (D-044) finally activated as a real provider preference (D-052).

Variant-safe price mapping (`_shared/tcgdex.ts#fetchCardPricing`) prefers TCGdex's own embedded
per-variant pricing when present and falls back to card-level fields only when unambiguous — an
ambiguous shape resolves to no price rather than a guess, evidenced by real captured payloads
(`tests/data/tcgdex-pricing.test.ts`). `ingest-prices` (bounded, oldest-synced-first batches every
15 minutes) and `ingest-fx` (daily) run on `pg_cron`/`pg_net`, secret held in Supabase Vault;
`thin_price_snapshots` retains 12 months of daily history and weekly beyond that. `search-prices`
answers on-demand, non-persisted current references for Search/Card Detail.

Wired into Portfolio (`list_portfolio`/`portfolio_counts` — value_desc now sorts by real holding
total, D-052), Home (real Portfolio value, priced/unpriced counts, a real Market Movers section),
Holding Detail (full provenance, manual value set/clear via `clear_manual_valuation`), and Card
Detail (on-demand current price per variant, a real price-history chart from actual snapshots
only — never a fabricated point, D-008).

Also fixed in passing (found while rewriting `list_portfolio`'s body regardless): M7.1's number-sort
migration had silently reverted the M7 10,000-lot performance fix back to a per-holding `LATERAL`
aggregate (D-054) — restored to the materialized-CTE shape.

### Added — 2026-08-24 · M8 Purchases and the spending ledger

Multi-line purchase ledger over the existing M3/M6 `purchases`/`purchase_lines` tables:
`create_purchase`, `update_purchase`, `void_purchase`, `purchase_spending_summary` (GPO/CS/HS in
one query). Shipping, customs and discount allocated with a SQL port of the M2 largest-remainder
allocator — proven byte-identical to the TypeScript reference — and the frozen NOK total is itself
allocated the same way rather than rounded per line, keeping `GPO = CS + HS` (F1) exact for a
foreign-currency purchase. Retailers, backdating, card/sealed/manual-card/accessory/grading/
bulk/standalone lines, spend-class default and override, safe edit (quantity/price/spend-class/
charges only — a line set cannot change, D-047), safe void with downstream-blocker detection. Card
and sealed lines always produce a real holding and lot (D-048); `bulk_lot` remains the line for
deferred individual entry.

**Foreign currency.** `fx_rates` (market-data cache, service-role writes only) and a new
`fetch-fx-rate` Edge Function resolving/caching a Norges Bank rate for a (currency, date) pair —
orientation and endpoint re-verified live against the real API this milestone. Manual FX override
supported, written only to the caller's own purchase, never the shared cache. A zero-decimal
currency (JPY) is exercised end to end, proving money never assumes a 2-digit exponent.

**UI.** `/purchases`, `/purchases/new`, `/purchases/$purchaseId`, `/purchases/$purchaseId/edit` —
reachable from the central + menu ("Record purchase") and a new Home "Total spent" shortcut. No
market value or P/L anywhere in this milestone (D-023 untouched; M9 still owns pricing).

**Corrected two pre-existing, previously-unexercised gaps** (PROJECT_JOURNAL.md 2026-08-24):
`retailers.user_id` had no `default auth.uid()` since M3; `purchases.retailer_id` had no
ownership-check trigger at all. Also corrected `void_acquisition_lot`'s (M6) parent-purchase void
scope, which only checked the one purchase line a lot belonged to — safe while every purchase had
exactly one line, wrong once M8 makes multi-line purchases real; a strict generalization, so every
existing purchase's behaviour is unchanged.

### Added — 2026-08-22 · M7 Portfolio: organisation, display and navigation

The Collection screen becomes **Portfolio** (user-facing rename, D-040; `/collection*` routes
redirect) and gains the display/organisation surface the product was missing: grid density 1–4
(mobile default 2, desktop 4), list and table views (table also on mobile, horizontally
scrollable), a visible Sort by control, quick and full filters, and playlist-like custom
collections. Real primary navigation ships for the first time: a mobile bottom bar
(Home/Search/Portfolio/More/Profile, central quick-add) and an equivalent desktop top nav.

**Schema.** `custom_collections`/`custom_collection_members` (DATA_MODEL.md §5.2.1), shipped
exactly as originally specified — plain owner-RLS tables, no RPC layer, invariant C1 enforced by a
plain `on delete cascade`. `profiles.collection_default_sort` (new enum `portfolio_sort_order`,
default `value_desc`) joins the existing density/view preferences.

**Read surface.** `list_portfolio(...)` and `portfolio_counts()` — both `SECURITY INVOKER`,
replacing the M6 client-side full-column count sum — are the Portfolio's entire sort/filter/keyset-
pagination query. "Value" sorting resolves to a graded holding's real manual valuation and nothing
else pre-M9 (D-041): never the acquisition cost standing in for market value, and every raw-card
holding's `NULL` value sorts deterministically by name rather than as zero. Pagination is real
keyset (never `OFFSET`) via an explicit two-bucket cursor.

**Search.** Cards/Sets segmented search; set results carry real metadata (name, language, symbol,
release date, card count) from a plain `card_sets` read, no new RPC. Every card result — in Cards
mode or inside a set — carries an independent quick-add **+** that preselects a card's only variant
or opens its detail page for a real choice among several, reusing the M6 add flow exactly.

**Security.** Closed the PUBLIC-EXECUTE privilege blind spot SECURITY.md §5.9 had documented as a
known gap since M6 (D-042): every routine in `public` is now swept clear of PostgreSQL's implicit
PUBLIC grant, a new default-privilege statement stops a future function from arriving
PUBLIC-executable, and `scripts/grant-audit.sql` gained its own PUBLIC-grant check —
`tests/db/sql/hostile_grants.sql` proves it can fail before proving the baseline fixes it.

**Performance.** TanStack Virtual windows the grid/list/table views. `list_portfolio`/
`portfolio_counts` were measured against a real 7,500-holding/10,109-lot synthetic account on
`pokeportfolio-dev`: the first version (a per-holding `LATERAL` aggregate) took 5.5-8 s per call
with two sort modes timing out; rewritten as a `LEFT JOIN ... GROUP BY` CTE (the shape
`holding_summaries` already used correctly) and re-measured at 130-570 ms across every sort mode
and keyset page. `scripts/portfolio-perf-benchmark.mjs` is the repeatable version of the same
measurement for a future session with local Docker.

**Tests.** `tests/db/m7_constraints.test.ts` (S1 trigger on the two-parent membership table,
invariant C1, and account-deletion cascade for both new M7 tables — found missing on
`custom_collection_members.user_id` by the real benchmark cleanup, fixed with
`20260822120050_m7_custom_collection_members_cascade_fix.sql`). `tests/authorization/m7_portfolio.test.ts`
(custom-collection CRUD and cross-tenant attacks; `list_portfolio` isolation, sort correctness,
filter correctness, keyset-pagination completeness; `portfolio_counts` correctness). Updated
Playwright route-guard coverage for the renamed/new routes and the legacy-redirect behaviour.

See DECISIONS.md D-040 through D-042, HANDOVER.md and `claude_outputs/output_11.txt` for full detail.

### Fixed — 2026-08-22 · Content-Security-Policy blocked M7's card artwork in production

`img-src` had no external host, so every card thumbnail M7 renders (search results, Portfolio grid
tiles) was silently blocked by the deployed CSP — a gap flagged in a `vite.config.ts` comment since
M5 and never revisited once M7 started actually rendering artwork. Found by browser-verifying the
merged M7 build against `pokeportfolio-dev.pages.dev`, since `_headers` only applies on Cloudflare
Pages and CI never exercises it. Fixed by naming `https://assets.tcgdex.net` explicitly in
`img-src` (docs/API_SOURCES.md's documented image CDN host), not by loosening to `https:`. See
PROJECT_JOURNAL.md 2026-08-22.

### Added — 2026-08-21 · M6 Collection: holdings, acquisition lots, origin and cost

The application becomes usable as a personal collection tracker: search a card, add it, record how
it was acquired and (where applicable) what it cost, see it in `/collection`, add another copy
later without losing the first acquisition's provenance, inspect the lots behind a holding.

**Schema.** A holding now has three possible identity sources, not two: `manual_card_id`
alongside `card_variant_id`/`sealed_product_id`, exactly one non-null (D-037) — the honest fallback
for a physical card the shared catalog does not (yet) list, user-private and never written into
the catalog tables. `storage_location_id` moved from `holdings` to `acquisition_lots` (D-036) after
a concrete two-binder scenario proved the original one-per-holding cardinality wrong. `lot_origin`
gained `opening` ("Pulled") and `trade_in`, and `cost_basis_state` gained `unallocated_opening` and
`trade_in`, both pulled forward from their originally-planned M16/M18 arrival without the
`opening_id`/`trade_line_id` linking columns, which still wait for those milestones (D-038).
`manual_valuations` shipped early too, for a directly-owned graded card's manual value, currency
fixed to NOK pending FX (M9). `holding_tags` is the new many-to-many join for M6's tags.

**Read/write surface.** `add_card_acquisition` — a single SECURITY INVOKER RPC that finds-or-creates
the identity-matching holding (race-safe via the real `holdings_identity` unique index) and writes
one acquisition lot, plus a real single-line purchase when the cost is known — is the one atomic
add-to-collection operation; nothing about it can leave an orphaned holding or a lot with no valid
parent. `void_acquisition_lot` is the mistake-correction path (void semantics, never a raw delete;
voids the sole purchase a known-cost lot created too, so a corrected mistake never leaves a ghost
spend in `GPO`/`CS`). `set_manual_valuation` supersedes-then-inserts so a graded holding's value
history stays append-only. `holding_summaries` is a `security_invoker` view giving the Collection
list one query instead of one per row.

**UI.** `/collection` (2-column mobile grid, desktop responsive, empty/loading/error states),
`/collection/$holdingId` (identity, lots, void, favourite, manual value for graded), `/add`
(progressive form: quantity, raw/graded, origin-driven cost disclosure, storage, favourite, notes),
`/collection/manual/new` (the catalog-missing fallback). "Add to collection" now lives on
`/catalog/$cardId`'s variant list; an empty catalog search offers the manual-entry link.

**Security.** Migrated `pokeportfolio-dev` to Supabase's current `sb_publishable_…`/`sb_secret_…`
key pair (D-039), closing out the M5 key-exposure note: the legacy service-role value returned by
`supabase projects api-keys` into a prior session's transcript is deactivated once the new pair is
verified working end to end, without rotating the JWT signing secret (which would have invalidated
every user session for no reason connected to the actual exposure). `VITE_SUPABASE_ANON_KEY`
renamed to `VITE_SUPABASE_PUBLISHABLE_KEY`; both Edge Functions read `SUPABASE_SECRET_KEYS` first,
falling back to the legacy variable only for the local stack. CI's hostile-grant convergence step
no longer hardcodes a baseline migration filename — it selects the lexicographically-latest
`*_privilege_baseline.sql` and fails outright if none exists, closing the fragility SECURITY.md
§5.9 flagged after M5.

**Tests.** `tests/db/m6_constraints.test.ts` (identity XOR, origin/cost-state consistency, S1
ownership triggers for the three new relationships), `tests/authorization/m6_collection.test.ts`
(RPC happy paths — energy, manual card, graded with manual value, pulled, reused holding — and
cross-tenant attacks against the RPC's caller-supplied arguments), `manual_card_definitions` folded
into the generic owned-tables attack matrix, five new Playwright route-guard cases.

See DECISIONS.md D-036 through D-039, HANDOVER.md and `claude_outputs/output_10.txt` for full detail.

### Added — 2026-08-20 · M5 Pokémon catalog, TCGdex ingestion and search

The application exposes real Pokémon TCG product functionality for the first time. TCGdex
re-verified from live requests rather than assumed: REST chosen over GraphQL (undocumented, no
language argument on the list queries) and over a bulk dump (none exists).

Two real schema defects, found by inspecting live TCGdex responses before M6 attaches holdings to
`card_variants`: the variant model (a real card — Base Set Charizard — is holo, shadowless and
first-edition at once, which the M3 `variant_type` enum could not represent; replaced with
independent `finish`/`stamp`/`subtype` columns) and provider-id scoping (TCGdex reuses ids like
`neo1` across English and Japanese; every provider-id uniqueness constraint is now scoped to
`(language, id)`, and `card_series` gained the provider-id column M3 omitted). A third defect —
marketplace product ids are not one-per-variant — dropped uniqueness from `card_variants`'
`cardmarket_product_id`/`tcgplayer_product_id`.

`sync-catalog` (Edge Function) ingests one `(language, set)` per invocation: idempotent upserts,
Pokémon TCG Pocket excluded via `serie.id` (checked server-side), upstream deletions deactivate
rather than destroy identity. Gated by an operator bearer secret rather than a user session.
`scripts/run-catalog-sync.mjs` drives a full sync. The real English and Japanese physical catalog
was ingested into the development Supabase project — counts in HANDOVER.md.

`search_cards` (Postgres function) ranks cards by name/set trigram similarity plus a collector-
number-token heuristic, language-filterable, invoker rights. `/catalog` and `/catalog/$cardId`:
debounced search, language filter, infinite-scroll results, card detail with real variant data, no
"Add to collection" (that is M6). Browser-verified against the real remote catalog, desktop and
mobile.

CI's hostile-grant privilege-convergence test needed its own fix: re-applying only the M4.1 baseline
migration dropped `search_cards`'s grant, since that file's sweep predates the function. A new
pure-privilege migration restates the complete current surface.

### Added — 2026-08-20 · M4.1 privilege convergence, deployment and real end-to-end validation

M4 closed a live privilege escalation. M4.1 answers the question that fix raised: whether the
migrations reach the intended privilege surface from a project that starts out wrong, rather than
only from an empty database. Three gaps said no.

Function grants were revoked from a hand-written list of names, so a function arriving pre-granted
would have survived — swept now, then granted back to exactly four. Default privileges were never
neutralized, and they turned out to be the real mechanism: `pg_default_acl` carries entries granting
`anon` and `authenticated` everything on new objects in `public`, in every environment. The ones
owned by `postgres` are revoked; the ones owned by `supabase_admin` are unreachable, documented, and
harmless because a default privilege attaches only to objects its own role creates. And `UPDATE` was
granted whole-table on every user-owned table except `profiles`, leaving `user_id`, primary keys,
`created_at` and the provenance columns writable by their owner with only RLS standing there — now
granted column by column, with identity and provenance absent.

`scripts/grant-audit.sql` asserts that surface against the catalog as an independent second
statement of intent, and runs unchanged in the Supabase SQL editor against a deployed project — the
check that was missing when CI and the real project disagreed. CI makes the database hostile first,
proves the audit rejects that state, re-applies the baseline and proves it converges.

Also: the deferred `invitation_claims.consumed_user_id` foreign key tested from both sides, claim
expiry recovery, `finalize_invitation_redemption` idempotency, the GoTrue Admin-API assumption
re-verified against current upstream source, and the SHA-256 token decision re-examined and kept.

Deployment: the application is served over HTTPS from Cloudflare Pages on the Free plan, built from
`main`, with a Content-Security-Policy generated from the Supabase URL the bundle was built against
so the two cannot drift.

### Added — 2026-08-20 · M4 invite-only authentication and account security

Account creation is closed. Two independent server-side gates enforce it: a **Before User Created
auth hook** that rejects every self-service signup path GoTrue exposes, and a `BEFORE INSERT`
trigger on `auth.users` requiring a live invitation claim (invariant S2). The hook rejects
unconditionally rather than checking anything, because GoTrue does not invoke it from the Auth Admin
API — verified against the `supabase/auth` source — which means there is no forgeable metadata and
no race window. A hook that merely allowed signup for invited addresses was considered and rejected:
it would have let anyone who knew an invited address set the password first.

Invitations now bind to a single address, store only `sha256(token)`, expire (7 days by default),
are single-use and revocable, and expose no `token_hash` through the Data API even to an admin.
Redemption is a three-step claim/create/finalize flow whose availability is computed from claims
rather than a counter, so an abandoned attempt frees itself in two minutes and no sequence of
failures can burn an invitation permanently; concurrency is handled by a row lock plus a partial
unique index, not by application-level check-then-act. `redeem-invitation` is the only Edge
Function — invitation issue and revocation are admin-gated Postgres RPCs, because generating a token
needs no Deno runtime and no second copy of the secret key.

Application: sign-in, invitation redemption, password recovery, an admin invitation screen, session
handling, and public/protected/admin route classes. Provisional visually, but with the parts that
would be a bug in any visual direction — password-manager `autocomplete` attributes, paste never
blocked, errors announced rather than only coloured, 44px touch targets, and one sign-in error
message so the form does not become an account-enumeration oracle.

Testing: an 18-case invite-only attack suite run against the live API with the publishable key
(uninvited signup, **invited-address signup**, forged `user_metadata`, a hand-built
`/auth/v1/signup` carrying `app_metadata` and `role: service_role`, Auth Admin creation with no
claim, replay, tampering, expiry, revocation, an attacker-supplied address in the redemption body, a
rejected password leaving the invitation usable, and two redemptions racing one token), 22 admin
authorization cases, and 26 browser cases at desktop and iPhone viewports. Both gates were
deliberately disabled on a throwaway branch and CI watched to fail on the named tests before being
reverted. CI now runs the browser suite and asserts the Edge Function is reachable before the auth
tests, so redemption cases cannot pass by being skipped.

Fixed, from an adversarial review of the M3 foundation: account deletion was impossible — eight
`user_id` foreign keys to `auth.users` had no `ON DELETE` action, contradicting SECURITY.md §8
— `token_hash` was admin-readable through the Data API, and functions relied on `PUBLIC`'s
default `EXECUTE`. Password policy is now 12 characters minimum with no composition rules.

Deployed to a free `pokeportfolio-dev` project, and verifying it there found what CI could not:
the project auto-grants the Data API roles broad privileges on new tables and functions, and a
`GRANT` is additive — so M3's column-restricted `profiles` grant restricted nothing, and a
signed-in non-admin could set their own `is_admin` flag while the authorization suite was green.
Every privilege is now restated as revoke-then-grant for tables and functions alike, `anon` holds
no table privileges at all, and `scripts/remote-security-check.mjs` runs the same assertions
against a real deployment with nothing but the publishable key. Final remote run: 33/33, with the
escalation asserted on the stored value rather than the HTTP status.

Cost: $0; no billing enabled anywhere. Detail: `claude_outputs/output_7.txt` (not committed).

### Added — 2026-08-17 · M3 database foundation, migrations and RLS

Real persistent-storage foundation. Supabase project structure (`supabase/`), CLI pinned as a
project devDependency, eight timestamped migrations covering the shared catalog
(`card_series`/`card_sets`/`cards`/`card_variants`/`sealed_products`), profiles, invitations
(schema only — enforcement lands with M4's Edge Function), user-scoped reference data
(`retailers`/`storage_locations`/`tags`), purchases/purchase_lines and holdings/acquisition_lots.
Row Level Security enabled on every table with explicit `WITH CHECK` on every write policy;
`user_id` denormalized onto every child table with an ownership-verifying trigger (invariant S1);
`profiles.is_admin` locked down at the SQL column-privilege level, not just RLS. A two-client
authorization suite (`tests/authorization/`) exercises the real PostgREST API as two distinct
authenticated users, covering every user-private table plus the critical cross-tenant
child-parent attack and the "admin has zero access to other users' private data" property. A
database constraint suite (`tests/db/`) proves the FINANCIAL_MODEL invariants the schema is
supposed to enforce (M1/M2 cost-basis-state consistency, the holdings identity index, purchase
total/line-total arithmetic checks) actually reject bad data. The Postgres `bigint` /
PostgREST JSON-number precision boundary for money columns is documented and proven with a real
round-trip test, not assumed. CI gained a `db-tests` job that runs the full migration and
authorization suite against an ephemeral local Supabase stack on every push and PR — no remote
credentials involved. Existing M1/M2 gates (64 domain tests, Playwright smoke tests, typecheck,
lint, format, build) remain green throughout. Cost: $0; no billing enabled anywhere. Detail:
`claude_outputs/output_6.txt` (not committed).

### Added — 2026-08-17 · M1 foundation and M2 financial domain core

First application code. Vite + React 19 + TypeScript strict scaffold, ESLint/Prettier, Vitest +
fast-check, Playwright, a minimal PWA shell, and GitHub Actions CI with an open-source secret
scan — all zero-cost. Pure-TypeScript financial domain layer: `Money` (integer minor units, no
float), currency metadata, a largest-remainder allocator, FX conversion, `CostBasisState` and
`MarketValue` as discriminated unions, and the inventory/spending/sales/position metrics from
FINANCIAL_MODEL.md. Worked examples E1, E3 and E7 reproduce exactly against the real domain
functions; 64 tests pass, including property tests for the allocator (invariant F6) and
randomised checks for F1, F3 and F5. No database, no auth, no external service yet — M1/M2 are
deliberately infrastructure-independent. Detail: `claude_outputs/output_5.txt` (not committed).

### Changed — 2026-08-17 · Cost policy: $50 USD lifetime discretionary ceiling

Target operating cost stays $0/month; a separate, owner-approved, **lifetime** ceiling of $50 USD
now exists for genuinely excellent one-time options. Not pre-authorized spending — every purchase
still needs individual approval, and nothing may be spent before a free functional baseline
exists. See D-027 and docs/COST_POLICY.md §1.

### Changed — 2026-08-16 · Planning frozen

Scope and product semantics settled; implementation has an authoritative target.

- **Every physical card is individually trackable** — energies, commons, duplicates and unpriced
  cards are first-class inventory. Replaces a proposal to aggregate low-value cards. Organisation
  and filtering, not aggregation, keep large collections navigable.
- **Custom collections, smart value filters and a configurable grid density** added to MVP as the
  organisational answer to a ten-thousand-card collection. Mobile gallery defaults to two columns
  and is user-settable 1–4.
- **Cost basis became a state** — `known` / `unallocated_opening` / `not_paid` / `unknown` /
  `trade_in` — so a gift, a forgotten purchase price and a pack pull are no longer
  indistinguishable `NULL`s.
- **Manually costed openings now create a real provisional purchase**, reconciled and voided when
  the real receipt is entered. Previously such costs were excluded from lifetime spending, which
  made the product's headline metric understate reality.
- **A dedicated History area** for items no longer owned: sold, traded, other disposals. Disposals
  with no cost basis show proceeds and a result of **—**, never a fabricated profit.
- **Trades modelled in the schema**, with the item-leg accounting rule deliberately left open and
  disposal-time cost and market value frozen so either rule remains adoptable.
- **Authentication changed from email OTP to email and password.** The built-in mail provider
  allows two auth emails per hour project-wide, which makes OTP a lockout risk; password login
  sends no email at all.
- **Scanner moved ahead of openings** post-MVP, and **JSON backup moved into MVP**.
- Zero-cost audit re-verified against all-card tracking: price history is keyed per card variant
  rather than per copy, so snapshot volume is decoupled from collection size.

### Added — 2026-08-16 · Project foundation

- Canonical documentation set covering product, financial model, data model, architecture,
  security, testing, development, roadmap, decisions, research, external sources, UX flows,
  design system, scanner research, backlog, publication checklist and engineering journal.
- Financial model with ten worked examples and eleven named invariants, each mapped to a
  planned test.
- Data model covering the full lifecycle from purchase through sealed, opening, grading and
  sale without provenance loss.
- Architecture selected: Vite + React SPA, Supabase (PostgreSQL with RLS), Cloudflare Pages.
- Security model: RLS on every table, invite-only enforced server-side, admin role with no
  access to other users' data.
- Development toolchain: Node 24.19.0 LTS, pnpm, GitHub CLI.
- Repository initialised with secret-prevention configuration.

No application code in this release.
