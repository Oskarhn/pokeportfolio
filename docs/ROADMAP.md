# Roadmap

Ordered by dependency, not by time. No date estimates.

Status: **Done** · **In progress** · **Planned** · **Deferred**

Scope is frozen — see [PLANNING_FREEZE.md](PLANNING_FREEZE.md). Milestones may be resequenced on
dependency grounds; scope may not be widened without reopening the freeze.

---

## Phase 0 — Discovery · Done

Product definition, competitor review, feasibility research.

## Phase 1 — Foundation · Done

Canonical documentation, financial model, data model, architecture, security model, test
strategy, zero-cost policy, toolchain, private GitHub repository. No application code.

---

## Implementation milestones

Each milestone is a reviewable unit ending in a working, tested increment. **Not one enormous MVP
branch.** A milestone is complete only when its gate passes; the gate is behaviour, never
compilation.

### M1 — Scaffold and harness · **complete**

Vite + React 19 + TypeScript strict. pnpm pinned via Corepack. ESLint, Prettier, Vitest,
fast-check, Playwright. `pnpm check` as the single gate command. GitHub Actions: install →
typecheck → lint → test → build → secret scan.

**Gate:** `pnpm check` green on an empty app; CI green on a pull request.

### M2 — Domain and money · **complete**

`Money` type (integer minor units + ISO 4217), currency table with per-currency minor-unit
exponents, largest-remainder allocator, FX conversion helpers. Pure TypeScript, zero
dependencies on React or Supabase.

**Gate:** allocator property tests pass (F6); worked examples E1, E3 and E7 reproduce exactly in
memory; a deliberately broken allocation fails the suite.

### M3 — Database, RLS and migration tooling · **complete**

Supabase project (`eu-north-1`, free plan). Migration tooling. Schema for catalog, profiles,
invitations, holdings, lots, purchases. RLS on every table with `WITH CHECK`. Denormalised
`user_id` with parent-match triggers. Generated TypeScript types.

**Gate:** migrations apply to an empty and a seeded database; the two-client authorization
fixture exists and a deliberately failing isolation test actually fails.

### M4 — Auth and invitations — **complete**

Email + password. Two independent server-side gates close account creation: the Before User Created
auth hook, which rejects every self-service signup path GoTrue exposes, and a `BEFORE INSERT`
trigger on `auth.users` demanding a live invitation claim (invariant S2). `redeem-invitation` is
the sole account-creation path; invitation issue and revocation are admin-gated Postgres RPCs.
Password reset via the low-volume built-in email, with a documented admin-assisted fallback.

**Gate:** met. Direct public signup is rejected, including for an address that holds a valid
outstanding invitation and including hand-built requests carrying forged metadata; replay, expiry,
revocation and concurrent redemption are all rejected; the full authorization suite passes.

### M4.1 — Privilege convergence, deployment and real end-to-end — **complete**

Not a feature milestone. A checkpoint that exists because M4's privilege fix was verified only
against databases that had never been wrong, and because nothing had ever run the product from a
browser against a real deployment.

Privilege grants now converge from a hostile starting state rather than only from an empty one:
routines swept instead of enumerated, default privileges revoked, `UPDATE` granted column by column
on every user-owned table, and the whole surface asserted against the catalog by
`scripts/grant-audit.sql` — in CI and, unchanged, in the Supabase SQL editor against a deployed
project. CI reproduces the original bug's environment before proving the migration climbs out of
it. The GoTrue Admin-API assumption was re-verified against current upstream source, the deferred
claim foreign key tested from both sides, and SHA-256 for invitation tokens re-examined and kept.

The application is deployed to Cloudflare Pages on the Free plan, built from `main`, with security
headers generated from the Supabase URL the bundle was built against.

**Gate:** met. The deployment gate in SECURITY.md §13 passes against the development project, the
invite → account → sign-in → protected route → sign-out path was exercised in a real browser against
the deployed app, and the installed-PWA check on real hardware — outstanding since M4 — is done.
See HANDOVER for the exact state.

### M5 — Catalog and search · **complete**

TCGdex ingest for sets, cards and variants, English and Japanese. Provider id mapping. Card
search by name, set and collector number. Verify Basic Energy coverage and variant modelling
during ingest — this is a known unknown.

**Gate:** search is fast on mobile across the full catalog; energies are findable and selectable
as ordinary cards.

### M6 — Collection: holdings, lots, origin — **complete**

Manual-card fallback for the catalog's real gaps (D-037). Acquisition origin and
`cost_basis_state`, including `opening`/`trade_in` pulled forward from M16/M18 (D-038). Quantity
grouping with lot detail via the atomic `add_card_acquisition` RPC. Condition, storage location
(relocated to the lot, D-036), tags, favourites. Graded cards as a collection type with manual
value (`manual_valuations`, pulled forward from M11).

**Gate:** met. Three copies at three prices become three lots under one holding (verified in CI
and against the real deployed project); a gift/pull shows no cost field and no zero; energies
(bulk quantity 12, real ingested catalog) and manual catalog-missing cards can be added; raw and
graded never merge. `/collection`, `/collection/$holdingId`, `/add`, `/collection/manual/new`
deployed and browser-verified. See HANDOVER.md and `claude_outputs/output_10.txt` for full detail,
including the M5 key-exposure follow-up (D-039) closed out in the same milestone.

### M7 — Organisation and display · **complete**

Custom collections (many-to-many, shipped exactly as DATA_MODEL.md §5.2.1 specified). Smart
filters: low-value threshold, missing price (operating on a graded holding's real manual
valuation pre-M9 — DECISIONS.md D-041). Grid density 1–4 with 2 as default (mobile) / 4
(desktop), persisted per user via `profiles.collection_grid_density`. List and table views,
table also available on mobile. Keyset pagination and TanStack Virtual client virtualisation
(`list_portfolio`, SECURITY.md §3.2.1). Mobile bottom navigation (Home/Search/Portfolio/More/
Profile + central quick-add) and an equivalent desktop top nav — the frozen UX plan M6 deferred.
User-facing rename `/collection` → `/portfolio` (D-040), with redirects. Per-card-result quick-add
in Search, plus first-class set browsing. Home, Profile and More destinations built with only
truthful, currently-available data.

**Gate:** met. `tests/db/m7_constraints.test.ts` and `tests/authorization/m7_portfolio.test.ts`
cover C1, cross-tenant collection/membership attacks, and `list_portfolio`/`portfolio_counts`
isolation, sort, filter and keyset-pagination correctness — green in CI. Density/view/sort
persist to the profile. The 10 000-lot performance gate was measured for real against
`pokeportfolio-dev` (7,500 holdings, 10,109 lots on an isolated, deleted-after synthetic account):
the first implementation measured 5.5-8 s per call with two sort modes timing out outright, fixed
by replacing a per-holding `LATERAL` aggregate with the same `LEFT JOIN ... GROUP BY` shape
`holding_summaries` already used, re-measured at 130-570 ms across every sort mode and keyset page
(DECISIONS.md, PROJECT_JOURNAL.md 2026-08-22). `scripts/portfolio-perf-benchmark.mjs` is the
repeatable version of the same measurement for a future session with local Docker. The
PUBLIC-EXECUTE privilege blind spot flagged as a known limitation after M6 is closed (D-042).
Merged and deployed to `pokeportfolio-dev.pages.dev`, then browser-verified end to end; that
verification found and fixed one further defect (the CSP's `img-src` silently blocking all card
artwork, PROJECT_JOURNAL.md 2026-08-22, PR #15). Only the owner's real-iPhone check remains.

### M7.1 — Owner UI/UX refinement · **complete**

Not a numbered product milestone — a focused correction pass after the owner reviewed the
deployed M7 UI and gave substantial concrete feedback, applied before M8/M9/M12 build further
screens on top of a structure the owner had already flagged. Full detail: `claude_outputs/output_12.txt`,
DECISIONS.md D-043–D-046.

Primary navigation restructured to four destinations (Home/Search/Portfolio/Profile) plus a
central quick-add, replacing M7's five-tab-plus-spacer geometry; More removed, its one real
function (admin invitations) moved into Profile. Global "PokePortfolio" wordmark removed from
authenticated chrome. Visual baseline reworked from the rejected provisional blue/slate palette to
a neutral warm-graphite surface scale with a restrained bronze/copper accent, dark mode made
actually functional (`data-theme` + a pre-paint bootstrap script), radius bumped app-wide, nav/
sheets lightly translucent — all via a token-remap technique that re-themes the whole existing
Tailwind-utility codebase without a per-component rewrite (DESIGN_SYSTEM.md §3.1).

Home restructured around a portfolio-app hierarchy: scope selector (shared with Portfolio, no
second grouping model), currency preference, a value-privacy eye, a reserved value/chart panel,
and a "most valuable cards" section — every M9/M12-dependent figure honestly unavailable, never
fabricated. Search rebuilt around a dominant top search bar, a real set-browsing carousel, a
favourite filter reusing existing holding state, and image-led card results. Card detail rebuilt
image-first with a clickable set link and a reserved price-history slot. Portfolio gained a
"search in your portfolio" bar, a favourite star, an action menu, select-mode with functional bulk
actions (add/remove-to-collection, favourite — all purely organisational), a real Portfolio CSV
export pulled forward from M13 in the narrow single-user-current-state sense, and a genuine
card-number sort (`number_asc`/`number_desc`, natural-sort ordering over real collector numbers).
Profile rebuilt as the account/settings hub: theme now works, European-pricing preference stored
ahead of M9, default view/density, preferred card language, admin invitations, provider
attribution and a real build-sourced version string.

Deliberately not built, and recorded rather than silently skipped: profile picture upload (needs
SECURITY.md §7's storage safeguards a bare upload would skip, D-046), bulk "Remove from Portfolio"
(needs a real batch-void RPC, D-045), account reset/delete UI, portfolio share links, price
alerts, Trade Analyzer, Market Movers (UX_FLOWS.md F15/F16) — all recorded in BACKLOG.md with
their real dependencies rather than faked.

**Gate:** met. `pnpm check` green; the new `natural_sort_key`/`list_portfolio` number-sort surface
and the two new `profiles` columns have authorization coverage; the privilege baseline was
restated and CI's hostile-grant convergence re-verifies it; a route-level code-splitting pass
brought the initial JS bundle down from M7's ~638 KB to ~320 KB (97.8 KB gzipped, verified by a
real production build) without a new dependency. Deployed and browser-verified; only the owner's
real-device check remains outstanding (same open item M7 already carried forward).

### M8 — Purchases and the spending ledger · **complete**

Multi-line purchases, retailers, shipping, customs, discounts, backdating. Allocation engine
wired into writes. Foreign currency with Norges Bank FX and manual override. Collectible versus
hobby split. Void semantics and guard rules.

**Gate:** E3 and E10 reproduce in the database; `GPO = CS + HS` holds on real data (F1); voiding
a referenced purchase is blocked with an error naming the blocker. **Met** — see
`claude_outputs/output_13.txt` and HANDOVER.md. Deployed and verified: CI green (85 domain/property
tests, 320 database/authorization tests including the hostile-grant convergence proof), migrations
applied to `pokeportfolio-dev`, `grant-audit.sql` clean, `remote-security-check.mjs` 17/17 (phase
1), `deployment-check.mjs` 28/28 against the real rebuilt bundle. Owner-side signed-in verification
still outstanding — this session cannot create or sign in with a synthetic account (see HANDOVER.md).

### M8.1 — Portfolio correction / Purchase discoverability · **complete**

Not a numbered product milestone — a focused correction pass after the owner tested the deployed
M8 build and found Portfolio's select mode had no way to remove an accidentally-added card, and
did not discover how to record a Purchase despite M8 shipping the ledger. Full detail:
`claude_outputs/output_14.txt`, DECISIONS.md D-051.

**Gate:** the audit required before building bulk removal found and fixed a real defect —
`void_acquisition_lot`'s parent-purchase auto-void rule counted only other live lots, so a
card+accessory purchase had its accessory spend silently voided as a side effect of correcting the
card. Corrected to count lines, not lots; `remove_holdings_from_portfolio(uuid[])` ships as the
atomic, all-or-nothing bulk surface. **Met** — 336 database/authorization tests (up from 320),
CI green, deployed and verified (`grant-audit.sql` clean, `remote-security-check.mjs` 17/17,
`deployment-check.mjs` 28/28).

### M9 — Pricing and snapshots — **complete**

`price_snapshots`, `watched_card_variants`, retention thinning (`thin_price_snapshots`).
`ingest-prices` and `ingest-fx` Edge Functions on `pg_cron`/`pg_net`, secret held in Supabase
Vault. Valuation resolver (`resolve_variant_market_values`): manual → fresh → stale → missing,
`use_eu_pricing` provider preference (D-052). Wired into Portfolio (`list_portfolio`,
`portfolio_counts`), Home, Holding Detail (full provenance + manual set/clear), Card Detail
(on-demand current price + real snapshot history), and a real Market Movers foundation
(`get_market_movers`). Full detail: `claude_outputs/output_15.txt`.

**Gate:** a simulated provider outage degrades gracefully and nothing reaches zero (F9, F14) —
verified in `tests/db/m9_valuation_resolver.test.ts`; snapshot volume matches the projection
(COST_POLICY.md).

### M9.1 — Pricing closeout — **complete**

Not a new milestone — closes M9 acceptance gaps the output_15 mentor review found before M10
begins (docs/PLANNING_FREEZE.md still governs; nothing here reopens scope). Search result tiles
show batched real prices; Card Detail has an exact selected-variant price/history; Market Movers is
a real dedicated screen (period + sort modes, D-056); display-currency conversion is real and
presentation-only everywhere a resolved value is shown (D-057); `price_snapshots` storage capacity
is measured, not estimated, and retention adjusted if the measurement required it; the 18-month
retention test, the value_desc/value_asc pagination edge matrix, and the real 10,000-lot Portfolio
benchmark (now CI-integrated) all now exist. Full detail: `claude_outputs/output_16.txt`.

**Gate:** every explicit gap `claude_outputs/output_15.txt` disclosed as "not done" is either closed
or, if genuinely out of this session's reach, disclosed again with the same honesty standard —
never silently dropped.

### M9.2 — Portfolio query performance closeout — **complete**

Not a new milestone — closes the one M9.1 gap output_16.txt left open before M10 begins
(docs/PLANNING_FREEZE.md still governs). Root-caused `list_portfolio`'s 10,000-lot unfiltered
first-page regression with real `EXPLAIN (ANALYZE, BUFFERS, SETTINGS)` evidence: stale planner
statistics from the benchmark's own bulk seed, not an application defect — `portfolio_counts()` was
equally affected in the same cold state, disproving the standing theory that `list_portfolio`'s own
query shape was the cause. No application SQL changed; the benchmark now runs `ANALYZE` before
timing and fails CI on a genuine multi-second regression. Full detail: `claude_outputs/output_17.txt`,
DECISIONS.md D-059.

**Gate:** the real 10,000-lot benchmark, seeded with representative planner statistics, shows every
supported sort/filter/keyset path interactive (comfortably under TESTING.md §31's targets) with no
statement timeout — proven in `claude_outputs/output_17.txt`, not just asserted.

### M10 — Sales and History

Sales with explicit lot selection and FIFO suggestion. Frozen `cost_basis_at_sale`. Realized
versus uncosted proceeds. The History area: Sold, Traded, Other.

**Gate:** E2 and E7 reproduce; a sold gift shows proceeds and a result of **—**; sorting by
result does not rank unknown-basis rows as infinite profit.

### M11 — Sealed inventory

Sealed products in the catalog. Sealed holdings with intent. Manual valuation with provenance.
Sealed segment in collection value.

**Gate:** sealed value is visibly manual; a sealed holding with no valuation is counted, not
zeroed.

### M12 — Dashboard

`portfolio_snapshots` with a recompute queue. `lightweight-charts` spike — validate or fall back
to visx before building on it. Value over time, monthly spend, headline figures, data-quality
counts.

**Gate:** full rebuild equals incremental recompute, byte-identical; ownership timeline correct
(TESTING §3); every figure reconciles against the ledger.

### M12a — Visual design refinement

Not scheduled by date — it happens once M6, M7, M8 and M12 give the owner enough real surface
(collection, organisation, purchases, dashboard) to react to actual screens rather than
descriptions. Until this milestone, the UI stays deliberately basic and neutral per
[docs/DESIGN_SYSTEM.md](DESIGN_SYSTEM.md) §0 — building final visual polish earlier would mean
redoing it against references that do not exist yet.

1. Owner supplies reference screenshots/images and, separately, a logo.
2. Analyse the references for layout density, spacing, typography, navigation, component
   appearance, chart treatment, card presentation and colour direction — direction, not
   pixel-for-pixel reproduction of anyone else's proprietary design.
3. Update [docs/DESIGN_SYSTEM.md](DESIGN_SYSTEM.md) with the resulting concrete tokens.
4. Apply the redesign through the existing token system (§0's centralization requirement is what
   makes this step bounded rather than a rewrite).
5. Integrate the owner's logo through the single swap point established in M3/early milestones.
6. Browser-test the result on mobile and desktop viewports.

**Gate:** the app visually matches the agreed direction from the references; no proprietary
design is reproduced pixel-for-pixel; the placeholder PWA icon set is fully replaced.

### M13 — Export and backup

CSV exports. Versioned JSON backup with schema version and export timestamp. In-app export
reminder. Local dump script.

**Gate:** a JSON backup round-trips; amounts parse; the version envelope is present.

### M14 — MVP hardening

E2E suite across desktop and mobile viewports. Real-device iPhone pass. Performance pass at
10 000 lots. Accessibility pass. Documentation reconciled with what was actually built.

**MVP complete.**

---

## Post-MVP

### M15 — Scanner  · V1 priority 1

Ahead of openings, deliberately: all-card tracking makes manual entry the primary usability
bottleneck, and the scanner is what removes it.

1. Re-research the recognition stack. Do not inherit the August 2026 model choices.
2. Validate on real hardware that camera permission survives an in-route session (R9/S6) —
   with a throwaway page, **before** building anything.
3. Offline pipeline: catalog embeddings, index artefact, hosting strategy.
4. Single-route camera session, one `MediaStream`, in-route overlay (D-006).
5. Recognition with candidate list and confidence threshold.
6. Session defaults: origin, opening, condition, language, storage location, custom collection,
   cost handling.
7. Batch review before save; manual search fallback.

**Gate:** measurably faster than manual search against a real stack of cards, verified with a
timed comparison.

### M16 — Openings · V1 priority 2

Full lifecycle. All-cards tracking by default, hits-only option, bulk remainder estimate.
Opening return in kroner first. Provisional-cost reconciliation UI.

**Gate:** E4, E5 and E13 reproduce end to end. No pull shows a zero cost basis or a per-card ROI.
Reconciliation cannot double-count (F12).

### M17 — Grading workflow

Submissions, state transitions, `lot_transfers`, cost attribution, `raw_value_at_submission`
captured, profitability analysis.

**Gate:** E6 reproduces. A graded card is never valued from a raw price (F10).

### M18 — Trades

Item-leg accounting rule decided and documented **first**. Then the workflow over the existing
schema.

**Gate:** E14 reproduces. No fabricated P/L (F13).

### M19 — V1 completion

Desktop bulk operations, richer statistics, images and receipts, CSV import, restore from
backup, PWA polish, Android verification.

---

## Deferred

Wishlist and target prices · set completion · price alerts · opt-in read-only share links · push
notifications · receipt OCR · native iOS and Android clients · configurable condition
multipliers · cross-language card equivalence · paid pricing sources.

Not being built. The data model preserves the cheap ones. See [BACKLOG.md](BACKLOG.md).

---

## Ordering rationale

**Domain before database.** The financial engine is pure functions with no infrastructure
dependency, so it can be correct and tested before any schema exists. Getting it right first
means the schema serves a proven model rather than the reverse.

**Auth and RLS early.** Isolation is not a feature that can be added later to a system that grew
without it. The two-client fixture exists from M3 so every subsequent table inherits the test.

**Collection before purchases.** Purchases create holdings, so the target has to exist first.

**Money before value.** The ledger is the product's distinguishing feature and the least
dependent on unreliable external data.

**Value before dashboard.** Charts need something honest to plot.

**Scanner before openings.** Reversed from the earlier plan. Tracking every physical card makes
manual entry the dominant cost of using the app, so the scanner delivers more value per unit of
work than openings do — even though openings are conceptually closer to the product's core.
Openings remain fully modelled in the schema throughout, and historical openings can be
backdated once M16 lands.
