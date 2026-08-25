# Handover

Current-state document, written for a session that knows nothing from any earlier conversation.
Read this first, update it last. History lives in [CHANGELOG.md](CHANGELOG.md) and
[docs/PROJECT_JOURNAL.md](docs/PROJECT_JOURNAL.md).

**Last updated:** 2026-08-25 — **M13 (Export and versioned backup) is MERGED and
RELEASED: PR #47 squash-merged as `0fa3021b8f7415b4c3b427917845406d36d0d40f` on `main`,
Cloudflare deployed and verified (`deployment-check.mjs` 28/28, `grant-audit.sql` clean,
`remote-security-check.mjs` 17/17 phase 1; no migration exists for M13, so none was
applied).** **P42 (owner recompute-refresh fix) is MERGED and RELEASED on top of it: PR #48
squash-merged as `837942e6a50976323aaba558a1cfaacae9c17e5e`; its cron-cadence migration
(`20260901120000_p42_cron_cadence.sql`) was applied to `pokeportfolio-dev` BEFORE the
frontend merge — every-minute drain verified ticking naturally (~0.01 s no-op ticks),
nightly run-log prune scheduled, deployment check 28/28.** **P43 (portfolio reset + unified
correction-aware History) follows as DRAFT PR #49 rebased onto that state: not merged, not
deployed.** See "P43 — Portfolio reset + unified History" below, then "M13 — Export
and backup". Beneath that: M1–M12 plus the parallel Home/Search/quantity release are
complete in code, merged and deployed. M12 (Dashboard) was merged through PR #35 and released

---

## M13 — Export and backup (integrated candidate: P35 + P36 + P37)

Three parallel sources combined deliberately on this one branch — no source PR was merged to main:
P35 export core (PR #46 @ `b906cc0`), P36 UI/platform delivery (PR #44 @ `befa4c2`), P37
implementation-blind adversarial contract package (PR #45 @ `2c4ccb5`). All three remain OPEN/DRAFT
historical source PRs. The candidate is a NEW draft PR against main carrying the banner
"M13 INTEGRATED CANDIDATE / CLAUDE REVIEW REQUIRED / DO NOT MERGE".

What exists (decisions D-074–D-081; UX_FLOWS F11; CHANGELOG):

- **Export core** — lossless v1 JSON backup ("pokeportfolio-backup": strict unknown-key refusal,
  money as exact minor-unit strings proven past 2^53 end-to-end, verbatim wire timestamps, identity
  manifest instead of catalog copies, `is_admin`/`disabled_at` never travel) plus ten CSV analysis
  files through ONE RFC 4180 writer with free-text-only injection sanitization. Client-side under
  the owner JWT; identity session-derived (no user_id parameter anywhere); zero migrations, zero new
  RPCs, zero Edge Functions.
- **UI** — Profile › Data › Export & backup (`/profile/export`, lazy route behind RequireSession).
  Two-step flow (D-078): prepare fully → READY lists files → a fresh "Save / Share" tap delivers
  under new transient user activation. NotAllowedError is surfaced with explicit
  "Try sharing again"/"Download instead" (D-079); artifacts are memory-only; retry-generation and
  retry-delivery are distinct; an EMPTY account still produces a complete envelope and ten
  header-only CSVs.
- **Integration honesty fixes** — pagination renamed to what it is: offset-with-reconciliation with
  per-section COUNT, cross-page duplicate detection and loud failure on mismatch (D-074); export
  documented as NOT snapshot-isolated (D-077); sections renamed to canonical table names
  (`profiles`, `sealed_products`) under one strict-v1 rule adjudicated into BOTH implementation and
  oracle (D-076); client-zip/everything-export removed as unexposed surface (D-075); the §4.12
  export reminder implemented with a recorded 30-day local cadence (D-080); the M7.1 quick Portfolio
  CSV retained and relabelled "Quick CSV" (D-081); DATA_MODEL §7 `audit_events` corrected to
  PLANNED — the table does not exist and was not created to make docs true.
- **Tests/CI** — the P37 adversarial package is bound deliberately (recorded in its contract.ts)
  and ACTIVE in CI's db-tests job: typecheck step + DB-gated execution step covering the cross-user
  suite (two users, admin grants no widening, every MUST_EXPORT table owner-readable incl.
  SELECT-only `lot_cost_adjustments`) and the generated-backup contract (envelope valid, exclusions,
  privilege columns absent, counts reconcile, per-table completeness vs fixture, frozen FX and
  allocations verbatim, determinism). An opt-in ~10k-lot export scale audit joins the CI performance
  steps (reports duration/request-count/artifact bytes; catastrophic-only 60 s budget). Local gates
  green at the candidate SHA: typecheck, lint (0 errors), format, unit suites, build, e2e.

Still pending before M13 uses "released" language: Claude review of this integrated candidate, CI
green on the integration PR itself, then merge/deploy strictly per GIT_WORKFLOW. Restore remains M19
(D-025).

---

## P43 — Portfolio reset + unified History (draft PR #49, rebased)

- **Reset backend** (`20260901120010_p43_reset_and_history.sql`):
  `reset_my_portfolio_data()` — SECURITY DEFINER out of necessity (browsers hold no DELETE
  grants on the ledger; widening them forever so an INVOKER could work would undo D-060),
  `auth.uid()`-scoped with no user-id parameter, fixed `search_path`, no dynamic SQL,
  FK-deterministic deletion order with the M12 queue row locked FIRST so no concurrent drain can
  resurrect stale state, PUBLIC/anon revoked + authenticated granted, per-table deleted counts
  returned. Preserves account/profile/settings and reusable setup metadata (retailers, storage
  locations, tags, collection definitions emptied of members, manual card definitions, own
  sealed products). Nothing re-created afterward — genuinely empty.
- **History read surface**: `list_history_events(p_kind, p_include_voided, p_limit,
  p_before_at, p_before_id)` — one bounded SECURITY INVOKER keyset-paginated union over
  purchases, sales, non-purchase acquisitions and active manual valuations; voided entries
  hidden by default behind a presentation-only toggle; money as text; no N+1.
- **UI**: Profile Danger zone ("Are you sure?" → "Yes, reset portfolio", both removal and
  retention lists stated plainly, disabled-while-running, visible errors, invalidate-all +
  navigate Home on success); History rebuilt as one feed with All/Purchases/Sales/Added/Values
  chips, corrections toggle, Load-more pagination, every row linking to its existing correction
  surface (purchase/sale detail, Holding Detail).
- **Decisions**: D-084 (CORRECTION vs VOID vs DISPLAY FILTER vs FULL RESET — reset is the only
  intentional hard delete), D-085 (History = bounded union over canonical sources; corrections
  surface through status, not a second table).
- **Tests**: `tests/db/p43_reset_and_history.test.ts` (full seed matrix → reset → emptiness +
  preservation + B untouched + honest empty dashboard reads; history kinds/filters/toggle/
  pagination; idempotent re-reset; §12 worked example end-to-end),
  `tests/authorization/p43_reset_history.test.ts` (anon denial both functions, forged
  `p_user_id` overload rejected in the schema cache, feed isolation A vs B, cross-user reset
  impotence), new grant entries in `tests/authorization/function_grants.test.ts`,
  `scripts/grant-audit.sql` and the restated baseline `20260901120020_p43_privilege_baseline.sql`.
- **CI: GREEN** on the PR head (both jobs; 502/502 db+authorization tests across 39 files,
  hostile-grant convergence re-applying the new baseline). Four red runs preceded green and
  every failure was a genuine catch by CI's ephemeral Postgres: a wrong-case fixture enum
  ('PSA' vs 'psa'), missing `.single()` on rpc results in test helpers, an accumulation-based
  isolation assertion, **one real function bug — reset's returned counts were computed after
  the deletes (always zero), now captured via GET DIAGNOSTICS ROW_COUNT per statement** — and
  a fixture lot silently failing M11's sealed_intent rule. Local checks before each push:
  typecheck/lint/format clean, domain tests 168/168, production build green. Atomicity is
  structurally asserted (one PostgREST request = one transaction + exercised FK order); true
  fault-injection needs DDL the harness lacks — disclosed in TESTING.md.
- **Not done / for reviewers**: confirm the reset-vs-drain concurrency note in SECURITY.md
  §3.2.5 matches their reading; decide whether History's Values chip label should read
  "Valuations"; hosted deploy intentionally NOT performed in this session.

---

## P26/P27/P28 — parallel release (PRs #40/#41/#42, integrated 2026-08-24)

Three parallel owner-feedback sessions, each independently reviewed (Prompt 30 full adversarial;
Prompt 31/Prompt 32 repairs; Prompt 33 delta re-review: APPROVED for all three), then released in
a locked order: #40 → #41 → hosted P28 migrations → #42. The migration-before-merge order is the
safe expansion sequence: the new database function existed on `pokeportfolio-dev` before any
frontend that calls it could deploy.

- **PR #40 — Home polish** (`b2243e2`): removed the redundant "as of" date under Current
  Portfolio Value and the TTEP explanation sentence (no financial semantic changed); privacy eye
  sits beside the value it masks; Most Valuable Cards tiles show real resolved values ("—" when
  missing); URL-owned selected-state range pills; honest "history is just beginning" /
  market-movers empty states. Both one-point history and empty movers were diagnosed read-only
  against the hosted project as EXPECTED_NOT_ENOUGH_HISTORY, not bugs.
- **PR #41 — Search** (`035c3e0`): Sets showcase English-only by owner decision, vertical grid,
  larger tiles (D-073); set-image URLs normalized via the TCGdex set-asset convention
  (extension appended on the path segment only, query/fragment preserved); catalog reads retry
  once on structured `PGRST301` only — a defensive backstop for an unreproduced cold-start
  report, never a claimed-bug fix.
- **P28 migrations**: `20260831120000_p28_reduce_holding_quantity.sql` +
  `20260831120010_p28_privilege_baseline.sql` applied to `pokeportfolio-dev` via
  `supabase db push --linked` after a clean drift preflight (78 prior migrations local==remote,
  exactly these two pending). Post-apply verification: SECURITY INVOKER, `search_path=''`,
  ACL exactly `postgres/service_role/authenticated = X` with NO PUBLIC entry, signature
  `(p_holding_id uuid, p_lot_reductions jsonb)`; `grant-audit.sql` clean; live anon RPC probe
  HTTP 401 / SQLSTATE 42501.
- **PR #42 — Holding Detail quantity correction/removal** (`6a4b1b2`): quantity=1 → "Remove from
  Portfolio"; quantity>1 → "Adjust quantity" + "Remove all". Removal reuses M8.1's void
  lifecycle; reduction is the new `reduce_holding_quantity` RPC (semantics and guard chain:
  DATA_MODEL.md §9/§21, DECISIONS.md D-072). Purchased lots route to receipt correction; the lot
  floor routes to per-lot Void. Before merging, the combined main+#42 state was verified locally
  (typecheck/lint/format clean, unit tests 168/168, build green, E2E 58/58) without pushing
  anything.
- **Release verification:** main CI green on every step (one transient failure after #40's merge
  — a statement timeout inside the snapshots-benchmark SEED phase on a tree byte-identical to the
  PR head that had just passed the same job; green on immediate re-run, recorded in
  PROJECT_JOURNAL.md). Final `deployment-check.mjs` **28/28**;
  `remote-security-check.mjs` **17/17** (phase 1) re-run post-deploy. Authenticated UI
  verification remains PENDING_OWNER (no safe synthetic login this session): Home items above,
  Search showcase/images/no-crash + "Try again", and the Holding-Detail matrix (qty=1 remove;
  qty>1 adjust/remove-all; non-purchase shrink works; purchased lot routes to purchase
  correction; removing all works; no stale quantity afterwards).

---

## M12 — Dashboard (released: merged, migrated, backfilled, deployed)

Merged via PR #35 (squash commit `e79436841d72365141ae34ecf99d9de34be79448`; source branch
deleted). Historical independent-test source PR #36 was closed rather than merged separately —
its content shipped inside PR #35.

**Release verification actually run against `pokeportfolio-dev` (2026-08-23):**

- **Preflight.** Project identity confirmed via CLI API (`nopmkroeygmlvndzjjqs` =
  pokeportfolio-dev); migration drift preflight clean (all M1–M11 applied, exactly the six M12
  migrations pending); cluster `statement_timeout` = 120 s (inherited by `postgres`, which both
  cron and the drain use — no change made or needed at p_batch_users=1).
- **Generated types check.** Fresh `supabase gen types --linked` compared against the committed
  hand-maintained `database.types.ts`: every difference is generator-version noise (newer CLI's
  metadata blocks/identity-column representation/reordering/view-relationship inference), the
  known intentional `p_fx_rate_to_nok` string divergence, expected entries for service-only
  functions nothing in `src/` calls, or a newer-generator nullability policy across ALL RPC
  results that is provably wrong against the SQL (THP/TTEP are genuinely nullable when no
  snapshot exists — asserted by test). Committed file correct; approved SHA never changed.
- **Migrations.** All six M12 migrations applied cleanly in order
  (`20260830120000`…`20260830120050`). Hosted objects verified: three tables RLS-on;
  nine functions with reviewed signatures; cron rows exactly as reviewed.
- **Cron live.** `m12-recompute-snapshots` at :07/:22/:37/:52 and `m12-daily-snapshot-sweep`
  at 05:11 UTC, active; M9 jobs untouched. The first real tick after activation (20:37 UTC)
  already ran and succeeded against an empty queue.
- **Security.** `grant-audit.sql` clean; snapshots SELECT-own-only with zero browser write
  grants/policies; queue/runs carry no browser grants at all; engine/trigger routines
  service_role-only EXECUTE; `remote-security-check.mjs` 17/17 (phase 1); a forged-identity
  read returns an entirely empty summary (NULL dates/money, zero counts) — no cross-user data.
- **Initial backfill.** `enqueue_portfolio_daily_maintenance()` enqueued the existing user base
  (1 user); drained one user per call at `p_batch_users := 1` (~2 s wall clock including client
  overhead, far inside the timeout); queue converged to 0 rows; run record shows
  users_processed=1, snapshots_written=1, error=null — a single current-date snapshot row for a
  user whose tracked history starts today, no fabricated history.
- **Deployment.** Cloudflare rebuilt on merge; the live service-worker manifest references
  exactly the entry chunk produced by building `main` locally (`index-B_M9bN28.js`).
  `deployment-check.mjs` **28/28** (first fully automated complete pass since M11, including all
  37 chunks, CSP, project-ref, secret and PWA checks).

**Still pending (PENDING_OWNER):** the signed-in Dashboard check — no safe automated
authentication exists this session (standing no-sign-in boundary since M7.1; INVITE_TOKEN
unavailable). Owner checklist: log in → Home renders the dashboard and does not sit on
"Updating…" forever → switch 1W/3M/MAX → toggle hide-values over chart and figures → check
Raw/Graded/Sealed breakdown and spending sections load → confirm no error/blank screen.

**Independent adversarial validation (Prompt 21) has run.** The implementation-blind contract
package from `test/m12-independent-adversarial` (draft PR #36, authored without inspecting this
branch) was applied via validation PR #37 and executed for real against CI's ephemeral stack.
First unmodified result: 33 passed / 6 failed / 2 skipped of 41; the independent oracle's
full-range comparison (seven semantic columns × 90 days) passed immediately. All six first-run
failures were defects in the package's own harness (PostgREST OpenAPI body-parameter discovery, a
double-sold fixture lot, a head:true count read, a pre-first-tracked-date range, and two clusters
of hand-arithmetic literals), fixed with documented corrections; one implementation hardening came
out of it (`rebuild_portfolio_snapshots` now rejects a reversed date range instead of silently
reordering it). Final state on `feat/m12-dashboard`: 39 passed / 2 skipped (deep drain
fault-injection remains structurally asserted, not executed), scale audit green post-ANALYZE
(rebuild 20 ms · incremental drain 250 ms · summary 11 ms · history 5 ms at ~480 lots), full
normal regression green. Full account: `ai_outputs/Ox_Alpha_outputs/output_21.txt`.

**Review findings fixed (fix/m12-claude-review-p23).** Claude's full adversarial review rated the
implementation GOOD but required changes; every finding is now closed on this branch:
H1 — a manual-valuation row ended by an INDEPENDENT clear stays cleared even when a later,
separate valuation arrives with a higher effective_from; only an ATOMIC replacement keeps the
next-effective-from boundary (D-062's resolved corner, pairing test in `mv_intervals`, DB tests
with provider-fallback and unpriced gap variants plus scenario S/S2 and the aligned oracle).
H2 — TTEP renders "—" instead of a fabricated "0 kr" before the first snapshot exists
(`ttepDisplayState` domain helper; genuine zero still renders as 0; hide_values masks).
M1 — THP propagates NULL under the same condition instead of coalescing CMV to 0
(FINANCIAL_MODEL.md §6.5); types updated.
H3 — mentor decision recorded as D-070: portfolio_snapshots remains a derived rebuildable cache;
an older historical CMV point may adjust ONCE where M9.1 compaction removes dense observations;
frozen ledger fields never change; proven end-to-end by
`tests/db/m12_retention_rebuild.test.ts` (dense → real thinning → invalidation → drain →
from-scratch-rebuild equality) and disclosed in one restrained dashboard sentence.
D-069 records the ratified reversed-range rejection; D-071 documents the MAX = 4-years clamp;
the drain's per-user savepoint semantics are stated precisely (never "per-user commits"); the
initial-backfill runbook drains one user at a time; the stale privilege comment on
`m12_recompute_pending_for_self` is corrected (authenticated DOES hold EXECUTE, by design); and
D-068 gained a concrete multi-unit partial-disposal data proof.

**What it is.** Home is now the real portfolio dashboard over a derived snapshot cache:

- **Schema** (`20260830120000`): `portfolio_snapshots` — one end-of-business-day state per user
  per date (CMV, ACMV, historical DCB, CS/NSP-to-date cumulatives, open/unvalued lot counts);
  owner-SELECT-only RLS, zero browser write grants. `portfolio_recompute_queue`
  (`user_id PK, dirty_from`) and `portfolio_recompute_runs` are service/internal-only
  (RLS-on-no-policies-no-grants, the invitation_claims shape).
- **Engine** (`20260830120010`): `rebuild_portfolio_snapshots(user, from, through)` derives every
  field from canonical rows alone — disposal-timeline replay per date (never current-state
  projection), provider observations as step functions with freshness age measured from D,
  FX observed on/before each observation's own date, the manual-valuation interval model
  (D-062, including its reviewed clear-vs-replacement corner), frozen-ledger cumulatives by
  business date, rows only from the user's first tracked
  date. `drain_portfolio_recompute_queue` is the SKIP LOCKED worker with per-user failure
  isolation via PL/pgSQL savepoints inside one outer transaction (a failed user keeps its queue
  row; siblings continue; the whole batch still commits or rolls back together).
- **Invalidation** (`20260830120010/20`): triggers enqueue with explicit boundaries —
  least(old,new) on date moves so March recomputes when a purchase moves to April; shared
  price/FX/thinning facts fan out statement-level to affected owners; sealed intent, storage,
  tags, favourites and collection membership deliberately dirty NOTHING.
- **Cron** (`20260830120040`): every-15-min drain at :07/:22/:37/:52 (offset from M9 ingest)
  plus a daily sweep. Applied to the hosted project and verified live (first real tick
  succeeded).
- **Reads** (`20260830120030`): four SECURITY INVOKER RPCs — `get_dashboard_summary` (headline +
  data quality + lifetime figures + honest `pending_recompute` in ONE request),
  `get_portfolio_history` (stored NOK + D-067 historical display-FX + coverage flags),
  `get_monthly_spend` (GPO = CS + HS by construction), `get_recent_activity`.
- **UI**: Home rebuilt — headline from latest snapshot with an "Updating…" badge when queued,
  period change (zero base → undefined %, never fake), 1D–MAX ranges defaulting 3M,
  TradingView Lightweight Charts v5.2.1 in its own lazy chunk (62 KB gzip) with attribution
  implemented in full (D-066: NOTICE in source, visible TradingView link, built-in logo),
  privacy eye masking axis/tooltips/a11y summary together, raw/graded/sealed breakdown,
  monthly-spend bars, empty/no-history honesty, custom-collection scope showing current-only
  figures with explicit "membership not tracked" copy (D-065).

**The central gate:** full rebuild == incremental recompute, byte-identical over every semantic
column except `computed_at`, proven over a fixture containing backdating, partial sale, sale
void, manual set/update/clear, a backdated correction into cleared history, a price correction,
a genuine-zero observation, unpriced variants and sealed/graded manual-only holdings
(`tests/db/m12_dashboard_snapshots.test.ts`). Equality is relative to CURRENTLY RETAINED
canonical facts (D-070): after M9.1 compaction removes dense old observations, the rebuilt
series equals the post-compaction derivation exactly, proven by
`tests/db/m12_retention_rebuild.test.ts`.

**Decisions this milestone adds:** D-062 through D-068 in DECISIONS.md — manual-history interval
model, cache-shape/coverage flags, recompute architecture, custom-collection history policy,
chart-library adoption with attribution, display-FX rule, DCB adjustment-share rule — plus
D-069 (reversed ranges rejected), D-070 (cache stays rebuildable; one-time historical CMV
adjustment at the compaction boundary) and D-071 (MAX = up to four years of history).

**Verification actually run (final, at the merged SHA):** `pnpm typecheck` / `pnpm lint` /
`pnpm format:check` clean; `pnpm test` 130/130; `pnpm build` green with bundle measured (entry
374.00 KB raw / ~113 KB gzip; chart lib 194 KB raw / 62 KB gzip in a lazy chunk loaded only once
≥2 covered points exist). CI green on both jobs at the released SHA (`build-and-test`; `db-tests`
including all migrations from scratch, the M12 suites inside the privilege-convergence cycle,
both permanent benchmarks and the new snapshots benchmark). The hand-maintained
`database.types.ts` was compared against a fresh generated artifact in the release phase — see
the preflight note above for why the committed file stands.

---

## Status

**M1-M12 merged/deployed. No open M9/M10/M11/M12-family engineering item remains; the one open
item is the M12 owner signed-in Dashboard check (PENDING_OWNER above).** The standing
owner-device check item carried since M7.1 still applies to deployed surfaces. Do not begin M12a
or M13 before the owner confirms the Dashboard renders correctly in production.

## M9 — Pricing and snapshots

Real raw-card market values, wired from TCGdex-relayed Cardmarket/TCGplayer data through to
Portfolio, Home, Holding Detail and Card Detail. Full account: `ai_outputs/Claude_outputs/output_15.txt`.
Decisions: DECISIONS.md D-052 through D-055.

**Research, done before writing any code.** Live TCGdex probes 2026-08-21/22 (today's date at
research time) against five real cards confirmed the documented pricing schema is unchanged but
revealed a real complexity API_SOURCES.md's existing notes had not fully captured: two
incompatible-looking pricing shapes coexist in real payloads (embedded per-variant pricing vs.
card-level-only fields), and the card-level Cardmarket "-holo" slot can belong to a product that
matches none of a card's declared variants. Full reasoning: PROJECT_JOURNAL.md 2026-08-26 ("Real
TCGdex pricing payloads disagreed with each other..."). Current Supabase Cron/Vault/pg_net guidance
was independently re-checked (WebFetch against `supabase.com/docs/guides/cron` and
`.../functions/schedule-functions`) — the documented pattern (Vault secret, `net.http_post` inside
`cron.schedule`) matches what M9 implements; **not independently confirmed against the real hosted
project**, since applying the cron migration to `pokeportfolio-dev` did not happen this session (see
"Not done" below). Norges Bank's API needed no re-verification beyond M8's own 2026-08-24 check.

**Variant-safe price mapping** (`supabase/functions/_shared/tcgdex.ts`'s pricing section,
`fetchCardPricing`) — prefers a `variants_detailed[i].pricing` object when TCGdex has assigned one
explicitly (least ambiguous), falls back to the card-level top-level `pricing` object only when
unambiguous (exactly one variant of the relevant finish), and resolves to no price rather than a
guess otherwise (prompt §15). Locked in against five real captured payloads plus one deliberately
constructed ambiguous case, `tests/data/tcgdex-pricing.test.ts` (16 tests, all passing locally).
Cardmarket fallback: `trend → avg30 → avg7 → avg`. TCGplayer: `marketPrice` only, no fallback chain
(FINANCIAL_MODEL.md §6).

**Schema** (`supabase/migrations/20260826120000_m9_price_snapshots.sql` through `..._m9_privilege_
baseline.sql`, 8 files): `price_snapshots` (market data, one already-fallback-chosen row per
provider per variant per day — D-053 corrects DATA_MODEL.md §4.1's original per-price_kind sketch
for storage-volume reasons), `watched_card_variants` (service-role-only view, any lot ever created
for a variant keeps it watched forever, voided or not — D-055), `price_sync_runs` (service-role-only
observability, mirrors `catalog_sync_runs`), `select_price_sync_batch`/`thin_price_snapshots`
(service-role-only helpers for the ingest/retention jobs).

**The resolver** — `resolve_variant_market_values(p_card_variant_ids uuid[])`, called exactly once
per query with the full array of needed variant ids, never per-row (DATA_MODEL.md §17). Implements
FINANCIAL_MODEL.md §6 (manual → fresh → stale → missing) and the newly-activated `use_eu_pricing`
provider preference (D-052: Cardmarket preferred whenever it has a non-missing price; TCGplayer only
as fallback; freshness never compared across providers to override the preference). FX conversion
uses the snapshot date's own rate (most recent Norges Bank observation on or before it), computed
once per distinct (currency, date) pair actually present, not per variant (prompt §76). Three
callers: `get_holding_value_provenance` (Holding Detail's full provenance, applies the F10
graded-card exclusion), `get_card_variant_price_history` (Card Detail's real-snapshots-only chart
data), `get_market_movers` (Home's Market Movers section).

**`list_portfolio`/`portfolio_counts` rewritten** (`20260826120030_m9_list_portfolio_resolver.sql`)
— value_desc/asc now sorts by real **holding total** (unit × quantity, D-052), the low-value/
missing-value filters use the real **unit** value, and `portfolio_counts` gained
`priced_holding_count`/`unpriced_holding_count`/`portfolio_value_nok_minor` plus an optional
`p_custom_collection_id` scope parameter (both signature changes, both re-granted in the privilege
baseline). **A real M7.1 regression was found and fixed in the same rewrite**: M7.1's number-sort
migration had to `DROP`+`CREATE` `list_portfolio` (a new parameter changes a function's identity)
and, in retyping the body, silently reverted the real M7 10,000-lot-benchmark performance fix back
to a per-holding `LATERAL` aggregate — see D-054/PROJECT_JOURNAL.md. Restored to the
materialized-CTE shape in this same migration. **The large-Portfolio benchmark has not been re-run
against real data this session** (no Docker, and the real project was not reached — see "Not done"
below); a future session must run `scripts/portfolio-perf-benchmark.mjs` before treating M9's
Portfolio performance as proven, not just "should be fine because the shape is right."

**Scheduled ingest.** `ingest-prices` (every 15 minutes, bounded batch via
`select_price_sync_batch`, card-level fetch dedup, idempotent upsert keyed on the provider's own
`updated` date) and `ingest-fx` (daily, EUR+USD → NOK, reuses `_shared/norges-bank.ts` unchanged)
run on `pg_cron`/`pg_net`, both gated by a `PRICE_SYNC_SECRET` bearer secret compared
constant-time (same shape as M5's `CATALOG_SYNC_SECRET`), read from Supabase Vault at call time —
never a migration literal. `thin_price_snapshots` runs weekly as a plain SQL cron command (no HTTP
round trip). `search-prices` (user-JWT-gated) answers Search/Card Detail's on-demand, non-persisted
current-price questions for catalog cards the user may not own, bounded to ≤20 cards per call.

**UI.** Portfolio grid/list/table show the resolved holding-total value with a stale marker.
Home shows the real Collection value (with priced/unpriced counts), a real Market Movers section
(7-day window, top 5, "not enough history yet" when empty — never a fake 0%), and Most Valuable
Cards now filters on the real resolved value. Holding Detail has a unified "Current value" section
(manual override or automatic provenance — provider/price kind/source currency/FX rate/snapshot
date — for *any* holding kind, not just graded, per prompt §36) with a working "Return to market
value" action (`clear_manual_valuation`, supersedes without inserting a replacement, history
preserved). Card Detail shows each variant's real on-demand current price (source currency, not
converted to NOK — see the known limitation below) and a real price-history chart
(`src/ui/PriceHistoryChart.tsx` — 0/1/2+ real points handled honestly, never a fabricated line).
Profile's "Use European pricing" copy updated from "applies once market pricing is enabled" to
describe what it actually does now.

**Verified, actually run, not just described:** `pnpm typecheck`/`pnpm lint`/`pnpm format:check`
all green; `pnpm test` **100/100** (up from 85 — the 16 new `tests/data/tcgdex-pricing.test.ts`
cases); `pnpm build` green; `pnpm test:e2e` **58/58** (unchanged — no new routes). CI green on both
jobs (`build-and-test`; `db-tests` — **353/353 database and authorization tests**, up from 336 at
M8.1, including the hostile-grant convergence proof) — this took three pushes, because CI's real
ephemeral Postgres caught two real plpgsql bugs (`CREATE FUNCTION` does not validate embedded SQL;
see PROJECT_JOURNAL.md/output_15.txt for the full account) that neither local review nor
`pnpm check` could ever have found. PR #25 merged (squash, branch deleted); post-merge CI on `main`
also green.

**Deployed and verified against the real `pokeportfolio-dev` project, this session:**

- All 8 M9 migrations applied (`supabase db push`) — including `pg_cron`/`pg_net` extension
  activation, which worked on the first real attempt (the earlier uncertainty about this is
  resolved).
- All three Edge Functions deployed (`ingest-prices`, `ingest-fx`, `search-prices`).
- `PRICE_SYNC_SECRET` generated (a fresh random value, this session's own act — never printed,
  never logged, never asked of the owner) and set as both the Edge Function secret and the
  Supabase Vault secret; both copies confirmed matching by real use (see below). Temp files
  holding the value were deleted immediately after use.
- Live `curl` checks: `ingest-prices`/`ingest-fx` both return `401` for a wrong bearer secret;
  `search-prices` returns `401` with no JWT at all.
- `grant-audit.sql` clean against the real project. `remote-security-check.mjs` **17/17** (phase 1
  — no `INVITE_TOKEN` available this session, same as every session since M7.1).
- Real `cron.job` rows confirmed: `m9-ingest-prices` (every 15 min), `m9-ingest-fx` (daily 17:00
  UTC), `m9-retention-thin` (weekly) — all active.
- **A real initial price-sync batch happened on its own**, via the real first 15-minute cron
  tick — no manual trigger needed. `price_sync_runs` shows one real `prices` run (2 variants
  considered, 2 cards fetched, 4 snapshots written, zero errors); `price_snapshots` independently
  confirms 4 real rows across 2 distinct variants and both providers. This is genuine end-to-end
  proof — Vault secret, cron schedule, Edge Function auth, TCGdex fetch, variant mapping and the
  write path all working together for real, not just against CI's ephemeral stack. (The real batch
  size of 2 just reflects how few `card_variants` the real project currently holds — expected, not
  a bug.)
- `deployment-check.mjs` **28/28** against the rebuilt Cloudflare bundle (new hashes for every
  changed chunk — `PortfolioPage`, `HoldingDetailPage`, `CardDetailPage`, `CatalogPage`, etc. —
  confirming the deploy genuinely picked up the change).

**Not done this session, and why — a future session's actual to-do list:**

1. **The real 10,000-lot Portfolio benchmark has not been re-run**, and this is a harder blocker
   than it sounds: `scripts/portfolio-perf-benchmark.mjs` needs either the Supabase secret key
   (this session does not fetch it, unchanged rule since M6) or a real password sign-in to a
   synthetic account for the timed calls — and creating *any* account, synthetic or not, is on
   this session's own prohibited-actions list unconditionally, stricter than the "cannot sign in"
   boundary prior sessions worked around. A future session that can fetch the secret key (or work
   with the owner directly) should run this — D-054's fix should restore M7's 130-570 ms, but
   "should" is not "measured," and the resolver join is genuinely new SQL.
2. **`price_snapshots`' real storage footprint is computed, not measured.** Run
   `select pg_total_relation_size('price_snapshots')` against the real project once the watched
   set has grown past a handful of rows, and update COST_POLICY.md/DATA_MODEL.md §4.2 with the
   actual figure — see output_15.txt's "STORAGE PROJECTION" for the concern (the pre-M9 ~48-byte
   estimate omitted index overhead; a real year's unthinned accumulation could plausibly approach
   the 500 MB budget on its own before 12-month retention has a chance to apply).
3. **`ingest-fx`'s first real run has not been observed** — scheduled 17:00 UTC daily, had not
   reached that time this session. Check `price_sync_runs` for a `kind='fx'` row.
4. **`database.types.ts` was hand-updated, not regenerated** (same no-Docker constraint as every
   milestone since M6) — diffed carefully against the actual SQL return types (all money columns
   cast to `text`, matching the established PostgREST-bigint-precision boundary rule) but not
   verified against a real `supabase gen types` output. Two service-role-only functions
   (`select_price_sync_batch`, `thin_price_snapshots`) were deliberately **not** added to this file
   — nothing in `src/` calls them, so omitting them causes no compile error, but a real regeneration
   would include them and should be diffed carefully (same `p_fx_rate_to_nok`-string-divergence
   caution M8.1 already recorded applies here).
5. **Retention (`thin_price_snapshots`) has not been tested against synthetic >1-year data** — the
   real project has no data old enough yet for this to matter today, but the function's logic was
   reasoned through, not proven against a seeded dataset the way prompt §88 asked for.
6. **No owner-facing signed-in check has happened** — same standing boundary as M7.1/M8/M8.1 (this
   session does not create or sign into any account, synthetic or real).

**Known, disclosed simplifications (not gaps to silently close later):**

- Search's compact result-tile grid (`CardResultCard.tsx`) does not show per-tile pricing — only
  Card Detail does. Wiring it in properly needs an honest NOK-range display strategy (prompt §49)
  this session did not have time to design carefully; showing a raw source-currency figure on a
  dense grid tile risked looking like a NOK price.
- On-demand Search/Card Detail current prices display in their **original source currency** (EUR/
  USD), not converted to NOK — unlike Portfolio/Holding Detail, which use the real
  `resolve_variant_market_values` resolver and are always NOK-correct. A live client-side FX
  conversion for this specific display path is a reasonable follow-up, not implemented here.
- Market Movers is a Home-page section with a fixed 7-day window and no sort-mode toggle yet — the
  SQL function (`get_market_movers`) already accepts a period/limit, so this is UI-only remaining
  work. UX_FLOWS.md F16 records the gap against the owner's fuller original spec.
- Sealed-product pricing is out of scope by design (M11), unaffected by M9.

## M9.1 — Pricing closeout

Not a new milestone (docs/PLANNING_FREEZE.md still governs) — closes the explicit M9 acceptance
gaps `ai_outputs/Claude_outputs/output_15.txt`'s mentor review found, before M10 (Sales and History) begins.
Full account: `ai_outputs/Claude_outputs/output_16.txt`. Decisions: DECISIONS.md D-056 through D-058.

**Search pricing.** `CardResultCard`/`CatalogPage` now show batched real current prices — one
bounded `search-prices` request per ≤20-card result page (`SEARCH_PRICES_MAX_CARD_IDS`), never
per-tile, cached per exact id-batch by TanStack Query. Honest range display
(`src/domain/pricing-summary.ts#summarizeCardPricing`, pure and unit-tested): a single priced
variant shows its price; several priced variants show a min–max range; partial coverage shows
"From X kr", never implying full coverage; zero priced variants shows nothing (not a fabricated
"—" on every unpriced tile, a deliberate density choice for a grid dominated by unpriced commons/
energies). A pricing failure degrades silently to no price shown — never breaks the grid.

**Display currency is real now (D-057).** `search-prices` converts each price to an exact NOK
reference server-side (same `fx_rates` lookup-by-observation-date pattern
`resolve_variant_market_values` uses), alongside the untouched source-currency provenance —
closing M9's own disclosed "shows EUR/USD, not NOK" gap. `MoneyDisplay` now does real,
presentation-only NOK↔EUR/USD conversion using the latest cached `fx_rates` row and the exact
bigint reciprocal-rate helpers in `src/domain/fx.ts` (`invertRate`/`convertNokToDisplayCurrency`)
— canonical storage stays NOK everywhere; nothing about this touches `price_snapshots`, purchase
FX, or cost basis. No cached rate yet (e.g. before the first `ingest-fx` run) → shows NOK with a
plain "rate not available yet" note, never a fabricated number.

**Card Detail is exact-variant-aware.** Fixed the real M9 defect: price/history always used
`variants[0]` regardless of which variant a viewer actually cared about. Now an explicit selected
variant (URL-encoded, `?variantId=`, no global store) drives current price, source provenance and
the history chart together — switching variants never leaves a stale chart on screen. Default is
the first variant in catalog order (deterministic identity ordering), never auto-switched once
async pricing arrives.

**Market Movers is the real screen the owner originally asked for.** `/market-movers`: 1D/7D/30D
periods, four sort modes (highest increase / largest decrease / most movement / least movement),
all URL-encoded. `get_market_movers` gained a `p_sort` parameter (identity-changing DROP+CREATE,
`20260827120000_m91_market_movers_sort.sql` — TESTING.md §6a's own new standing checklist, added
because this migration is the exact scenario D-054 warned about) and a `holding_impact_nok_minor`
secondary figure. **Every sort mode ranks by per-unit `change_pct`, never holding-total kroner
(D-056)** — quantity never distorts the ranking, proven directly in
`tests/db/m91_market_movers.test.ts`. Reached from the Portfolio shortcut (no longer a muted
placeholder) and Home's "View all"; Home keeps its compact fixed-7-day preview unchanged.

**`price_snapshots` capacity is measured, and retention changed (D-058).** Real measurement — not
the earlier computed estimate — against a representative 365,000-row synthetic dataset in CI's
disposable ephemeral Postgres (`scripts/price-snapshots-storage-benchmark.sql`, now a permanent
`db-tests` step, never touching real data): **245.30 bytes/row** (table + its two indexes;
`price_snapshots_unique_per_day` is the single largest index, larger than the table itself). At
the documented realistic scale (~3,500 watched variants, 2 providers), M9's 12-month daily
placeholder projected to **~609 MB unthinned in year one alone — over the entire free-tier budget
on this one table.** Retention shortened to **60 days daily, thinned to weekly beyond that**
(`20260827130000_m91_retention_window.sql`, `create or replace`, no signature change): ~226 MB
worst case at 1 year, ~317 MB at 2 years — real headroom restored. Full projection table:
COST_POLICY.md §6. `tests/db/m91_retention.test.ts` proves the new threshold against an 18-month
synthetic dataset (recent/old boundary, per-week/per-provider/per-variant separation, idempotency,
history still usable after thinning).

**Value pagination correctness proven.** `tests/db/m91_value_pagination.test.ts` walks
`list_portfolio`'s `value_desc`/`value_asc` keyset pagination one row at a time against a seeded
dataset built specifically to produce a real 5-way tie group (manual vs provider, fresh vs stale,
same unit different quantity, different unit same total, all landing on the identical holding-
total) — proves no duplicate or omitted row under a real tie, for the full portfolio and a
custom-collection scope, and that a genuine zero-valued holding never collapses into the missing
bucket.

**The 10,000-lot Portfolio benchmark and the storage benchmark are now CI-integrated,** closing
the biggest disclosed M9 gap (no session between M9 and M9.1 had re-run either against real data —
the prior blocker, "cannot fetch the Supabase secret key or sign in," turned out to have a safe
answer all along: both scripts only need the ephemeral stack's own local well-known service-role
key, already exported for `pnpm test:db`, never a production credential). The perf-benchmark script
itself needed two real fixes along the way: it previously assumed the existing catalog had enough
`(variant, condition)` identity slots to avoid collisions, which CI's small ephemeral seed catalog
broke immediately — it now seeds its own ~3,500-variant synthetic catalog (matching the documented
production scale) and tracks every combo it has ever picked, never risking a duplicate insert
regardless of catalog size.

**A real, unresolved `list_portfolio` performance problem was found — disclosed plainly, not
downplayed.** Filtered/scoped/keyset-cursor queries and `portfolio_counts()` are genuinely fast:
26-90 ms across multiple runs, at or better than M7's 130-570 ms baseline. The DEFAULT, unfiltered
first-page path (every sort mode, `p_limit=30`, no cursor — what a real Portfolio page loads on
open) is not: measured at 4.0-7.6 seconds across three separate CI runs on the feature branch, and
on the very first run against `main` after PR #27 merged, one such call hit a genuine Postgres
`statement timeout` (57014) — an outright failure, not just slowness, at 10,000 lots / ~3,500
distinct variants, squarely inside this app's stated target scale. This is the same failure class
M7's original benchmark found and fixed once already (D-054's LATERAL regression) — a real,
current-day product risk, not a benchmark curiosity.

**One hypothesis was tested and disproven, honestly reported as such.** `portfolio_counts()` calls
the identical `resolve_variant_market_values` resolver with the identical large variant array and
stays fast, pointing at `list_portfolio`'s own ~12-branch CASE-based ORDER BY/cursor predicate
(absent from `portfolio_counts`) as the likely differentiator. A follow-up PR
(fix/m91-portfolio-query-timeout, #28) tried forcing PL/pgSQL onto a generic query plan
(`ALTER FUNCTION ... SET plan_cache_mode = 'force_generic_plan'`), reasoning that expensive
per-session custom-plan replanning of such a complex query might explain the pattern. **CI proved
this wrong, not right:** it made previously-fast filtered queries slow too (low-value/missing-value
filters: ~450 ms → ~2.6 s) while the already-slow unfiltered path stayed just as slow. Reverted —
never applied to the real project, so no cleanup was needed there. The benchmark script itself was
made resilient instead (`timeRpc`/`report()` now catch and report a real timeout inline rather than
crashing the whole run and hiding every other measurement — matching the script's own stated design
of reporting numbers, never asserting a threshold).

**Root cause is not yet identified.** The most likely remaining explanation, not yet confirmed: the
unfiltered path must materialize and sort the full `lot_agg` CTE (all ~7,500-8,000 holdings) plus
evaluate two `LATERAL` price-derivation blocks for every one of them before `ORDER BY`/`LIMIT` can
apply — genuinely substantial per-call work that a real, selective filter or cursor predicate lets
the planner avoid, but this was not confirmed with `EXPLAIN ANALYZE` against a real large dataset.
**A dedicated follow-up session must investigate this with real `EXPLAIN ANALYZE` tooling — ideally
using the JWT-claim-impersonation technique (`set local role authenticated; select
set_config('request.jwt.claims', ...)`) against a seeded large dataset in CI's ephemeral stack or a
throwaway project — before M9's Portfolio performance gate can be called closed.** This is the
single most important open item from this session; see MENTOR ATTENTION in
`ai_outputs/Claude_outputs/output_16.txt`.

**Real FX cron verified end-to-end.** `ingest-fx` had not yet reached its first scheduled 17:00 UTC
run this session (checked: `cron.job`/`cron.job_run_details` against the real project, current
time 08:53 UTC) — invoked it once manually via the exact same `net.http_post`/Vault-secret path the
cron job itself uses (never printing the secret, never a second auth mechanism). Real result: HTTP
200, `{"ok":true,"results":[{"currency":"EUR","ok":true,...},{"currency":"USD","ok":true,...}]}`,
a genuine `price_sync_runs` row (`kind='fx'`, `succeeded`, 2 snapshots written), and real cached
`fx_rates` rows (EUR/NOK, USD/NOK, `source='norges_bank'`, dated 2026-08-21 — Norges Bank's most
recent business day). The scheduled daily tick will now also fire normally going forward.

**Real bugs found and fixed, none silently absorbed:** a stale `scripts/grant-audit.sql` entry for
`get_market_movers`'s old two-argument signature (CI's privilege-convergence step caught this one
correctly and immediately, before merge); `search-prices`' NOK-conversion code reading
`fx_rates.rate` as if it were already decimal text, when PostgREST actually serializes a plain
`numeric` column `select` as a JSON number — would have made every `search-prices` call 500 in
production, silently degrading every Search/Card Detail price to "—" (caught by code review against
the project's own established "cast money to text" convention, not by any test, before merge); and
— found only *after* PR #27 merged, on the very first post-merge run against `main` — the real
`list_portfolio` statement-timeout regression described above, still not fully resolved as of this
handover (PR #28 makes CI resilient to it and reverts a disproven fix attempt, but does not fix the
underlying query cost). See PROJECT_JOURNAL.md 2026-08-27 for the first two; the third is carried in
this section and in `ai_outputs/Claude_outputs/output_16.txt`'s MENTOR ATTENTION, including the standing gap
the second bug exposes: no test coverage exists yet for Edge Function business logic, only for the
pure mapping layer.

**Verified, actually run:** `pnpm check` (typecheck/lint/format/domain tests, **108/108**, up from
100 — the new `tests/data/pricing.test.ts`) green locally. CI green on both jobs on `main` after
several real iterations (`build-and-test`; `db-tests` — **370/370 database and authorization
tests**, up from 353 at M9, including the new M9.1 retention/pagination/market-movers suites, the
storage benchmark, and the 10k-lot benchmark, all now permanent `db-tests` steps — green in the
sense that the job completes and reports; the `list_portfolio` finding above is a disclosed,
unresolved product-performance risk, not a passing check). PR #27 (the M9.1 feature set) and PR #28
(the post-merge performance-regression response) both merged — see "Owner check" below for what
remains a manual step.

**Not done this session, disclosed rather than silently accepted:**

1. ~~`list_portfolio`'s default (unfiltered, first-page) query path still has an unresolved,
   sometimes-severe (statement-timeout-grade) performance problem at 10,000-lot scale.~~ **Resolved
   in M9.2** — see the section immediately below. Root cause was stale planner statistics from the
   benchmark's own bulk seed, not `list_portfolio`'s SQL; no application code changed.
2. No new automated test coverage exists for Edge Function HTTP-handler logic (only the pure
   mapping layer, `tests/data/tcgdex-pricing.test.ts`) — the fx_rates-numeric-serialization bug
   this session found and fixed would have been the first thing such coverage caught.
3. A real owner-facing signed-in check has not happened — same standing boundary as every session
   since M7.1.

## M9.2 — Portfolio query performance closeout

Closes the one item M9.1 left open (above): `list_portfolio`'s 10,000-lot unfiltered first-page
regression. Full account: `ai_outputs/Claude_outputs/output_17.txt`. Decision: DECISIONS.md D-059.

**Root cause, confirmed with real `EXPLAIN (ANALYZE, BUFFERS, SETTINGS)` evidence from CI** (not
guessed — a prior hypothesis, `list_portfolio`'s own CASE-based `ORDER BY`/cursor shape, had already
been tested via `force_generic_plan` in PR #28 and disproved): immediately after the benchmark's own
10,000-lot bulk seed, every seeded table's `pg_class.reltuples` was `-1` — Postgres's literal "never
analyzed" sentinel, because a fresh ephemeral CI Postgres instance has had no autovacuum cycle in
that short a window. The planner falls back to no-information defaults for any query touching those
tables. **`portfolio_counts()` was equally catastrophic in that cold state — 7754ms, not the
26-90ms M9.1 recorded** — which is what proves the earlier "list_portfolio's own shape is the
differentiator" theory was itself a benchmark-timing artifact (whichever function got called first
in a run measured cold; whichever got called after enough round-trips had passed measured warm,
once autovacuum's autoanalyze had caught up in the background). `Buffers: shared hit` corroborates
the mechanism: ~1.4 million shared buffer hits cold, collapsing to 649-3,367 after an explicit
`ANALYZE`.

**No SQL changed.** `list_portfolio`/`portfolio_counts` are byte-for-byte identical to M9.1 —
TESTING.md §7's "ANALYZE alone explains it" outcome. The real fix is to
`scripts/portfolio-perf-benchmark.mjs`'s own methodology: it now runs `ANALYZE` on the seeded tables
before timing anything (the same effect production's continuous autovacuum already provides against
real incremental usage — a single 10,000-row bulk insert in under 2 seconds is not a pattern real
usage produces), closing the gap between "milliseconds after a synthetic bulk insert" and a
representative state. `scripts/portfolio-perf-explain.sql` (new, `--explain`-gated, not run by
default) captures the same evidence on demand for a future investigation.

**A real policy change, made because the evidence now supports it:** this defect class recurred
three times (M7's LATERAL regression, M9.1's timeout, this false lead) without CI ever failing on
its own benchmark. With representative statistics now guaranteed before every timed call, a
multi-second result is no longer measurement noise. The benchmark now fails the CI step (non-zero
exit) if any of the 12 sorts, the filtered/keyset/scoped queries, or `portfolio_counts()` exceeds
1.5s or errors — one generous, catastrophic-only threshold, not the tight per-sort budget
TESTING.md §7 already rejected as "microbenchmark theatre."

**Final real 10,000-lot/~3,500-variant numbers, CI's ephemeral stack, post-ANALYZE (3 runs per
sort, first/median/max, ms):**

| sort | first | median | max |
|---|---|---|---|
| value_desc | 72.8 | 82.8 | 198.5 |
| value_asc | 64.5 | 74.9 | 75.9 |
| name_asc | 61.7 | 62.5 | 63.5 |
| name_desc | 66.0 | 68.9 | 69.0 |
| set_asc | 69.2 | 70.4 | 71.1 |
| quantity_desc | 58.9 | 63.9 | 64.4 |
| acquired_newest | 59.1 | 60.0 | 68.0 |
| acquired_oldest | 59.9 | 60.2 | 62.3 |
| added_newest | 59.3 | 60.0 | 60.6 |
| added_oldest | 59.8 | 60.4 | 60.9 |
| number_asc | 130.5 | 146.3 | 195.8 |
| number_desc | 133.0 | 137.8 | 149.0 |

Filtered (condition=NM): 62.4ms. Keyset next page (name_asc): 68.8ms. Keyset value_desc first/next:
60.6ms/109.3ms. Low-value filter: 52.5ms. Missing-value filter: 95.3ms. Custom collection scope:
71.6ms. `portfolio_counts()`: 30.5ms (20.0ms scoped). Every result comfortably under TESTING.md
§31's <1s target with real headroom; no statement timeout anywhere. Matches or beats M7's original
130-570ms baseline.

**A disclosed, out-of-scope-for-this-session residual risk, not a gap in this fix:** the failure
mode this investigation found — a single large bulk insert immediately followed by a query, before
autovacuum has a chance to run — is not a pattern current real usage produces (holdings accumulate
one search-and-add or one purchase-import line at a time), so it is not a live production risk
today. It *would* recur if a future milestone ever added a genuine bulk-import feature (e.g.
restoring a large JSON backup, D-025) that inserts thousands of rows in one transaction and then
immediately queries them in the same request — such a feature should run `ANALYZE` on the affected
tables (or accept a brief post-import staleness window) as part of its own design, not assume this
fix covers it. No such feature exists yet; noted for whichever future session builds one.

**Verified, actually run:** `pnpm check` (typecheck/lint/format/domain tests, 108/108) green
locally — no `src/`/`supabase/` application code touched, so this is unaffected by the fix. CI green
on both jobs across two full runs (`build-and-test`; `db-tests`, including the now-passing
performance-gate step) — PR #30/#31, merged. No migration exists for this change (nothing in
`supabase/migrations/` — application SQL is unchanged), so there is nothing to deploy to
`pokeportfolio-dev`: the real project's `list_portfolio`/`portfolio_counts` were never wrong, and
remain exactly as M9.1 left them. `grant-audit.sql`/privilege baseline unaffected (no signature
change, no new function). Real owner-facing check: not applicable — nothing user-visible changed.

**Not done this session:** the two carried-forward M9.1 items (no Edge Function HTTP-handler test
coverage; no real owner-facing signed-in check) remain open, same as before — this session's scope
was narrowly the Portfolio performance gate.

## M10 — Sales and History

Real sales, with explicit lot selection every time — FIFO is only a pre-filled suggestion, never a
silent default. Full account: `ai_outputs/Claude_outputs/output_18.txt`. Decision: DECISIONS.md D-060.

**Schema** (`supabase/migrations/20260828110000` through `..._m10_privilege_baseline.sql`, 5
files). `sales`/`sale_lines`/`lot_disposals` (DATA_MODEL.md §5.7/§5.11) and — a real prerequisite
gap this milestone found and closed — `lot_cost_adjustments` (§5.6, documented since M3, never
actually created; M10's cost-basis freeze is its first real reader) and
`acquisition_lots.residual_nok_minor` (the NOK-side counterpart of M6's original-currency lot
residual, silently missing since M8 for any foreign-currency multi-unit lot — backfilled from each
lot's own `purchase_lines.attributable_cost_nok_minor`). D1 (`quantity_remaining = quantity − Σ
non-voided disposals`) is enforced by an `AFTER` trigger on `lot_disposals`
(`recompute_lot_quantity_remaining`, SECURITY DEFINER), not just RPC discipline.

**`create_sale`/`update_sale`/`void_sale` are SECURITY DEFINER** — the one real architectural
departure from every prior milestone's SECURITY INVOKER default, made because M10's prompt named a
stronger requirement than M8 ever had to satisfy: frozen cost basis, allocated amounts and realized
result must be genuinely unreachable by a direct write, not merely policed by a CHECK constraint.
`authenticated` holds `SELECT` only on `sales`/`sale_lines`/`lot_disposals` — no `INSERT`/`UPDATE`
grant at all. Full reasoning: DECISIONS.md D-060, `supabase/migrations/20260828120010`'s own
header, PROJECT_JOURNAL.md 2026-08-28.

**The residual-consumption rule** (D-060): a partial disposal of a known-basis lot freezes
`(unit_cost_basis_nok_minor + adj_per_unit) × quantity`, plus the lot's residual and any
adjustment-division residual **only on the disposal that reduces `quantity_remaining` to exactly
zero** — proven to reconcile exactly across three separate sales of an awkwardly-divisible lot in
`tests/db/m10_sales.test.ts`.

**Cost basis freeze and allocation** (`create_sale`, FINANCIAL_MODEL.md §2.2/§4.5). Every sale line
disposes from exactly one explicitly-chosen lot — the RPC never averages, never picks cheapest/
FIFO/most-expensive on the caller's behalf (`src/domain/sales.ts#suggestFifoOrder` is a client-side
*suggestion* only, pre-filling the oldest lot with a visible "Suggested: oldest acquired first"
badge the user can override before saving). Fees/outbound-shipping/buyer-shipping are allocated
across lines pro rata by gross, largest remainder (`allocate_largest_remainder`, reused unchanged
from M8); the NOK conversion of net proceeds uses a new signed variant
(`allocate_largest_remainder_signed`, and its TypeScript mirror `src/domain/allocation.ts#
allocateSigned`) because a sale can genuinely net a loss (prompt §109) and the existing allocator
rejects a negative total. Every referenced lot is locked (`SELECT ... FOR UPDATE`) in ascending
`lot_id` order before any disposal is written — two concurrent attempts to sell a lot's last unit
serialize correctly; proven directly with `Promise.all` in the test suite.

**Idempotency** (`sales.idempotency_key`, unique per user): the sale builder generates one UUID per
session (`crypto.randomUUID()`, kept in component state) and a retried `create_sale` call with the
same key returns the original sale rather than creating a duplicate.

**UI.** `/sales/new` (reached from the central + menu, Portfolio select mode's new "Sell" action,
and a Holding Detail "Sell" button — all three pre-load the relevant holding(s)): search bounded to
owned holdings only (`list_portfolio`, never the shared catalog), per-lot quantity steppers with
the FIFO suggestion, one sale price per item, sale-level fees/shipping/buyer-shipping, live
preview, NOK or a foreign currency via Norges Bank or a manual rate. `/sales/$saleId`: full audit
trail — gross/fees/shipping/net, the known/unknown split shown separately ("Realized result on
costed items" / "Proceeds from items without recorded cost", never a collapsed fake "Profit"),
per-line cost basis and result, edit/void. `/sales/$saleId/edit`: the safe-correction path (price/
fees/shipping only — lot and quantity cannot change here; the sale detail page's Void action plus a
new sale is the documented alternative, matching `update_purchase`'s own precedent). `/history`:
Sold is fully functional (list with newest/oldest/result-high-low/result-low-high/proceeds/
marketplace sort, `NULLS LAST` in both directions so an unknown-basis sale never sorts as
+/-infinity); Traded/Other honestly say they have nothing to show yet (M18/none). Home gained a
History shortcut (net sales proceeds) alongside the existing Purchases shortcut.

**Verified, actually run, not just described:** `pnpm check` (typecheck/lint/format/domain tests,
108/108, unchanged — M10 touched no existing `src/domain` test) green locally. `pnpm typecheck`/
`pnpm lint` clean across every new file (two real ESLint findings from `tests/db/m10_sales.test.ts`
fixed before commit: `.single<T>()`'s narrowed-`data`-type interaction with `no-unnecessary-
condition`, and `any`-typed query results needing explicit casts in the untyped-client test
directory — see `eslint.config.js`'s own note on why that directory is exempted from
`no-unsafe-*`). `pnpm format:check` clean.

CI green on both jobs (`build-and-test`; `db-tests` — **398/398 database and authorization tests**,
up from 370 at M9.2 — including privilege-baseline convergence and hostile-grant-state convergence,
and the 10,000-lot Portfolio benchmark unaffected, 67-93 ms across the three sampled sorts, no
regression). This took two pushes: CI's own first real run against a real ephemeral Postgres caught
two real bugs neither local review nor `pnpm check` could ever have found (money can't be typechecked
into correctness) — see "Real bugs found and fixed" below. PR #31 merged (squash, branch deleted);
`main` fast-forwarded clean.

**Deployed and verified against the real `pokeportfolio-dev` project, this session:**

- All 5 M10 migrations applied (`supabase db push --linked`) — `residual_nok_minor` backfill,
  `lot_cost_adjustments`, the sale ledger, the SECURITY DEFINER RPCs, the privilege baseline.
  `supabase db dump` (the pre-migration safety backup) could not run — same no-Docker constraint as
  every session since M3, `supabase db dump --linked` still shells out to Docker even without a
  local stack. Proceeded on the same basis every M4.1-M9.2 session already established for this
  exact gap: every migration here is purely additive (new tables, one new nullable-safe column with
  a read-only backfill `UPDATE`), already proven to apply cleanly and reproducibly from empty in
  CI's own "reset and reapply from scratch" step.
- `grant-audit.sql` clean against the real project (`supabase db query --linked`, zero rows).
- `remote-security-check.mjs` 17/17 (phase 1 — no `INVITE_TOKEN` available this session, same as
  every session since M7.1).
- Cloudflare Pages rebuilt automatically on merge to `main` (Git-connected, no manual deploy step),
  confirmed by a real hash change (`index-BohQ7x5q.js` → `index-DKHSX-dP.js`) polled directly against
  the live site. `deployment-check.mjs` itself could not complete this session — Node's `Promise.all`
  burst against ~28 concurrently-fetched Cloudflare edge chunks hit a local `ConnectTimeoutError`
  (`UND_ERR_CONNECT_TIMEOUT`) on this machine every time, while plain sequential `curl` against the
  same URLs succeeded instantly and repeatedly — reads as a local Node/undici concurrent-connection
  limit on this machine, not a deployment defect (the identical sequential requests the script makes
  one at a time all worked). The checks that actually matter were reproduced by hand instead, via
  the service worker's own precache manifest (confirming `HistoryPage`/`SaleFormPage`/
  `SaleDetailPage`/`SaleEditPage` chunks are genuinely present in the live build) and sequential
  `curl`: the bundle's `supabase-client` chunk resolves to exactly `nopmkroeygmlvndzjjqs.supabase.co`
  (the real defect class this check exists for — a transposed project ref shipped once, silently,
  before this script existed), no `sb_secret_...` key or `service_role` JWT in the checked chunks, no
  source map, all three sampled deep links (`/login`, `/invite/...`, `/admin/invitations`) resolve to
  the app shell (client-side routing intact), and the CSP header correctly scopes `connect-src` to
  the real project. A future session with a working `deployment-check.mjs` run should still do the
  full automated pass — this was a disclosed workaround, not a replacement for the real script.

**Real bugs found and fixed, none silently absorbed:** `create_purchase` never nulled `v_condition`
for a graded *card* line — only for a sealed one — so `holdings_condition_only_for_raw` rejected the
whole purchase whenever a caller's line JSON carried a redundant `condition` value alongside
`grading_state='graded'`. Pre-existing since M8 (the frontend never triggers it — `PurchaseFormPage`
already omits `condition` for a graded line — so nothing before M10's own test suite, which called
the RPC directly, had reason to construct this input). Fixed by mirroring the sealed branch's
existing `v_condition := null`, in the same migration the residual fix already touches. Separately,
`tests/db/m10_sales.test.ts`'s own market-price-regression test inserted a `price_snapshots` row for
a shared seed-catalog variant dated "today", colliding with `tests/db/m9_valuation_resolver.test.ts`'s
own fresh-snapshot fixture in CI's shared ephemeral stack (same variant, same provider, same
today-dated unique key) — moved to a fixed historical date no freshness-relative fixture would ever
use. Both caught by CI's real ephemeral Postgres on the first push, neither by local review.

**Known, disclosed simplifications (not gaps to silently close later):**

- Lot selection is explicit but the sale builder asks for **one price per holding**, applied to
  every lot-line from that holding — the schema supports a different `unit_gross_minor` per lot
  (and `update_sale`/the RPC layer make no such assumption), but the common real case is selling
  several physically identical copies together at one price. A future session wanting true
  per-lot pricing in the builder UI can add it without any schema or RPC change.
- `update_sale` cannot change which lot or how many units were sold (prompt §51's explicit
  documented fallback) — void the incorrect sale and record a corrected one instead. A real
  disposal-reversal edit path is a defensible follow-up, not a gap this milestone silently
  accepted without disclosure.
- `lot_cost_adjustments` has no write RPC yet — `authenticated` holds `SELECT` only. M17 owns the
  real "record a grading submission" RPC that will validate a fee against a real grading
  submission before writing here.
- No live-browser end-to-end verification happened this session — same standing boundary as
  every session since M7.1 (this session does not create or sign into any account, synthetic or
  real). The DB/authorization suites are the correctness proof; see "Owner check" below for the
  one manual step that remains.

**Not done this session, and why:**

1. Owner-facing signed-in check — same standing boundary as every milestone since M7.1. See "Owner
   check" in `ai_outputs/Claude_outputs/output_18.txt` for the exact steps.
2. No new Playwright `.spec.ts` file — matching the established pattern since M6 (E2E count has
   stayed flat at 58 through every feature milestone; feature correctness is proven at the
   DB/authorization layer and via live browser verification, which this session could not do
   without an account). If a future session wants scripted E2E coverage for the sale flow, it can
   be added without any application change.

## M11 — Sealed Inventory

Sealed products (booster packs/boxes, ETBs, bundles, tins, collection boxes) are first-class
Portfolio inventory, reusing the existing card acquisition/purchase/valuation/sale machinery rather
than a parallel system. Full account: `ai_outputs/Claude_outputs/output_19.txt`. Decision: DECISIONS.md D-061.

**Audit first, before any UI.** Most of the sealed schema already existed from earlier milestones
and had never been exercised: `sealed_products` (curated-vs-private RLS, M3), `holdings.
sealed_product_id` (M3), `purchase_lines.sealed_product_id`/`line_type='sealed'` (M3/M8 —
`create_purchase` already created a real holding+lot for a sealed line, not a financial-only
record), `manual_valuations` (M6, D-038, already generic over `holding_id`). Real gaps: no sealed
identity in `list_portfolio`/`portfolio_counts`/`holding_summaries`, no direct-add path outside a
purchase, no sealed browsing/detail/add UI, and one real schema defect (next).

**The intent-cardinality defect (D-061).** `sealed_intent` had been sketched on `holdings` since
M3. Tested directly against the scenario the prompt named — three identical booster boxes, two
"keep sealed" and one "planned to open" — and it cannot be represented: `holdings_identity`
correctly merges all three into one holding row, so a holding-level intent column has exactly one
slot for the whole position. `create_purchase` already defaulted every new sealed holding's intent
to `'undecided'` and never revisited it on a matching repeat acquisition. **Fixed**: relocated to
`acquisition_lots` (same structural move `storage_location_id` went through in M6, D-036, not a new
pattern). New RPC `set_sealed_lot_intent(p_lot_id, p_intent, p_quantity default null)` — SECURITY
INVOKER, splits a lot into two (new sibling at the new intent, original shrunk by the same amount)
when only part of its remaining quantity changes; both keep the original's cost-basis columns
unchanged, conserving total cost basis exactly. `list_portfolio`/`holding_summaries` aggregate a
holding's lots into `qty_keep_sealed`/`qty_planned_to_open`/`qty_undecided`, inside the existing
materialized lot-aggregation CTE — no new join, no per-row correlated subquery.

**Schema** (`supabase/migrations/20260829120000` through `..._m11_privilege_baseline.sql` and two
more, 7 files): the D-061 relocation + `set_sealed_lot_intent`; `list_portfolio`/`portfolio_counts`
DROP+CREATE for sealed identity, the three intent filters (`p_holding_kind`/`p_sealed_product_type`/
`p_sealed_intent`), and the `cards_value_nok_minor`/`sealed_value_nok_minor` segment (always sum to
the total); `add_card_acquisition` DROP+CREATE for `p_sealed_product_id`/`p_sealed_intent` (a direct
add path outside a purchase); a deliberately modest curated seed (seven real products, individually
sourced by live web search at migration time — see output_19.txt for full provenance); the
privilege baseline; `holding_summaries` view extended (CREATE OR REPLACE, additive columns only,
not a DROP+CREATE — Postgres allows a view to gain trailing columns without changing its identity);
`create_purchase` CREATE OR REPLACE for the `sealed_intent` write it had been missing plus an
optional per-line `sealed_intent` field.

**Manual valuation, sale/history — fully reused, zero schema change.** `set_manual_valuation`/
`clear_manual_valuation`/`get_holding_value_provenance` already resolved manual-or-missing for any
non-`raw_card` kind since M9 (F10). A sealed lot sells through `create_sale`/`void_sale` completely
unmodified — verified directly, not assumed. `data/sales.ts` and `PurchaseDetailPage`/
`SaleDetailPage` already fell back to `sealedProductName` correctly (built generically in M8/M10,
before M11 existed to need it).

**UI.** `CatalogPage` gained a third "Sealed" mode (debounced, offset-paginated search over curated
+ own custom products, an "Add a custom sealed product" CTA, a product detail route at
`/catalog/sealed/$sealedProductId` — no price chart, no market data). A direct add flow at
`/portfolio/sealed/new` (reachable from the central + menu, a product's detail page, or a Holding
Detail "Add another copy" link) mirrors `AddToCollectionPage`'s origin/cost-basis logic with a
narrower origin set (purchase/gift/pre_tracking/other — no found/opening/trade_in, enforced by a
narrower TypeScript union, not just which buttons render). Portfolio gained a type filter (All/Raw/
Graded/Sealed), sealed-only refinements (product type, intent) under the same filter sheet, and a
Cards/Sealed value-breakdown line in its header (Home and Profile got the same breakdown — both had
been showing a stale pre-M9 "pricing not enabled yet" placeholder even for the already-working card
value, corrected in the same pass since the same sections were being edited anyway). Holding Detail
shows sealed identity, the intent breakdown, the existing manual-valuation section verbatim, and a
per-lot "Change intent" action. All value displays respect the existing hide-values privacy eye — a
real gap (the new breakdown lines initially ignored it) found in review and fixed before merge.

**Real bugs found and fixed, none silently absorbed** (all before/during this session's own PR, all
proven by a passing CI run afterward, none discovered post-merge):

1. `create_purchase`'s acquisition-lot INSERT never set `sealed_intent` — found by this session's
   own audit before any test ran against it, fixed in the same migration set.
2. An untyped `CASE WHEN ... THEN 'sealed' ELSE 'card' END` in `add_card_acquisition` resolved to
   `text` with no cast to the `line_type` enum column — CI's first run caught it; it broke every
   known-cost `add_card_acquisition` call, not just sealed ones, cascading into unrelated M6/M8.1
   fixture-dependent test failures. Fixed with an explicit `::public.line_type` cast.
3. `acquisition_lots_check_owner`'s M11 replacement was diffed against the M3 original rather than
   M6's later extension (`20260821120020`), silently dropping the `storage_location_id` ownership
   check M6 had added. CI's second run caught it via `tests/db/m6_constraints.test.ts`; restored,
   with a standing comment naming which version to diff against next time.
4. Two cross-test isolation bugs in the new M11 test files (several cases reused the shared curated
   seed product across count-sensitive assertions, which `holdings_identity` legally merges across
   `it` blocks for the same synthetic user; a helper never set `created_by_user_id`, required
   explicitly by RLS). Fixed with per-test isolated custom products and an explicit creator id.
5. **Real security gap**, found by CI's own authorization suite: neither `create_purchase` nor
   `add_card_acquisition` verified a caller-supplied `sealed_product_id` was curated or the caller's
   own before writing against it — RLS hid a private product from listing, but a forged id sailed
   through both write paths. Fixed: both (SECURITY INVOKER) now `exists (select 1 from
   sealed_products where id = ...)` under RLS as the caller before writing.
6. M10 security-preflight documentation correction (prompt's own audit item): older owner-check
   trigger comments described RLS as the reason a cross-tenant id fails, which is not the operative
   mechanism when the same trigger fires from inside a SECURITY DEFINER cascade
   (`create_sale`/`update_sale`/`void_sale`, or the D1 trigger). Never load-bearing either way — the
   real guarantee is each trigger's own explicit `user_id` comparison. Documentation-only
   (docs/SECURITY.md §3.2.4), no SQL changed, no exploit exists.

**`scripts/deployment-check.mjs` harness fix.** M10 disclosed a local `ConnectTimeoutError` from one
unbounded `Promise.all` over ~28-34 Cloudflare chunks. Changed to a bounded 5-way concurrency pool
plus an explicit 15s per-request timeout. Verified this session: **28/28 checks passed** against
the real deployment — the first fully automated, complete run since M9.

**Verified, actually run:** `pnpm check` (typecheck/lint/format/domain tests, 108/108, unchanged)
green locally. `pnpm test:e2e` 58/58 (unchanged — no new route-level e2e coverage, matching the
established pattern since M6). `pnpm build` green (both locally, with real env vars sourced from
`.env.local`, and via Cloudflare's own build on merge). CI green on both jobs after four iterations
(see bugs 1-5 above) — **415/415 database and authorization tests, up from 398 at M10** (+17: 10 in
`tests/db/m11_sealed_inventory.test.ts`, 7 in `tests/authorization/m11_sealed.test.ts`). The 10k-lot
benchmark was re-run (mandatory — `list_portfolio` changed) and shows no regression: all 12 sorts
under 1500ms, comparable to the M9.2/M10 baseline (60–252ms range; number_asc/desc remain the
slowest at ~138ms, unrelated to M11 — natural-sort-key computation). `grant-audit.sql` clean and
hostile-grant convergence clean, both against the real project and against the new M11 privilege
baseline. PR #33 merged (squash, branch deleted); post-merge CI on `main` green.

**Deployed and verified against the real `pokeportfolio-dev` project, this session:**

- All 7 M11 migrations applied (`supabase db push --linked`).
- `grant-audit.sql` clean against the real project.
- `remote-security-check.mjs` 17/17 (phase 1 — no `INVITE_TOKEN` available this session, same as
  every session since M7.1).
- Cloudflare Pages rebuilt automatically on merge; confirmed live via the service worker's precache
  manifest listing the new sealed chunks (`sealedProducts`, `SealedProductImage`,
  `SealedProductDetailPage`, `AddSealedProductPage`).
- `deployment-check.mjs` **28/28**, in full, for the first time since M9.

**Known, disclosed simplifications (not gaps to silently close later):**

- The curated seed is seven individually-sourced real products — real coverage, nowhere near a
  complete catalog. The custom-product path is the intended long-term coverage mechanism, per
  design (prompt §14).
- No image upload for a custom sealed product — deliberately deferred to a later Images milestone
  (prompt §13); a generic per-type placeholder covers both curated and custom rows without
  expanding the CSP.
- No sealed catalog curation/promotion workflow (a private row can never become curated) —
  explicitly out of scope; tracked in DATA_MODEL.md's open-questions table since before M11.
- No new Playwright e2e coverage for the sealed flows — matches the established pattern since M6.

**Not done this session, and why:**

1. Owner-facing signed-in check — same standing boundary as every milestone since M7.1. See "Owner
   check" in `ai_outputs/Claude_outputs/output_19.txt` for the exact steps.

## Deployed state (now M12 — PR #35 merged and deployed)

The application is deployed and reachable: **https://pokeportfolio-dev.pages.dev**, on the M12
state (PRs #14 through #35 all merged; M12's #35 is the newest — #34 was the M11 docs handover).
Home is the real portfolio dashboard (headline, period chart with TradingView attribution,
raw/graded/sealed breakdown, monthly spend, recent activity — all honest about missing data and
pending recomputes). The owner has a working administrator account on the development project,
the shared catalog holds
the real English and Japanese physical Pokémon TCG card set (M5), and the deployed build lets the
owner search a card (with visible card artwork, a set-browsing carousel, and a favourite filter) or
a **sealed product** (curated + their own custom products), add either to their Portfolio with real
acquisition provenance and cost, browse it in `/portfolio` — grid/list/table views, sort, filters
(including a Raw/Graded/Sealed type filter), custom collections, and select-mode bulk actions
including a real "Remove from Portfolio" and a real "Sell" — record a real multi-line purchase
(`/purchases`) with retailers, shipping/customs/discount allocation (now including sealed lines),
foreign currency via Norges Bank or a manual rate, and safe edit/void — record a real **sale**
(`/sales/new`, sealed lots included) with explicit lot selection and frozen cost basis, and browse
**History** (`/history`) for what's actually been sold — all reached from the central + menu and
Home, same discoverability pattern purchases already had. Primary navigation is still Home/Search/
Portfolio/Profile plus a central quick-add — neither Purchases nor Sales/History nor a sealed tab
are new nav destinations (Sealed is a mode within the existing Search screen). Theme (light/dark/
system) actually applies.

**M6 also migrated the project's Supabase API keys** (D-039) — see "Security: key migration" below
before touching anything credential-related. The legacy `anon`/`service_role` pair is now
**deactivated** on `pokeportfolio-dev`. If you are about to run `supabase projects api-keys`,
stop: that exact command is what caused the M5 exposure this migration closed out. It stays
unnecessary for everyday work; if you ever genuinely need it, use `--reveal` deliberately and never
capture the output into anything persisted.

Scope is settled — do not reopen it (see [docs/PLANNING_FREEZE.md](docs/PLANNING_FREEZE.md) §9).

## M7 verification state — read before assuming anything is deployed

This machine has no local Docker (§4/Environment table, unchanged since M3), so `pnpm db:start`/
`pnpm test:db` could never run against a real Postgres on this machine directly. CI's ephemeral
stack proved correctness; `pokeportfolio-dev` itself proved performance and deployment behaviour.
Both have now actually run, not just been described.

**Actually verified, green:** `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test`
(80/80 domain tests, unchanged — M7 touched no `src/domain` logic), `pnpm build`, `pnpm test:e2e`
(50/50 Playwright, desktop + iPhone) all pass locally. CI's `db-tests` job is green on PR #14:
19/19 test files, 269/269 database and authorization tests (up from 251 at the M6 merge). CI's
`build-and-test` is also green (gate + E2E + gitleaks).

**Real bugs found by actually running things, all fixed on the branch — five in total, three
categories** (full account: PROJECT_JOURNAL.md 2026-08-22, both entries):

1. CI's first run: `search_cards` needed an explicit `service_role` grant once the PUBLIC-EXECUTE
   sweep (D-042) removed the implicit default `tests/db/search_cards.test.ts`'s service-role
   client had been silently relying on.
2. CI's first run: `custom_collection_members.user_id` needed `default auth.uid()` — without it, a
   real authenticated-client insert (the app's own `addHoldingToCollection` code path) was
   rejected by RLS.
3. CI's first run: a test-only fixture bug in `tests/db/m7_constraints.test.ts`, reusing one fixed
   holding identity across multiple tests for the same synthetic user.
4. **The real 10 000-lot benchmark: `list_portfolio`/`portfolio_counts` were genuinely too slow to
   ship** — 5.5-8 seconds per call against 7,500 holdings/10,109 lots, with `value_desc` (the
   *permanent default sort*) and `added_newest` actually timing out
   (`57014 canceling statement due to statement timeout`). Root cause: a `LEFT JOIN LATERAL`
   per-holding aggregate, which forces a nested-loop plan, instead of the plain
   `LEFT JOIN ... GROUP BY` shape `holding_summaries` (M6) already uses correctly. Rewritten as a
   `MATERIALIZED` CTE with that shape; re-measured against the *same* seeded data at
   **130-570 ms across every sort mode, the filtered query and keyset pagination** —
   `20260822120030_m7_portfolio_query_perf_fix.sql`, `20260822120040_m7_portfolio_counts_perf_fix.sql`.
5. Deleting the benchmark synthetic account afterward failed: `custom_collection_members.user_id`
   had no `ON DELETE CASCADE` — the third time this project has hit this exact defect class (M4,
   M6, now this). Fixed (`20260822120050_m7_custom_collection_members_cascade_fix.sql`), verified
   by actually deleting the account a second time (succeeded, zero residue), and a new regression
   test added (`tests/db/m7_constraints.test.ts`, "account deletion cascades every M7 table").

Item 2's bug was originally suspected to also exist in M6's `holding_tags` table (same shape,
found by reading just the table's `create table` statement) — **checked and it does not**:
`20260821120070_m6_user_id_defaults.sql`, later the same M6 milestone, already added
`default auth.uid()` to `holding_tags.user_id`, confirmed live on `pokeportfolio-dev`. No migration
needed. The real gap underneath the false alarm — no authorization test actually exercised a real
client insert relying on that default — is now closed
(`tests/authorization/m6_collection.test.ts`, "holding_tags: ownership and the user_id default").
Full account: PROJECT_JOURNAL.md 2026-08-22, "A bug report built on an incomplete inspection".

**Done this session, against the real `pokeportfolio-dev` project:**

1. ~~Open the PR and confirm CI is green~~ — **done.** PR #14, both jobs passing (269/269 db tests).
2. ~~`supabase db push` / `remote-security-check.mjs` / `grant-audit.sql` against the real
   project~~ — **done.** All six M7 migrations applied; `grant-audit.sql` clean (verified twice,
   before and after the perf/cascade fixes); `remote-security-check.mjs` 17/17 (phase 1) then
   33/33 (phase 2, full redemption) against a throwaway `.invalid` invitation, deleted after use.
3. ~~The 10 000-lot benchmark~~ — **done, against a real isolated synthetic account (7,500
   holdings, 10,109 lots), not the local stack.** Seeded and queried via direct SQL/HTTP rather
   than running `scripts/portfolio-perf-benchmark.mjs` itself, because that script needs the
   Supabase secret key and this session never fetches it — the equivalent verification used
   privileged `supabase db query --linked` access (already legitimately available, no secret key)
   for seeding/cleanup and the publishable key + a real password sign-in for the timed RPC calls.
   Account fully deleted afterward, verified zero residue. **This run is what found and fixed
   findings 4 and 5 above** — the actual point of the gate.

**Done since, against the real deployment:**

4. ~~Merge PR #14, confirm the Cloudflare deploy, and browser-verify the deployed Portfolio UI~~ —
   **done.** PR #14 merged. Browser-verified live on `pokeportfolio-dev.pages.dev` end to end via a
   throwaway `.invalid` synthetic account created through the real invite-redemption flow: Home,
   Search Cards mode with per-result quick-add, the full M6 add-to-collection flow reused from a
   search result (condition, acquisition origin, cost validation all behaved correctly), Portfolio
   grid/list/table views, More, Profile. Zero console/network errors other than one real finding
   (item 6). Account deleted afterward, zero residue confirmed across every M6/M7 user-owned table.
6. **Found during that verification, fixed on a follow-up PR:** the Content-Security-Policy's
   `img-src` had never been given an external host, so every card thumbnail M7 renders (search
   results, Portfolio grid tiles) was silently blocked in production — a gap `vite.config.ts`
   explicitly flagged in a comment since M5 ("will need that origin added here") that nobody
   revisited when M7 started actually rendering artwork from it. CI cannot catch this class of bug:
   `_headers` only applies on Cloudflare Pages, and `vite dev`/`vite preview` ignore it entirely, so
   it is only ever exercised on a real deployment. Fixed by naming `https://assets.tcgdex.net`
   explicitly in `img-src` (not by loosening to `https:`) — `fix/m7-csp-image-host`, PR #15, CI
   green, merged, re-verified live (card artwork now loads).

**Not yet done:**

5. A short real-iPhone check (M7 prompt §120) — genuinely needs the owner's own phone; this is the
   only remaining step.

Do not report M7 as fully finished to the owner until item 5 also happens.

## Read these first, in order

1. `HANDOVER.md` — this file
2. `docs/PLANNING_FREEZE.md` — the authoritative frozen scope
3. `docs/PRODUCT_SPEC.md` — what the product does
4. `docs/ARCHITECTURE.md` — the stack and why
5. `docs/DATA_MODEL.md` — schema, ownership, lifecycle (§12 has the scoping notes — read it,
   several tables and enum values that earlier sections imply exist are deliberately deferred)
6. `docs/FINANCIAL_MODEL.md` — **the most important technical document here**
7. `docs/SECURITY.md` — §5 is the invite-only model; §12's checklist is short and load-bearing
8. `docs/TESTING.md` — the mandatory gates
9. `docs/GIT_WORKFLOW.md` — branch/PR/CI/merge workflow
10. `docs/COST_POLICY.md` — the zero-cost constraint and verified service matrix
11. `docs/ROADMAP.md` — milestones and their gates
12. `CLAUDE.md` — working rules and skill routing

Then run `git status` and `git log --oneline -10`.

## Product, in one paragraph

PokePortfolio is a private, invite-only application for tracking a Pokémon TCG collection as both
a collection and a set of financial records. It keeps a permanent spending ledger that survives
products being opened, cards being graded and items being sold, alongside market valuation and
portfolio history. Primary platform is an installed PWA on iPhone; desktop is first-class for
bulk work. Expected scale: 1–10 users, potentially 10 000+ cards each.

## Constraints that are not negotiable

| Constraint | Detail |
|---|---|
| **Budget: target $0/month, $50 USD lifetime ceiling** | The ceiling (D-027) is **not** pre-authorized spending — every purchase still needs individual owner approval per [COST_POLICY.md](docs/COST_POLICY.md) §1a, and nothing may be spent before the free functional baseline (§1b) exists. Actual spend to date: **$0**. When a feature cannot be built well for free, **postpone it**. Never enter payment details or enable billing without that approval. |
| **Repository stays private** | Never change visibility. Requires owner approval plus a completed [PUBLICATION_CHECKLIST](docs/PUBLICATION_CHECKLIST.md) pass. |
| **No real data in Git** | All fixtures synthetic. The owner's actual collection never enters the repository. |
| **Financial and authorization tests are gates** | A milestone touching money or ownership is not done until both suites pass. |
| **Absent data is displayed as absent** | Missing cost is never `0`. Missing price is never `0`. A missing result renders as **—**. |

## Decisions a new session must not accidentally reverse

Full context in [docs/DECISIONS.md](docs/DECISIONS.md).

1. **Every physical card is trackable** — energies, commons, duplicates, unpriced cards. (D-017)
2. **Lot-based cost basis.** `card_variant` → `holding` → `acquisition_lot`. (D-001)
3. **Cost basis is a state**, not a nullable number. (D-002, D-020)
4. **Price history is keyed per card variant, never per copy.** (D-019)
5. **Manually costed openings create a real provisional purchase**, voided when the receipt
   arrives. Money counted exactly once. (D-021)
6. **Email + password**, not OTP — the built-in mail provider allows 2 emails/hour. (D-022)
7. **Four distinct grouping concepts**: storage location, custom collection, tag, smart filter.
   (D-018)
8. **Collection value is the primary dashboard figure.** (D-023)
9. **Scanner ships before openings** post-MVP. (D-024)
10. **JSON backup is in MVP**, versioned. (D-025)
11. **No condition multipliers.** (D-009) · 12. **No fabricated price history.** (D-008)
13. **Raw prices never value graded cards.** (F10)
14. **Vite SPA, not a meta-framework.** (D-004)
15. **Scanner owns one route and one MediaStream.** (D-006)
16. **`user_id` denormalised onto child tables.** (D-011)
17. **Admin has no application access to other users' data.** (SECURITY §4)
18. **The $50 lifetime ceiling is not standing spending authorization.** (D-027)
19. **Invite-only is two server-side gates, and the auth hook denies unconditionally.** (D-028)
20. **Invitations bind to an address; redeemed accounts are created already confirmed.** (D-029)
21. **Invitation tokens are SHA-256, not a password hash.** (D-030)
22. **Invitation management is a Postgres RPC; only redemption is an Edge Function.** (D-031)
23. **Password policy is length-only: minimum 12, no composition rules.** (D-032)
24. **`card_variants` identity is finish + stamp + subtype, not one enum.** (D-033)
25. **Provider ids are scoped per language; marketplace product ids are not per-variant identity.**
    (D-034)
26. **Catalog ingest is gated by an operator secret, not a user session.** (D-035)
27. **Storage location lives on the acquisition lot, not the holding.** (D-036) — a shared holding
    cannot represent identical copies split across two physical locations.
28. **A holding has three possible identity sources** — `card_variant_id` / `sealed_product_id` /
    `manual_card_id` — **exactly one non-null.** (D-037) `manual_card_definitions` is the
    user-private fallback for a catalog-missing card; never written into the shared catalog.
29. **`lot_origin`/`cost_basis_state` gained `opening`/`trade_in`/`unallocated_opening`/`trade_in`
    ahead of M16/M18**, without the `opening_id`/`trade_line_id` linking columns those milestones
    still own. (D-038) A "Pulled" lot has no opening reference yet; that is expected, not a bug.
30. **Supabase key model migrated to `sb_publishable_…`/`sb_secret_…`; legacy `anon`/`service_role`
    is deactivated, not deleted, and was not rotated via the JWT signing secret.** (D-039)

## Architecture

| Layer | Choice |
|---|---|
| Frontend | Vite · React 19 · TypeScript strict · TanStack Router + Query |
| UI | Tailwind v4 · shadcn/ui on Base UI, copied in and owned |
| Charts | `lightweight-charts` — **validate with a spike before building the dashboard**; fallback visx |
| Backend | Supabase — PostgreSQL + RLS, Auth, Edge Functions, `pg_cron`, free plan |
| Auth | Email + password, invite-only, enforced by two independent server-side gates |
| Catalog + raw prices | TCGdex (free, no key) — Cardmarket EUR, TCGplayer USD |
| FX | Norges Bank EXR API |
| Sealed + graded value | Manual valuation — no free EUR source exists |
| Hosting | Cloudflare Pages, static — deployed since M4.1, `pokeportfolio-dev.pages.dev` |
| Money | Integer minor units + ISO 4217. Never float. |

## How invite-only actually works

Full detail in [docs/SECURITY.md](docs/SECURITY.md) §5. The shape a new session needs:

**Gate 1 — the Before User Created auth hook.** `public.before_user_created` rejects *every*
invocation. GoTrue calls this hook from every self-service account-creation path and from none of
the Auth Admin API — verified against the `supabase/auth` source, recorded as R21. So the hook needs
to inspect nothing: there is no metadata to forge and no window to race. It lives in
`supabase/config.toml`, so it reaches a project through `supabase config push`, never a dashboard
toggle.

**Gate 2 — a `BEFORE INSERT` trigger on `auth.users`** requiring a live `invitation_claims` row
(invariant S2). Travels with the migrations, and closes what the hook does not: the Auth Admin API
and the dashboard.

**Consequence a new session will hit immediately:** `auth.admin.createUser` no longer works on its
own, for anyone. Creating a user means issuing an invitation, claiming it, creating, finalizing —
all service-role-only. `tests/db/setup.ts` already does this; use `createSyntheticUser`.

**Why not the obvious design.** A hook that allowed signup for any address holding a valid
invitation would let whoever knew that address set the password before the invited person opened
their link. Knowing an address is not possessing a token. Do not "simplify" toward that.

## The thing most worth knowing before touching the schema

**A `GRANT` adds; it never restricts.** M3 wrote a column-restricted `UPDATE` grant on `profiles`
intending to exclude `is_admin`, and on the deployed project — which auto-grants the Data API roles
broad privileges on new tables — it excluded nothing. A signed-in non-admin could set their own
`is_admin` flag while the authorization suite was green.

Every privilege is expressed as **revoke, then grant**, and M4.1 made that converge from a project
that starts out wrong rather than only from an empty one
(`20260820140000_m41_privilege_baseline.sql`). What a new session must actually do:

**Any migration that creates a table, view or function in `public` ends with an explicit
`revoke … from anon, authenticated` and grants back exactly what is intended — and updates the
expected set in `scripts/grant-audit.sql`.** CI fails otherwise, deliberately. An object with no
privilege decision is a defect, not a default. `SECURITY.md` §5.9 has the whole picture; the short
version is that the intended surface is stated in three independent places and any one of them can
fail the build.

Two facts that will otherwise cost you an afternoon:

- **The auto-exposure mechanism is `ALTER DEFAULT PRIVILEGES`, not only an event trigger.**
  `pg_default_acl` carries entries owned by `supabase_admin` granting `anon` and `authenticated`
  everything on new objects in `public`, locally and on the hosted project. They cannot be revoked
  (`postgres` is not a member of that role) and do not need to be — a default privilege attaches
  only to objects its own role creates, and everything in `public` here is created by `postgres`.
  The audit accepts that one grantor and fails on every other. Do not "fix" it.
- **CI is a reproducibility gate, not a statement about a deployed project.** Run the deployment
  gate in SECURITY.md §13 after any deploy touching auth, policies or grants — including
  `scripts/grant-audit.sql` pasted into the Supabase SQL editor, which is the check that would have
  caught the escalation before a user could.

## M5 — Catalog, ingest and search

**TCGdex, REST, re-verified 2026-08-20** (API_SOURCES.md, RESEARCH.md R24-R27) — GraphQL and a bulk
database dump were both evaluated and rejected (GraphQL's list queries have no language argument
and its docs are unfinished; no bulk export exists). No key, no cost, no rate limit hit across the
full ingest.

**Two real schema defects found and fixed before M6 needed them not to exist** (D-033/D-034,
PROJECT_JOURNAL.md): `card_variants` identity is now `finish` + `stamp` + `subtype`, not the single
`variant_type` enum M3 shipped — a real card (Base Set Charizard) is holo, shadowless and
first-edition at once, which the old enum could not represent. Provider-id uniqueness on
`card_series`/`card_sets`/`cards` is scoped to `(language, tcgdex_*_id)`, not global — TCGdex reuses
ids like `neo1` across English and Japanese. `card_variants.cardmarket_product_id`/
`tcgplayer_product_id` are no longer unique — a marketplace can price two finishes under one product
id.

**Ingest:** `supabase/functions/sync-catalog`, one `(language, set)` per invocation, bounded
concurrency 5 for card detail, idempotent (upserts on the corrected keys), Pokémon TCG Pocket
excluded via `serie.id === "tcgp"` (checked server-side). Gated by `CATALOG_SYNC_SECRET`
(D-035) — an operator bearer secret, not a Supabase platform key and not reachable from the browser
bundle. `scripts/run-catalog-sync.mjs` drives a full sync set-by-set. Command in "Commands" below.

**Search:** `public.search_cards(p_query, p_language, p_limit, p_offset)`, `SECURITY INVOKER`,
ranks `cards` joined to `card_sets` by trigram similarity plus a heuristic split of a trailing
collector-number token (`"Base Set 4"`, `"Charizard 4/102"`). Trigram indexes on both `cards.name`
(M3) and `card_sets.name` (M5). Browser-verified against the real remote catalog: English/Japanese
name search, short (2-char) queries, set+number combined queries, language filter, card detail with
real multi-variant data, mobile viewport — desktop and mobile both clean.

**UI:** `/catalog` (search) and `/catalog/$cardId` (detail), both behind `RequireSession`. No
"Add to collection" — that is M6.

**Deployed and verified.** PR #9 merged; Cloudflare rebuilt `main` (bundle `index-w9CHprYD.js`).
`node scripts/deployment-check.mjs` 27/27, `scripts/remote-security-check.mjs` 17/17,
`grant-audit.sql` clean against the live catalog — all three re-run after the merge, not assumed
from the pre-merge state. A second throwaway synthetic account
(`m5-deploy-verify@example.invalid`, deleted after use) redeemed a real invitation on the actual
`pokeportfolio-dev.pages.dev` origin and ran a real search there, confirming the deployed bundle —
not just the local dev server — talks to the real catalog correctly.

**Full ingest counts (English + Japanese, into `pokeportfolio-dev`):** English — 20 series, 199
sets, 20,946 cards, 32,857 variants, 568 Energy cards. Japanese — 14 series, 175 sets, 11,744 cards,
14,226 variants, 197 Energy cards. Total: 32,690 cards, 47,083 variants. 9,300 cards (28%) have no
provider image; 695 (2%) have no rarity — both stored as `NULL`, never a placeholder. Six sets
(`swsh9.5tg`/`swsh10.5tg`/`swsh11.5tg`/`swsh12.5tg`, `ja/sn10a`, `ja/sn11`) never ingested — a
TCGdex-side edge/CDN inconsistency specific to the Edge Function's network path, confirmed by a
same-moment direct request from this development machine succeeding where the function's did not;
re-running `scripts/run-catalog-sync.mjs --only=<setId>` later is expected to pick them up. Separately,
72 sets have a non-zero `cardCount` but a genuinely empty `cards[]` array in TCGdex's own response
(verified directly) — a provider data gap, not an ingest defect, accounting for ~5,451 of the
~5,480-card difference between summed provider counts and actual ingested cards. Full reconciliation
detail and the 4 sets with small partial gaps: `ai_outputs/Claude_outputs/output_9.txt`. Per-set log:
`catalog_sync_runs`.

**Known limitations, not bugs:** the name+number search split is a heuristic, not a parser — it
covers the product spec's named examples, not arbitrary phrasing. Sealed products, price snapshots
and card images are out of scope (M11/M9/never-cached-locally respectively). Card artwork is
hotlinked from `assets.tcgdex.net`, never copied into Supabase Storage or committed — same
considered-not-established licensing position as before M5, restated in API_SOURCES.md.

**The key-exposure incident flagged here is resolved as of M6** — see "Security: key migration"
immediately below. It is kept in this document's history rather than deleted so a future session
understands why the key model looks the way it does.

## M6 — Collection: holdings, lots, origin and cost

Search a card, add it to the collection, record how it was acquired and (where applicable) what
it cost, see it in `/collection`, add another copy later without losing the first lot's
provenance, inspect the lots behind a holding. See DECISIONS.md D-036–D-039 for the four material
decisions and PROJECT_JOURNAL.md (2026-08-21 entries) for what real deployment verification found
and fixed.

**Manual card fallback (D-037).** `holdings` now has three possible identity sources —
`card_variant_id` / `sealed_product_id` / `manual_card_id` — exactly one non-null. A manual card
(`manual_card_definitions`) is the honest answer for a physical card the shared catalog does not
list: name, set name, collector number, language, finish, stamp, subtype, notes — no provider id,
no rarity, no price, no image requirement. User-private, never written into the shared catalog,
never visible to another user. Reachable from `/catalog`'s empty-search state and from
`/collection/manual/new`.

**Storage location relocated to the lot (D-036).** `holdings.storage_location_id` moved to
`acquisition_lots.storage_location_id` — a real two-binder scenario proved the original
one-per-holding cardinality couldn't represent identical copies split across two locations.
`profiles.default_storage_location_id` keeps its role as a prefill default, now for new lots.

**Origins pulled forward (D-038).** `lot_origin` gained `opening` (UI label "Pulled") and
`trade_in`; `cost_basis_state` gained `unallocated_opening` and `trade_in` — ahead of their
originally-planned M16/M18 arrival, required by D-017. Neither `opening_id` nor `trade_line_id`
exists yet; those columns and the linking workflow are still M16's/M18's. A full
origin → permitted-cost-basis-state mapping replaces the M3 gift-only check
(`acquisition_lots_origin_cost_state_consistency`).

**Manual valuations (pulled forward from M11).** `manual_valuations` — append-only, superseded via
`set_manual_valuation(p_holding_id, p_value_minor, p_note, p_effective_from)`, currency fixed to
NOK pending FX (M9). Wired to graded holdings in the M6 UI; the resolver (manual → fresh → stale →
missing) stays M9's, since M6 has no other price source to resolve against.

**The atomic surface.** `add_card_acquisition` (SECURITY INVOKER) finds-or-creates the
identity-matching holding — race-safe via the real `holdings_identity` unique index, catching
`unique_violation` and re-reading rather than locking — and writes one acquisition lot, plus a
real single-line `purchases`/`purchase_lines` row when the cost is known (not "provisional" — a
complete, ordinary purchase as far as it goes; M8 adds richer multi-line purchases over the same
tables). `void_acquisition_lot` is the mistake-correction path: void semantics, and voids the sole
purchase a known-cost lot exclusively created so a corrected mistake never leaves a ghost spend in
`GPO`/`CS`. `holding_summaries` (`security_invoker` view) gives the Collection list one query.

**UI (as originally shipped in M6; superseded by M7's Portfolio browsing surface — see "M7 —
Portfolio" below for the current routes and behaviour):** `/collection` (2-column mobile grid,
hardcoded pending M7's density setting), `/collection/$holdingId` (identity, lots, void,
favourite, manual value), `/add` (progressive form: quantity, raw/graded, origin-driven cost
disclosure, storage, favourite, notes), `/collection/manual/new`. "Add to collection" lived on
each variant in `/catalog/$cardId`.

**Security: key migration (D-039).** `pokeportfolio-dev` moved to named
`sb_publishable_…`/`sb_secret_…` keys, closing out the M5 exposure note. `VITE_SUPABASE_ANON_KEY`
renamed to `VITE_SUPABASE_PUBLISHABLE_KEY` everywhere (code, `.env.example`, CI, Cloudflare env).
Both Edge Functions read `SUPABASE_SECRET_KEYS` first (`supabase/functions/_shared/service-key.ts`),
falling back to the legacy `SUPABASE_SERVICE_ROLE_KEY` only because the *local* stack still emits
it. **The legacy `anon`/`service_role` pair is deactivated on the real project as of this
milestone** — verified working end to end *before* deactivation and *again after* (33/33 remote
checks, real redemption + real add-to-collection flow, both times), reversible if ever needed.
Never rotated via the JWT signing secret, so no user session was invalidated.

**Two real bugs found by testing against the actual deployed project, not by CI** (CI was green on
both before the real test ran):

1. `add_card_acquisition`/`set_manual_valuation`/`void_acquisition_lot` were anon-callable despite
   no direct grant — PostgreSQL grants EXECUTE on a new function to `PUBLIC` by default, a separate
   ACL entry from anything later revoked from `anon` by name. Same defect class M4 already found
   and fixed (`20260820120040_m4_explicit_function_revokes.sql`); these three just skipped the
   "revoke from public at creation" step every other function-creating migration follows. Fixed in
   the same migration, `grant-audit.sql` unaffected (it never modelled a `PUBLIC` grant either way
   — a known limitation of that check, not a new one).
2. `holding_tags.user_id`/`manual_valuations.user_id` had no `ON DELETE` action, so deleting an
   account that had tagged a holding or set a manual valuation failed outright. Same defect class
   M4 fixed for the original eight `user_id → auth.users(id)` references. Fixed
   (`20260821130000_m6_user_id_cascade_fix.sql`), verified by actually deleting a synthetic account
   with one row in every M6 table against the real project (cascaded cleanly, zero orphans), and a
   new regression test now exists for account-deletion cascade generally
   (`tests/db/m6_constraints.test.ts`) — the first such test in the suite for *any* table.

**CI privilege-baseline fragility fixed (SECURITY.md §5.9's own flagged issue).** The hostile-grant
convergence step no longer hardcodes a baseline migration filename — it selects the
lexicographically-latest `*_privilege_baseline.sql` and fails outright if none exists.
`20260821120100_m6_privilege_baseline.sql` is the current one.

**Deployed and verified.** PR #11 (M6 feature) and PR #12 (the cascade fix) merged; Cloudflare
rebuilt `main` after the Cloudflare env var was updated to `VITE_SUPABASE_PUBLISHABLE_KEY` and the
deployment was manually retried (env var changes don't trigger a rebuild on their own).
`deployment-check.mjs` 27/27, `remote-security-check.mjs` 33/33 (with `INVITE_TOKEN` — full
redemption phase), `grant-audit.sql` clean against the live project (`supabase db query --linked`).
Three synthetic `.invalid` accounts exercised the real flow (search, purchased card, reused
holding, manual card, graded card + manual value, bulk Energy ×12, Collection aggregation) against
the actual deployed bundle and actual ingested catalog, then were deleted — zero residue, checked
directly.

**Known limitations:** `database.types.ts` was regenerated from CI's artifact this session (no
local Docker to run `pnpm db:types` directly) — diffed field-for-field identical to a careful
hand-authored version first, so this is the same trustworthy output the command would have
produced. Session defaults for fast repeated entry (UX_FLOWS.md F2.1) are not implemented — the
RPC's argument shape was designed so the scanner (M15) can supply them later without a
business-logic change, but nothing pre-fills them yet. The mobile bottom navigation with a central
quick-add (the frozen UX plan) is not built; AppShell still carries a plain top-nav header — M7
owns navigation refinement once there is more to navigate. No dedicated `frontend-design` skill
pass was run; the Collection UI matches the existing Catalog/Auth screens' established Tailwind
patterns directly, consistent with DESIGN_SYSTEM.md §0's "provisional, not final" phase.

## Environment

| Item | State |
|---|---|
| Node.js | 24.19.0 LTS, **not on this machine's default PATH** — prepend `C:\Program Files\nodejs`. |
| pnpm | 10.15.0. Installed via `npm install -g` into `%APPDATA%\npm`, which is **also not on the default PATH** — prepend both, or call binaries directly (`.\node_modules\.bin\supabase.CMD`). |
| TypeScript | **6.0.3, deliberately not 7.x** — `typescript-eslint` peer-caps at `<6.1.0`. |
| Git | 2.51.1 · GitHub CLI 2.97.0, authenticated as `Oskarhn` |
| Docker Desktop | Still not installed. Not a blocker — CI runs the full local Supabase stack on `ubuntu-latest`. `supabase db push` warns about it harmlessly. |
| Supabase CLI | 2.114.0, pinned as a devDependency. **Authenticated** as of M4. |
| Playwright browsers | chromium + webkit installed locally. |
| Cloudflare | **Pages project `pokeportfolio-dev`, Free plan, no payment method.** Git-connected to `main`; preview deployments off. Nothing to install locally — deployment happens on merge. |
| psql | **Not on this machine.** The privilege audit runs in CI, or in the Supabase SQL editor against a deployed project — or, found during M5, `pnpm exec supabase db query --linked -f <file.sql>`, which runs arbitrary SQL against the linked remote through the CLI's own authenticated session. No `psql`, no database password. Same trust level as the SQL editor: privileged and deliberate, never for routine schema changes. |

## Remote Supabase project

| Item | Value |
|---|---|
| Name | `pokeportfolio-dev` — **development only**, never production |
| Ref | `nopmkroeygmlvndzjjqs` (a public identifier, not a secret) |
| Region | **`eu-west-3` (Paris)**, not the `eu-north-1` the docs planned. EU either way, so GDPR posture is unchanged and ~20 ms of latency did not justify recreating it and re-entering a database password. A future production project should still choose deliberately rather than inherit this. |
| Plan | **Free. No payment card. No billing enabled.** |
| Postgres | 17.6 |
| State | All migrations applied (15 through M4.1, +7 for M5, +10 for M6) · `config push` done, so the auth hook is live and `site_url` names the deployment · `redeem-invitation` and `sync-catalog` deployed (current code, reading `SUPABASE_SECRET_KEYS`), with `ALLOWED_ORIGINS`/`CATALOG_SYNC_SECRET` set · `scripts/grant-audit.sql` clean against the live project (verified via `supabase db query --linked`) · `scripts/remote-security-check.mjs` 33/33 · shared catalog populated with the real English + Japanese physical card set (M5) · **legacy `anon`/`service_role` keys deactivated (M6, D-039)** — the project now authenticates browsers via `sb_publishable_…` and Edge Functions via `sb_secret_…` only |
| Accounts | The owner's administrator account, and nothing else. Synthetic test accounts use the RFC 2606 `.invalid` TLD and are removed after use. |

**The remote is never the source of truth.** Schema and security live in `supabase/migrations/` and
`supabase/config.toml`. A clean environment must be reconstructible from the repository plus
secrets. If you find drift, reconcile toward the repository.

### Secrets, conceptually — never values, never in this file

| Secret | Where it lives |
|---|---|
| Database password | The owner's password manager. Claude has never seen it. |
| Supabase CLI access token | The CLI's own credential store, created by `supabase login`. |
| Publishable key (`sb_publishable_…`, M6) | `.env.local` (gitignored) and Cloudflare Pages env var `VITE_SUPABASE_PUBLISHABLE_KEY`. Public by design — it is embedded in every browser bundle served, which is exactly how this session obtained it to run the remote checks below, rather than via any key-listing CLI command. |
| Secret key (`sb_secret_…`, M6) | The Supabase platform only, injected into the Edge Function environment as `SUPABASE_SECRET_KEYS`. Never fetched into a session, never in the repo, never in `ai_outputs/`. |
| Legacy `anon`/`service_role` | **Deactivated** on `pokeportfolio-dev` as of M6 (D-039). Reversible from the dashboard if ever needed; not deleted. |

`.env.local` is filled in and points at the real project
(`https://nopmkroeygmlvndzjjqs.supabase.co` plus the current publishable key) as of M6. **Do not
run `supabase projects api-keys` to refresh it** — that command is what caused the M5 exposure this
milestone closed out. If the publishable key is ever needed again, it is safe to read directly out
of the deployed bundle (it is public by design) rather than from that command.

## Repository

- `https://github.com/Oskarhn/pokeportfolio` — **private**
- M1/M2 via [PR #1](https://github.com/Oskarhn/pokeportfolio/pull/1), M3 via
  [PR #2](https://github.com/Oskarhn/pokeportfolio/pull/2), M4 via
  [PR #3](https://github.com/Oskarhn/pokeportfolio/pull/3), M4.1 via
  [PR #5](https://github.com/Oskarhn/pokeportfolio/pull/5) plus real-device follow-ups
  [#6](https://github.com/Oskarhn/pokeportfolio/pull/6)/[#7](https://github.com/Oskarhn/pokeportfolio/pull/7)/[#8](https://github.com/Oskarhn/pokeportfolio/pull/8),
  M5 via [PR #9](https://github.com/Oskarhn/pokeportfolio/pull/9) plus a docs follow-up
  [#10](https://github.com/Oskarhn/pokeportfolio/pull/10), M6 via
  [PR #11](https://github.com/Oskarhn/pokeportfolio/pull/11) plus the cascade-fix follow-up
  [#12](https://github.com/Oskarhn/pokeportfolio/pull/12), M7 via
  [PR #14](https://github.com/Oskarhn/pokeportfolio/pull/14) plus the CSP fix
  [#15](https://github.com/Oskarhn/pokeportfolio/pull/15), M7.1 via
  [PR #18](https://github.com/Oskarhn/pokeportfolio/pull/18) plus the deployment-check fix
  [#19](https://github.com/Oskarhn/pokeportfolio/pull/19), M8 via
  [PR #21](https://github.com/Oskarhn/pokeportfolio/pull/21) plus the deployment-verification docs
  update [#22](https://github.com/Oskarhn/pokeportfolio/pull/22), M8.1 via
  [PR #23](https://github.com/Oskarhn/pokeportfolio/pull/23). All squash-merged, branches deleted.
- PR #4 was the deliberate negative security test — both invite-only gates disabled to prove the
  suite fails. Closed unmerged, branch deleted. It is not a mistake in the history.
- `ai_outputs/` is gitignored and must stay that way (per-model subfolders; global output
  numbering across models).
- `.claude/launch.json` and `.env.local` are gitignored and machine-local.

## Known issues and limitations

- **Node and pnpm are not on this machine's default shell PATH.** Prepend both, or call binaries
  directly. CI is unaffected.
- **TypeScript pinned to 6.0.3**, solely because `typescript-eslint` does not support TS 7 yet.
- **`src/lib/` does not exist yet** — deliberately, per the no-placeholder-directories rule.
- **Environment variables are baked into the Cloudflare bundle at build time.** Editing one in the
  dashboard changes nothing until a redeploy — and a wrong value fails silently, as a generic
  "Could not reach the server". `node scripts/deployment-check.mjs` exists because of exactly that.
- **A service worker serves the previous shell on the first load after a deploy.** `autoUpdate`
  takes over on the next load. Normal PWA behaviour, but it briefly makes a corrected deployment
  look uncorrected — reload before concluding anything about a fresh deploy.
- **The deployed CSP is exercised only on Cloudflare.** `vite dev` and `vite preview` ignore
  `_headers`, so a policy mistake is invisible locally. `deployment-check.mjs` is the compensating
  control; run it after any deploy.
- **`supabase_admin`'s default privileges in `public` cannot be revoked.** Documented above and in
  SECURITY.md §5.9. Safe, for a stated reason. Not a TODO.
- **Regenerate `src/data/database.types.ts` (`pnpm db:types`) in the same commit as any migration
  that changes the schema.** It is generated from CI's ephemeral stack, downloaded from the
  `database-types` artifact. M4.1's migration changes privileges only, so the file is unchanged.
  M6 had no local Docker to run `pnpm db:types` directly — the file was hand-authored to match the
  new migrations, then replaced with CI's actual generated artifact once green, confirmed
  field-for-field identical. If a future session again lacks Docker, that same
  hand-author-then-replace sequence is safe, provided the replacement step actually happens before
  the PR is treated as done.
- **The search-by-number heuristic is not a parser.** It splits a trailing collector-number-shaped
  token off the query text; it does not understand "the second Charizard" or similar phrasing. This
  is deliberate scope (M5 prompt §44), not a gap to close reflexively.
- **Card images are hotlinked from `assets.tcgdex.net`, never cached in Supabase Storage.** Same
  considered, re-examine-before-public-release licensing position as the rest of the catalog
  (API_SOURCES.md). An asset occasionally 404s; the UI falls back to a neutral placeholder rather
  than a broken-image icon.
- **Resolved as of M6:** an M5-session transcript contained `pokeportfolio-dev`'s legacy secret
  (`service_role`) key, exposed by `supabase projects api-keys` returning every key instead of just
  the anon one requested. Never used, stored or committed. The legacy pair (that key included) is
  now deactivated project-wide — see "M6 — Collection" above, D-039.
- **`add_card_acquisition`'s M6 fast-add flow is NOK-only.** No FX ingestion exists before M9, so a
  direct-purchase or manual-value amount in another currency has no honest NOK conversion to
  freeze yet. Foreign-currency direct entry is an M8/M9 concern, not a gap to close in M6.
- **Session defaults (UX_FLOWS.md F2.1) are not implemented.** Origin/condition/storage do not
  persist between adds within a session yet — every add currently starts from the same defaults.
  The RPC's argument shape was designed for the scanner (M15) to supply them later.

## Open uncertainties

None block M7. Detail in [docs/RESEARCH.md](docs/RESEARCH.md).

| # | Uncertainty | Needed by |
|---|---|---|
| U2 | Whether Cardmarket's public Product Catalogue covers Pokémon sealed, and its terms | Sealed valuation improvement |
| U4 | TCGdex price update cadence in practice | M9 |
| S6 | Whether camera permission survives an in-route session on current iOS | **Spike before M15** |
| S7 | Whether Basic Energy printings are distinguishable by image at all | M15 |
| — | Trade item-leg accounting rule: carryover vs fair value | M18 only |

~~U3 (TCGdex rate limits in practice)~~ — resolved by the M5 full-catalog ingest: no rate-limit
response across ~380 sets. ~~Whether TCGdex models Basic Energy printings adequately~~ — resolved:
yes, ordinary cards with `category = "Energy"`, ordinary variants; see "M5 — Catalog" above.

## M7 — Portfolio: organisation, display and navigation

Owner UI requirements pass (Prompt 11), implemented directly rather than deferred — see
"M7 verification state" above for what has and has not actually been run. Full detail:
`ai_outputs/Claude_outputs/output_11.txt`.

**Terminology (D-040).** The user-facing screen that browses owned cards is now **Portfolio**,
not Collection — navigation, headings, copy. `/collection`, `/collection/$holdingId` and
`/collection/manual/new` redirect to their `/portfolio` equivalents rather than disappearing.
Internal naming (`holdings`, `holding_summaries`, `add_card_acquisition`, the
`src/features/collection/` folder for the pages that did not structurally change) is unchanged —
see PRODUCT_SPEC.md's terminology note.

**Navigation, shipped for the first time.** Mobile bottom nav (Home, Search, Portfolio, More,
Profile, central **+**) and an equivalent desktop top nav — the frozen UX plan M6 explicitly
deferred. `src/features/nav/{BottomNav,DesktopNav,QuickAddMenu}.tsx`. Bottom-nav geometry
(six equal flex slots, an absolutely-positioned raised + button so five destinations coexist with
a genuinely centred action): DESIGN_SYSTEM.md §4.2. The + shows only what exists today — Search
cards, Add manually — never Purchase/Sealed/Sale/Scan/Opening before those milestones ship
(UX_FLOWS.md F11.1).

**Portfolio browsing.** Grid (density 1–4, mobile default 2 / desktop 4 — DESIGN_SYSTEM.md §4.1),
List, and Table (also on mobile, horizontally scrollable) — all three window their rows via
TanStack Virtual (`src/features/portfolio/{VirtualGrid,ListAndTableViews}.tsx`) over one
keyset-paginated RPC, `list_portfolio` (DATA_MODEL.md §14). Sort by is visible, ten options, and
`value_desc` is the permanent intended default — resolving to a graded holding's real manual
valuation and a deterministic name-ordered fallback for every raw card, never the acquisition cost
standing in for market value (DECISIONS.md D-041; this is the transitional pre-M9 behaviour to
re-examine only when M9's valuation resolver exists). Density/View/Sort chosen in the toolbar
persist to the profile (`collection_grid_density`/`collection_default_view`/
`collection_default_sort`) and are also reflected in the URL (`/portfolio?sort=...&density=...`)
so back-navigation and shared links behave.

**Filters.** Quick chips (Sort/Density/View buttons plus a Filters button showing the active
count) and a full filter sheet (`FiltersSheet.tsx`) share one state — condition, raw/graded,
grader, favourite, manual-only, custom collection, low value, missing value. Low value/missing
value are honestly scoped to a graded holding's manual valuation before M9 (D-041) — never a fake
raw-card figure.

**Custom collections.** `custom_collections`/`custom_collection_members` shipped exactly as
DATA_MODEL.md §5.2.1 already specified — plain owner-RLS tables, no RPC layer
(SECURITY.md §3.2.1). A horizontal chip row on the Portfolio page (`CollectionsBar.tsx`) makes
them discoverable without a detour through More; the same chip row's "+ Collections" opens
create/rename/delete. No drag-and-drop reordering (owner decision) — the ordinary Sort by control
works the same way inside a filtered collection.

**Search.** Renamed "Search" in navigation (route stays `/catalog`). Cards/Sets segmented control
— Sets is a plain `card_sets` read with real metadata (name, language, symbol, release date, card
count), no new RPC (`CatalogPage.tsx`, `SetDetailPage.tsx`). Every card result — in Cards mode or
inside a set — carries an independent quick-add **+** (`AddQuickButton.tsx`) that preselects a
card's only variant and jumps straight to `/add`, or opens card detail for a real choice among
several — the exact M6 add flow, reused rather than duplicated.

**Home/Profile/More.** `HomePage.tsx` shows only truthful current data (physical/graded/manual
counts) with an honestly-marked "Portfolio value — not available yet" panel reserved for M9/M12 —
no sample chart, no fabricated total. `ProfilePage.tsx`: display name (editable), email, admin
badge, theme, low-value threshold, sign out. `MorePage.tsx`: admin invitations (moved here from
the old top nav) plus a link into Profile — no disabled future-feature entries.

**Security.** Closed the PUBLIC-EXECUTE privilege blind spot M6's own journal entry had flagged as
unclosed (D-042, PROJECT_JOURNAL.md 2026-08-22) — proven in CI (hostile-grants convergence) and
against the real project (`grant-audit.sql` clean, `remote-security-check.mjs` 33/33). Separately,
browser-verifying the deployed build found the CSP's `img-src` had no external host, silently
blocking every card thumbnail in production since M5 — see "M7 verification state" above and
PR #15.

**Performance.** Verified against a real 7,500-holding/10,109-lot synthetic account on
`pokeportfolio-dev` — not simulated, not assumed from CI. The first version (`LEFT JOIN LATERAL`
per-holding aggregation) measured 5.5-8 seconds per call and two sort modes — including
`value_desc`, the permanent default — timed out outright. Rewritten as a `MATERIALIZED` CTE using
the same `LEFT JOIN ... GROUP BY` shape `holding_summaries` already uses; re-measured at
**130-570 ms** across every sort mode, the filtered query and keyset pagination
(`20260822120030_m7_portfolio_query_perf_fix.sql`, `20260822120040_m7_portfolio_counts_perf_fix.sql`
— full account in PROJECT_JOURNAL.md 2026-08-22). `scripts/portfolio-perf-benchmark.mjs` remains
the repeatable version of this same measurement for a future session with local Docker (it needs
the Supabase secret key, which this session never fetches — this run instead used
`supabase db query --linked` for seeding/cleanup and the publishable key for the timed calls).

**Known limitations, recorded rather than silently accepted:**

- The initial JS bundle is ~638 KB (180 KB gzipped) after adding TanStack Virtual and the M7
  feature set — a code-splitting pass (dynamic `import()` per route) would help but was not done
  this milestone; not a regression that blocks anything, just larger than ideal.
- The Table view's virtualization uses an absolutely-positioned `<tr>`/`display: block` `<tbody>`
  trick (the standard TanStack Virtual recipe for tables) — this is not fully semantic HTML table
  markup and may read slightly worse to a screen reader than a plain table; not accessibility-audited
  beyond the baseline (visible focus, real labels, 44px targets) this project already holds every
  surface to.
- Quick filter chips for Set/Value/Condition open the same full `FiltersSheet` rather than
  dedicated one-tap mini-pickers (M7 prompt §34 asked for "clean chips/buttons/popovers" without
  mandating three separate implementations) — a scope simplification, not a missing feature; the
  Graded chip is the one genuinely one-tap boolean toggle.
- No dedicated desktop popover/sidebar variant of the filter/sort/density panels — the same
  `Sheet` component (bottom sheet on mobile, centred modal on desktop) serves both, per
  DESIGN_SYSTEM.md §0's "provisional, not final" phase.
- `src/features/collection/` keeps its M6 name even though its three remaining pages
  (`HoldingDetailPage`, `AddToCollectionPage`, `ManualCardPage`) are reached from `/portfolio/...`
  routes now — deliberate minimal-churn choice (D-040), not an oversight.

## M7.1 — Owner UI/UX refinement

Not a numbered product milestone — a focused correction pass after the owner reviewed the
deployed M7 UI and gave substantial concrete feedback, applied before M8/M9/M12 build further
screens on top of a structure the owner had already flagged (DECISIONS.md D-043–D-046,
`ai_outputs/Claude_outputs/output_12.txt`).

**Navigation.** Bottom/desktop nav rebuilt to four destinations — Home, Search, Portfolio,
Profile — plus a central quick-add, symmetrical two either side of **+**, replacing M7's
five-tab-plus-spacer geometry. More is gone: `/more` redirects to `/profile`
(`src/features/more/` deleted); its one real function, admin invitations, moved into Profile,
still admin-gated. Global "PokePortfolio" wordmark removed from authenticated chrome — it now
appears only on Home's mobile view and the auth screens.

**Visual baseline.** The provisional blue/slate palette the owner flagged as "AI-generated" is
replaced by a neutral warm-graphite surface scale and a restrained bronze/copper accent
(DESIGN_SYSTEM.md §3.1's concrete token table). Implemented by rebinding Tailwind's own
`slate`/`sky`/`rose`/`emerald` palette tokens to CSS custom properties in `src/styles/index.css`
that flip for light/dark — every existing `bg-slate-900`/`text-sky-400`/etc. utility across the
whole codebase is theme-aware for free, with no per-component rewrite. Theme preference
(`profiles.theme`) now actually applies: `src/ui/theme.ts` sets `data-theme` on `<html>`, and
`index.html` carries a small inline bootstrap script so a returning user's explicit choice applies
before first paint. Radius bumped app-wide the same token-override way. Nav/sheets lightly
translucent (`backdrop-blur`).

**Home, Search, Portfolio, Profile** all substantially restructured per the owner's detailed spec
— see UX_FLOWS.md F0/F2.3/F8.4/F8.5/F10 and DESIGN_SYSTEM.md for the shipped shape, and F15/F16
for the two future specs (Trade Analyzer, Market Movers) recorded but not built. Highlights:

- Home: shared scope selector (Portfolio Main / a custom collection — same `custom_collections`
  model as Portfolio, never a second grouping system), currency preference, a value-privacy eye,
  a reserved value/chart panel, a "most valuable cards" section that only ever shows holdings with
  a *real* resolved value.
- Search: dominant top search bar, a camera/scanner affordance (honestly "not available yet", no
  permission request, D-006 still governs the real M15 implementation), a favourite filter reusing
  existing holding state, a real set-browsing carousel (newest sets first, by language), image-led
  card results.
- Card detail: image-first, then one rounded info panel; the set name is now a real link to
  `/catalog/sets/$setId`; a reserved (empty, honest) price-history slot.
- Portfolio: a "search in your portfolio" bar (server-side, reuses `list_portfolio`'s existing
  `p_query`), a favourite star, an action menu (Sort/Select), select mode with functional bulk
  actions (add/remove-to-collection, favourite — all purely organisational, C1), a real Portfolio
  CSV export (pulled forward from M13 in the narrow current-state-only sense — M13 still owns the
  full suite), and a new **card-number sort** (`number_asc`/`number_desc`, natural-sort ordering
  over real collector numbers, not a fabricated ranking key).
- Profile: rebuilt as the account/settings hub — working theme control, a European-pricing
  preference (`profiles.use_eu_pricing`, stored ahead of M9, genuinely inert until then), default
  Portfolio view/density, preferred card language, admin invitations, provider attribution, and a
  real app-version string sourced from `package.json` at build time (`__APP_VERSION__`).

**Database.** Four new migrations
(`20260823120000_m71_portfolio_sort_number_enum.sql` through
`20260823120030_m71_privilege_baseline.sql`): the `number_asc`/`number_desc` enum values, a new
`natural_sort_key(text)` IMMUTABLE SQL function, `list_portfolio`'s signature growing one trailing
cursor parameter (dropped and recreated, not `CREATE OR REPLACE`d — a new parameter changes a
Postgres function's identity), two new `profiles` columns (`hide_values`, `use_eu_pricing`), and a
restated privilege baseline. All four applied to `pokeportfolio-dev` via `supabase db push`.
`database.types.ts` was hand-updated to match (no local Docker, same pattern M6 used) — replace it
with CI's generated artifact the next time a session has Docker available, per that same
precedent.

**Deliberately not built**, recorded rather than silently skipped (BACKLOG.md, D-045/D-046):
profile-picture upload (needs SECURITY.md §7's storage safeguards — private paths, size/MIME
validation, re-encoding, EXIF stripping — that a quick implementation would have skipped), bulk
"Remove from Portfolio" (needs a real transaction-safe batch-void RPC that does not exist yet),
account reset/delete UI, portfolio share links, price alerts, Trade Analyzer, Market Movers.

**Bundle size.** M7's ~638 KB initial bundle (flagged as a known limitation) is now ~320 KB
(98 KB gzipped) via route-level code splitting (`React.lazy` in `src/router.tsx`) — Home/Profile/
auth stay eager, everything reached by navigating further in loads on demand. No new dependency.

**Verification, actually run against the real project and the real deployment, not just CI:**

- `pnpm typecheck`/`pnpm lint`/`pnpm format:check`/`pnpm test` (80 domain tests, unchanged) all
  green locally. `pnpm build` succeeds; bundle size measured from the real output.
- CI green on both PRs: `build-and-test` and `db-tests` (full migration application, hostile-grant
  convergence, the complete authorization suite including two new test files' worth of coverage
  for `hide_values`/`use_eu_pricing` and `natural_sort_key`/number sort).
- All four M7.1 migrations applied to `pokeportfolio-dev` (`supabase db push`).
- `scripts/grant-audit.sql` clean against the live project (`supabase db query --linked`).
- `scripts/remote-security-check.mjs` phase 1: 17/17 (no `INVITE_TOKEN` available this session —
  phase 2/full redemption not re-run; nothing in M7.1 touched the redemption path itself).
- `scripts/deployment-check.mjs` against `https://pokeportfolio-dev.pages.dev`: **found and fixed
  a real gap in the check itself** (PR #19) — it only ever scanned the single entry bundle for the
  correct Supabase project/no leaked secret/no source map, and M7.1's route-level code splitting
  moved most of that surface (including the shared Supabase client) into separate chunks the old
  check never looked at. Fixed to scan every chunk listed in the service worker's own precache
  manifest. Re-run after the fix: **28/28 checks pass**, a strictly wider check than before, not
  just a relabelled one.

**Not done this session, and why:** the deployed-UI walkthrough with a fresh synthetic account
that M6/M7 each did (search, add, browse, sign out, delete the account afterward) was **not**
performed this session. Creating an account and choosing/entering a password — even for a
throwaway `.invalid` synthetic fixture immediately deleted afterward — falls under this session's
own standing prohibition on creating accounts or entering passwords, which holds regardless of
project convention. Everything reachable *without* signing in (routing/guards, security headers,
the PWA manifest and service worker, the bundle's Supabase project/secret-key posture) was
verified live, above. What was **not** verified live: the actual rendered appearance of Home,
Search, Portfolio and Profile signed in, the theme toggle actually switching the palette, select
mode, and the CSV export producing a real file — all of that needs a real signed-in pass, which
is now folded into the single owner real-device ask below rather than a separate step.

## M8 — Purchases and the spending ledger

Turns M6's single-card fast-purchase path into a real multi-line ledger over the same
`purchases`/`purchase_lines` tables (DATA_MODEL.md §16, FINANCIAL_MODEL.md §1-4/§7, DECISIONS.md
D-047–D-050, PROJECT_JOURNAL.md 2026-08-24). Full detail: `ai_outputs/Claude_outputs/output_13.txt`.

**The write surface.** `create_purchase`/`update_purchase`/`void_purchase`/
`purchase_spending_summary()`, all `SECURITY INVOKER`, same shape as `add_card_acquisition`.
Shipping/customs/discount are allocated by `allocate_largest_remainder(bigint, bigint[])` — a SQL
port of `src/domain/allocation.ts`'s `allocate()`, proven byte-identical to it across a shared
corpus of cases (`tests/db/m8_purchase_ledger.test.ts`) — and the purchase's frozen NOK total is
*also* allocated across lines the same way, weighted by each line's original-currency attributable
cost, rather than rounding each line's NOK amount independently. That second detail is what keeps
invariant F1 (`GPO = CS + HS`) exact for a foreign-currency purchase; independent per-line rounding
can drift a few øre from a single rounding of the purchase total. E3 and E10 both reproduce exactly
against real persisted rows, not just the pure-TypeScript fixtures M2 already had.

**Editing is intentionally narrower than "edit anything" (D-047).** `update_purchase` can change
every purchase-level field (date, retailer, currency, FX, shipping/customs/discount, notes) and an
existing line's quantity/unit price/spend class/description, recomputing every allocation and — for
a line with an open lot — that lot's cost basis, atomically. It **cannot add or remove a line**:
`acquisition_lots.purchase_line_id` is a real foreign key with no cascade, so deleting a line with a
lot still attached would either orphan real inventory history or require silently voiding/creating
lots as a side effect of an amount correction. Void and re-enter is the correction path for a wrong
line set, same as "Purchase entered twice" in UX_FLOWS.md.

**Card/sealed lines always create inventory (D-048).** No per-line "skip holding" checkbox —
`bulk_lot` is the existing line type for money spent on a group before individual entry, and using
it avoids a purchase line that counts as collectible spend with nothing to trace it to.

**Downstream-blocker detection exists but is untested by any real product flow yet.** Both
`update_purchase` and `void_purchase` refuse to touch a purchase if any lot it produced has
`quantity_remaining <> quantity` (something has disposed part of it) — the correct general rule,
but nothing can trigger that state for real until a disposal-producing milestone ships (sales M10,
openings M16, grading M17, trades M18). The tests simulate it by directly setting
`quantity_remaining` under the service role. A future milestone adding a real disposal path does
not need to touch this guard logic — it will simply start being exercised for real.

**`void_acquisition_lot` corrected, not just extended (D-047's neighbour).** Its
auto-void-the-parent-purchase check used to count other live lots citing the *same purchase line*
before M8; that is only correct because every M6-created purchase has exactly one line. Widened to
count live lots anywhere in the whole parent purchase — a strict generalization, so every purchase
that already existed behaves identically, and a multi-line M8 purchase no longer has its entire
receipt voided as a side effect of correcting one card via the pre-existing per-lot void control.

**Foreign currency.** `fx_rates` (market data, `SELECT` for `authenticated`, writes only from the
new `fetch-fx-rate` Edge Function under the service role — a user's manual override never touches
this table). Norges Bank's endpoint/orientation re-verified live 2026-08-24 (API_SOURCES.md): the
returned number is NOK per one unit of the base currency, exactly `fx_rate_to_nok`; a date with no
trading (weekend/holiday) simply has no observation, which is what makes "use the most recent prior
business-day rate" correct by construction — the resolver requests a 10-day window ending at the
target date and takes the last observation, rather than guessing a fallback date. `fetch-fx-rate`
answers every business outcome as HTTP 200 with an `{ ok, ... }` body (D-049) — supabase-js does not
reliably surface a non-2xx Edge Function response, confirmed against the exact same client
`redeem-invitation`'s own integration already works around. E10 reproduces exactly (57123 NOK
minor units) using a fixed manual rate in tests — CI never depends on the live Norges Bank API;
`scripts/verify-norges-bank-contract.mjs` is the separate, manual, occasional real-API check
(never run in CI), and `tests/data/norges-bank.test.ts` is the deterministic no-network regression
that does run there, pinned against a real captured response.

**Grading lines are spend-only in M8 (D-050).** `grading_fee`/`grading_shipping` lines count
correctly in `GPO`/`CS` but do not attach to a lot's cost basis — `target_lot_id`/
`lot_cost_adjustments` remain M17's, unchanged from DATA_MODEL.md §12's original sequencing; nothing
found while building M8 contradicted it.

**Two pre-existing, previously-unexercised gaps found and fixed** (same defect class as the M4/M6/
M7 `user_id`-default/PUBLIC-EXECUTE findings): `retailers.user_id` had no `default auth.uid()` since
M3 (M8 is the first feature to create a retailer from the client); `purchases.retailer_id` had no
ownership-check trigger at all (M8 is the first to set it from client input). Both fixed with a
dedicated migration each, following the established `*_check_owner()` trigger pattern.

**UI.** `/purchases` (ledger + GPO/CS/HS summary), `/purchases/new` (multi-line editor — catalog or
manual card search, sealed product picker, accessory/fee/shipping/customs/other lines, retailer
picker with inline create, foreign-currency FX section, live allocation preview computed with the
same `allocate()`/`allocateMoney()` domain functions the database RPC's SQL port reproduces),
`/purchases/$purchaseId` (every line's allocation and attributable cost visible), 
`/purchases/$purchaseId/edit` (D-047's narrower scope). Reachable from the central + menu ("Record
purchase") and a new Home "Total spent" shortcut — not a new bottom-nav tab. M6's existing
single-card fast-purchase flow (`/add`) is untouched and its purchases appear in the M8 ledger
without any migration or re-save, counted exactly once.

**Known limitations, recorded rather than silently accepted:**

- A foreign-currency multi-quantity `card` line's lot-level per-unit NOK cost basis can be up to one
  øre short of the line's exact NOK total (no separate NOK residual column on `acquisition_lots`,
  only one in the lot's original currency) — narrow enough (multi-quantity + non-NOK + card line,
  simultaneously) that it was not judged worth the schema churn. Never visible in `GPO`/`CS`/`HS`,
  which are computed from `purchase_lines`, not from lots.
- The sealed-product line picker is a plain `<select>` over the whole curated `sealed_products`
  table — a full sealed catalog browsing/search UI is M11's, not built here (M8 prompt §22).
- Editing cannot change a purchase's currency in the shipped UI (the RPC itself accepts a new
  currency; the form just doesn't offer changing it) — a defensible simplification, not a database
  limitation.
- No receipt image upload/OCR (out of scope, M8 prompt §72).

**Verification, actually run, not just described:**

- `pnpm check` (typecheck/lint/format/85 domain+property+data tests, up from 80 — the new
  `tests/data/norges-bank.test.ts`) green locally; `pnpm build` green (placeholder env);
  `pnpm test:e2e` **58/58** (up from 50 — four new `/purchases*` guard cases × desktop+iPhone).
- CI green on PR #21: `build-and-test` and `db-tests` — **320 database/authorization tests across
  21 files** (up from 269/19 at M7), including the hostile-grant convergence proof. One real CI-only
  finding, fixed on the branch before merge: two *pre-existing* test fixtures
  (`tests/authorization/purchases.test.ts`, `tests/authorization/holdings_and_lots.test.ts`) inserted
  a `purchase_lines` row directly, relying on `attributable_cost_minor`'s default of 0 while
  `line_total_minor` was non-zero — the new `purchase_lines_attributable_cost_matches_allocation`
  CHECK correctly rejects that shape; the fixtures were updated to state the invariant explicitly,
  nothing about the constraint changed.
- Before pushing migrations: queried the real `pokeportfolio-dev` project directly
  (`supabase db query --linked`) to confirm zero existing rows would violate either new CHECK
  constraint — the project currently holds **zero purchases**, so both validated trivially, but this
  was confirmed rather than assumed given the constraints touch every existing purchase row.
- All five M8 migrations applied to `pokeportfolio-dev` (`supabase db push`); `grant-audit.sql`
  clean (`supabase db query --linked`); `remote-security-check.mjs` **17/17** (phase 1 — no
  `INVITE_TOKEN` available this session, same as M7.1); `fetch-fx-rate` deployed
  (`supabase functions deploy fetch-fx-rate --use-api`) and confirmed to reject a request with no
  user JWT (`HTTP 401` via a direct `curl`, proving `verify_jwt = true` is actually enforced, not
  just declared in `config.toml`); `deployment-check.mjs` **28/28** against the real rebuilt bundle
  after merge (34 precache entries including all four new `Purchase*` chunks — confirmed the
  service-worker manifest genuinely updated, not stale, by polling until the new chunk names
  appeared).

**Not done this session, and why:** no signed-in deployed walkthrough. Creating or signing into even
a throwaway `.invalid` synthetic account is outside what this session performs, regardless of
project convention (same boundary M7.1's session already documented). Everything reachable
*without* signing in was verified live, above.

## M8.1 — Portfolio correction / Purchase discoverability

Not a numbered product milestone — a focused correction pass after the owner tested the deployed
M8 build and reported two concrete usability gaps: no way to remove an accidentally-added card from
Portfolio, and no clear way to find or create a Purchase despite M8 shipping the ledger. Full
detail: `ai_outputs/Claude_outputs/output_14.txt`, DECISIONS.md D-051.

**The audit found a real bug before any UI was built.** The prompt required auditing
`void_acquisition_lot`'s M8-era parent-purchase auto-void rule against a mixed receipt before
wiring bulk removal to it. The check only ever counted *other live lots* on the purchase — correct
exactly when every line produces a lot (true for M8's own "two-card purchase" test), wrong the
moment a purchase has a line that never produces one at all (`accessory`,
`shipping_standalone`/`customs_standalone`, `grading_fee`/`grading_shipping`, `bulk_lot`, `other`).
Voiding the sole card lot in a card+accessory purchase made the check see zero other live lots and
auto-void the *whole* receipt, silently erasing the accessory's real, unrelated spend from
`CS`/`HS`/`GPO`. Corrected to count *lines*, not lots: auto-void the parent purchase only when
every other line is already accounted for (a card/sealed line whose own lot is also voided, or no
other line exists) — a strict generalization, so every purchase that existed before this migration
behaves identically, and only the wrong case changes. Regression test:
`tests/db/m8_purchase_ledger.test.ts`, "never auto-voids a purchase while an accessory line still
represents real spend".

**A second, related gap, also fixed:** `void_acquisition_lot` never checked `quantity_remaining`
before voiding — `update_purchase`/`void_purchase` already refuse to touch a purchase with a
partially-disposed lot; the same guard now exists on a single lot's void too. Currently unreachable
through any real product flow (no disposal-producing milestone has shipped — same caveat HANDOVER
already records for those two), implemented pre-emptively.

**Remove from Portfolio.** `remove_holdings_from_portfolio(uuid[])` (SECURITY INVOKER) is the new
atomic, all-or-nothing bulk surface — BACKLOG.md's deferred `bulk_void_lots(uuid[])` item (D-045),
now shipped. It voids every live lot of every given holding by calling the corrected
`void_acquisition_lot` itself, so the parent-purchase correction above applies uniformly whether a
holding is removed individually (the pre-existing Holding Detail "Void" button, which inherits both
fixes for free) or in bulk. The only way a holding can be "blocked" is the same
`quantity_remaining` guard; when any selected holding is blocked, the whole call performs zero
mutations and reports which holdings and why — never a partial removal. Portfolio's `BulkActionsBar`
gained a "Remove" button and two sheets: a confirmation (holding/physical-copy counts, the
correction-not-sale disclaimer) and a blocked-results sheet. **A multi-line purchase never blocks
removal** — the corrected auto-void rule already keeps the purchase and its unrelated spend intact
without the user needing to visit the purchase page first; this was a deliberate departure from the
prompt's initial "block for any multi-line purchase" framing, made after finding M8's own
already-shipped two-card-purchase test asserts the opposite (voiding one card's lot while the
purchase stays alive is intended behaviour, not a gap) — see D-051's "Alternatives" for the full
reasoning.

**Purchase discoverability.** The architecture was already correct (central + menu, a Home
shortcut, `/purchases` empty state) — M8.1 made it *obvious*: the + menu reordered to Add card /
Record purchase / Add card manually / Scan card with clearer one-line descriptions; Home's spending
row now reads as a link ("Purchases — View your receipts →") rather than an unexplained figure; the
purchases empty state and the new-purchase form both explain the concept in one sentence; saving a
purchase now shows a dismissible "Purchase recorded" banner with a Portfolio link on the detail page
it already navigated to (`?created=true`, `purchaseDetailRoute`'s new `validateSearch`). The
"market pricing not available yet" copy on Portfolio/Home was already in place from M7.1 —
confirmed adequate, not touched (never on every card, never mentions a milestone number).

**Database.** One migration pair
(`20260825120000_m81_void_acquisition_lot_fix.sql`,
`20260825120010_m81_privilege_baseline.sql`): the two `void_acquisition_lot` fixes above, the new
`remove_holdings_from_portfolio` function, and the restated privilege baseline. Both applied to
`pokeportfolio-dev` (`supabase db push`).

**Known limitation, found while verifying.** `src/data/database.types.ts` cannot be blindly
replaced with a fresh `supabase gen types` / CI artifact — diffed this session against the real
CI-generated output and found one deliberate, pre-existing divergence: `create_purchase`/
`update_purchase`'s `p_fx_rate_to_nok` is hand-typed `string` (the app passes a decimal string,
`src/data/purchases.ts`, to avoid float imprecision on a `numeric(18,8)` parameter) where the
generator infers `number`. Blindly overwriting with a fresh generated file breaks the build
(`src/data/purchases.ts` no longer typechecks). A future session with Docker regenerating this file
must re-apply that one field's type by hand afterward, same as the rest of the file already is.
Every other diff found (nullability on `list_portfolio`'s return columns, `id?: never` vs
`id?: number`, minor formatting) is a harmless, long-standing generator-output quirk, not something
introduced this session — `remove_holdings_from_portfolio`'s own added type block matched the CI
artifact exactly except this same nullability quirk on `blocked_reason` (harmless: the client
already overrides the type via `.overrideTypes()`, `src/data/collection.ts`).

**Verification, actually run, not just described:**

- `pnpm check` (typecheck/lint/format/85 domain tests, unchanged — M8.1 touched no `src/domain`
  logic) green locally; `pnpm build` green (placeholder env); `pnpm test:e2e` 58/58 (unchanged — no
  new routes, only a new search param on an existing one, so no new guard case was needed).
- CI green on PR #23 (after one fix-up commit for a test-only bug — `purchase_spending_summary` was
  called via the service-role client instead of the authenticated user's, and the RPC carries no
  grant to `service_role`): **336 database/authorization tests across 23 files** (up from 320/21 at
  M8 — `tests/db/m81_remove_from_portfolio.test.ts`, `tests/authorization/m81_portfolio_removal.test.ts`,
  two new cases in `tests/db/m8_purchase_ledger.test.ts` reproducing the fixed bug and the new
  guard, two new cases in `tests/authorization/function_grants.test.ts`), including the hostile-grant
  convergence proof.
- Both M8.1 migrations applied to `pokeportfolio-dev` (`supabase db push`); `grant-audit.sql` clean
  (`supabase db query --linked`, zero rows); `remote-security-check.mjs` phase 1 **17/17** (no
  `INVITE_TOKEN` available this session, same as M7.1/M8); `deployment-check.mjs` **28/28** against
  the real rebuilt bundle after merge (new hashes for `PortfolioPage`, `PurchaseFormPage`,
  `PurchaseDetailPage`, `PurchasesListPage`, `HoldingDetailPage` confirmed the deploy genuinely
  picked up the change, not a stale edge cache).

**Not done this session, and why:** no signed-in deployed walkthrough of the new Remove/Purchase-
discoverability UI. Creating or signing into even a throwaway `.invalid` synthetic account is
outside what this session performs, regardless of project convention (same boundary every M6+
session has documented). Everything reachable *without* signing in was verified live, above.

## Next actions

**M1–M8.1 are done, merged, and deployed.** Ask the owner for:

1. The real-device check still outstanding since M7/M7.1 (checklist below, unchanged).
2. **A short signed-in M8 check**, using clearly synthetic amounts:
   - Open the central **+** menu → **Record purchase**. Log one small NOK purchase with two lines
     (e.g. an accessory line and a manual-card line) plus a shipping charge; confirm the allocation
     preview before saving matches the saved detail page.
   - Optionally, one EUR purchase using **Manual rate** (skip the Norges Bank fetch, so no live-API
     dependency in the check itself); confirm the NOK total shown matches `original amount ×
     entered rate`.
   - Open **Purchases** from Home's "Total spent" shortcut; confirm the summary figures match what
     was just entered.
   - **Void** both test purchases (Purchase detail → Void). Confirm they disappear from the
     headline totals but remain visible with "Show voided" checked.
   - Report anything that looked wrong, confusing, or ugly on a real phone — this is also the first
     real screen time the M8 UI has had outside this session's own review.
3. **A short signed-in M8.1 check:**
   - Add one temporary card, then Portfolio → Select → select it → **Remove**. Confirm the
     confirmation sheet's copy makes sense, the card disappears, and the physical/holding counts on
     Home and Portfolio fall accordingly.
   - Press the central **+** — confirm **Record purchase** is now easy to find and its one-line
     description makes sense next to **Add card**.
   - Record one small purchase (e.g. one card 100 NOK, one accessory 50 NOK, shipping 20 NOK —
     expected: Total spent 170 NOK, Collectibles 113.33 NOK, Accessories 56.67 NOK) and confirm the
     "Purchase recorded" banner and its Portfolio link appear on the detail page.
   - Report anything that looked wrong, confusing, or ugly.

Then start **M9 — Pricing and snapshots** ([docs/ROADMAP.md](docs/ROADMAP.md)).

**Real-device check needed (combines the outstanding M7 item with M7.1's own changes):** nav
symmetry and the + button's position/tap target, safe-area/home-indicator clearance, the Search
top bar and set carousel, the Portfolio search bar and scope/value header, 2-column mobile grid,
select mode, sheets, Profile's theme toggle actually changing the palette, light and dark both,
translucent-nav legibility over scrolled content, scrolling generally.

**Do not** attempt the whole MVP in one branch. Each milestone is a reviewable unit with a
behavioural gate.

## What not to re-research

Verified 2026-08-16, re-check only if something visibly breaks: Cardmarket and TCGplayer developer
APIs closed to new applicants · pokemontcg.io returns HTTP 500 · TCGdex relays Cardmarket EUR and
TCGplayer USD free, no key · no free source of historical EUR card prices · no free EUR source for
sealed or graded prices · Norges Bank FX API works, no key · Supabase free plan: 500 MB DB, no
automated backups, pauses after ~7 days idle, `pg_cron` available, built-in email 2/hour
project-wide · Cloudflare Pages free: unlimited bandwidth, 500 builds/month, no card · GitHub
Actions free: 2 000 private-repo minutes/month, $0 default spending limit · Node 24 is Active LTS.

Verified 2026-08-20 (M5), re-check only if something visibly breaks: TCGdex REST is the ingest
path — GraphQL's `cards`/`card` queries carry no language argument and its docs are unfinished, no
bulk database dump exists · TCGdex ids are unique per language only, never globally · Pokémon TCG
Pocket is series id `tcgp`, English only as of this date · `variants_detailed[]` sometimes carries
the literal placeholder `"generated"` for `variantId`, and marketplace product ids can be shared
across a card's sibling finishes · image CDN is `{base}/{quality}.{ext}`, `quality` ∈ `low`/`high`,
`webp` recommended · no rate-limit response observed across a full ~380-set ingest.

Verified 2026-08-17: `typescript-eslint` peer-caps TypeScript at `<6.1.0` · `gitleaks` CLI is MIT
with no license key · `corepack enable` fails `EPERM` on a non-admin Windows account · Supabase CLI
belongs as a devDependency · PostgREST serializes `bigint` as a JSON number, losing precision above
2^53 (cast money columns to text) · `ubuntu-latest` ships Docker, so `supabase start` works in CI.

Verified 2026-08-20 (M4, and all load-bearing — see RESEARCH R21–R23):

- **GoTrue invokes the Before User Created hook from every self-service account-creation path and
  from none of the Auth Admin API.** Established by reading `supabase/auth` at master, not from
  documentation. The entire invite-only design rests on it, so the authorization suite asserts both
  halves — public signup fails *and* redemption succeeds — and drift in either direction fails CI.
- The hook is available on Free, configurable as `[auth.hook.before_user_created]` in `config.toml`,
  and reaches a project through `supabase config push`.
- Supabase is migrating `anon`/`service_role` to `sb_publishable_…`/`sb_secret_…`; legacy keys are
  deprecated at the end of 2026. Semantics unchanged; both names appear in this repository.
- GoTrue lowercases every email it stores (`strings.ToLower`), which is why invitations normalize
  with `lower(btrim(...))` rather than inventing a competing rule.
- **A Supabase project may auto-grant the Data API roles privileges on new tables and functions**,
  and `GRANT` is additive — so a narrow grant does not restrict. This produced a live privilege
  escalation that CI could not see. See the journal entry.

Verified 2026-08-20 (M4.1):

- **The auto-exposure mechanism is `pg_default_acl` entries owned by `supabase_admin`**, present in
  the local stack and the hosted project alike, granting `anon` and `authenticated` everything on
  new objects in `public`. Unreachable from a migration and harmless — see the schema note above.
- **GoTrue's Admin API still invokes no Before User Created hook**, re-verified at
  `supabase/auth@bc32168e13fdc928c98b449fc76bc3fdb9a293c5` (master, 2026-08-20; release v2.196.0).
  RESEARCH R21 carries the detail and what protects the project if it changes.
- `REVOKE` on a table also revokes that role's column privileges on it, and `ALL TABLES IN SCHEMA`
  covers views and foreign tables but **not materialized views** — if M5 adds one, it needs its own
  line in the baseline migration.
- **PostgreSQL reports an `UPDATE` column-privilege refusal at table granularity** — "permission
  denied for table profiles", not "…for column is_admin". The column wording belongs to `SELECT`.
- **Cloudflare Pages, Free:** SPA fallback is automatic when the output has no top-level
  `404.html`; `_headers` supports 100 rules; `.nvmrc` is respected but `packageManager`/Corepack is
  **not**, so pnpm is pinned with `PNPM_VERSION`. Build image v3 defaults: Node 22.16.0, pnpm
  10.11.1.
- **Cloudflare Pages env var changes need a manual redeploy.** They are baked in at build time;
  editing one in the dashboard does nothing until the next build. "Retry deployment" on the latest
  entry in the Deployments tab rebuilds from the same commit with the current env vars.

Verified 2026-08-21 (M6, and load-bearing for the key migration):

- **Supabase's current publishable/secret key migration path**: both key types can be created
  through the dashboard (Settings → API Keys → "Publishable and secret API keys" tab → "Create new
  API keys") alongside the legacy pair without disturbing it. Edge Functions receive the new secret
  automatically via `SUPABASE_SECRET_KEYS` (a JSON map, one entry per named key — no redeploy needed
  for the injection itself, only for function code that reads the new variable name). Legacy keys
  can be **deactivated**, not only deleted — reversible, and does not invalidate issued user
  sessions, because API-key authentication and JWT signing are separate mechanisms.
- **`supabase projects api-keys` (no `--reveal` flag) no longer prints the secret key in full** in
  the currently pinned CLI (2.114.0) — it masks secret-shaped values by default and only reveals
  them with an explicit `--reveal` flag. This is a real change from the M5 session's experience, not
  assumed: confirmed via `--help`. Still avoided in this session regardless — the safety classifier
  blocked an attempt to run even the non-`--reveal` form, and that block was treated as correct
  rather than worked around. The publishable key was instead read directly out of the deployed
  bundle (public by design), which is the pattern to repeat if this is ever needed again.
- **PostgreSQL grants EXECUTE on a newly created function to `PUBLIC` by default**, a separate ACL
  entry from anything granted or revoked from a named role afterward — `REVOKE ... FROM anon` never
  touches it; only `REVOKE ... FROM PUBLIC` does. Every function-creating migration in this project
  already revokes from `public` at creation for exactly this reason (established in M4); a new
  function that skips that step is anon-callable regardless of what the later privilege-baseline
  sweep does. `grant-audit.sql` cannot see this class of gap — it only checks grants held by
  `anon`/`authenticated` by name, never `PUBLIC` — so a green audit does not prove anon lacks access
  to a function; it proves anon holds no *direct* grant. Keep this in mind before trusting the audit
  as the whole story for a *function's* privilege state, unlike a table's, where it is.
- **A column `DEFAULT` cannot contain a subquery** — `default (select auth.uid())` is valid in an
  RLS `USING`/`WITH CHECK` clause but raises `SQLSTATE 0A000` as a column default. Use the bare
  function call (`default auth.uid()`) instead.
- **`COMMENT ON FUNCTION ... IS` takes a single string literal, not an expression** — `'a' || 'b'`
  is a syntax error there even though string concatenation is valid SQL everywhere else.

Verified 2026-08-23 (M7.1), load-bearing for anyone touching `scripts/deployment-check.mjs` or
adding route-level code splitting:

- **`CREATE OR REPLACE FUNCTION` cannot add a parameter.** Postgres identifies a function by name
  plus argument *types*; a new parameter (even with a default) changes that identity, so
  `CREATE OR REPLACE` creates a second overload instead of replacing the first — and a call that
  could match either via defaults then fails with "function is not unique". `DROP FUNCTION` (the
  exact old signature) then `CREATE FUNCTION` is the correct sequence, same as
  `20260823120010_m71_number_sort.sql` does for `list_portfolio`.
- **`vite-plugin-pwa`'s service-worker precache manifest is the reliable way to enumerate every JS
  chunk a code-split build actually ships**, when a script needs to (`deployment-check.mjs` now
  does) — `index.html` only references the entry chunk and any eagerly-needed ones; lazy chunks
  reached via `React.lazy`/dynamic `import()` are never linked from it at all, and the bundler can
  also hoist a dependency shared between an eager and a lazy importer (here: the Supabase client)
  into its own chunk neither directly references.

Verified 2026-08-24 (M8):

- **Norges Bank's `EXR` endpoint orientation, re-confirmed live**: `BASE_CUR` is the first currency
  in the pair, and the returned number is NOK per one unit of it — a live request for
  `B.EUR.NOK.SP` over 2026-08-10..2026-08-14 returned `10.986` for 2026-08-13 and `10.9325` for
  2026-08-14, matching the 2026-08-16 verification already on record exactly. A date with no
  trading (weekend/holiday) has no observation in the response at all, not a null value — pinned as
  a fixture in `tests/data/norges-bank.test.ts`.
- **`supabase.functions.invoke` does not reliably surface a non-2xx Edge Function response body**
  (already known from `redeem-invitation`'s own client, `src/features/auth/InvitePage.tsx` —
  restated here because `fetch-fx-rate` made the opposite choice deliberately, D-049): every
  business outcome is HTTP 200 with an `{ ok, ... }` body instead, so `data` is always reliably
  populated regardless of which supabase-js version or code path is in play.
- **A new `ALTER TABLE ... ADD CONSTRAINT CHECK` migration validates against every existing row**,
  including on the real deployed project — confirmed by querying `pokeportfolio-dev` directly
  before pushing (`select count(*) from purchases where ...`) rather than assuming the two new M8
  CHECK constraints were safe. The real project currently holds zero `purchases` rows, so both
  validated trivially, but the check itself (not just the assumption) is the reusable habit for a
  future migration that tightens an existing constraint against a project that *does* hold data.

Verified 2026-08-25 (M8.1):

- **`PERFORM some_function(col) FROM table WHERE ...` in plpgsql calls the function once per row
  the FROM/WHERE clause matches**, exactly like a `SELECT` with the same target list would, and
  each call sees the *previous* calls' writes within the same statement (Postgres increments the
  command counter between rows) — confirmed by reasoning through `remove_holdings_from_portfolio`'s
  design (it relies on this: voiding two lots of the same multi-line purchase in one `PERFORM`
  statement correctly auto-voids the purchase only once the *second* call sees the first's
  `voided_at`) and by CI's green run of the corresponding test. A useful idiom for "call this
  function for its side effects over a set of rows" without a client-side loop.
- **`database.types.ts` cannot be blindly regenerated and swapped in** — diffed this session's
  hand-added type block against a real CI-generated artifact (byte-identical except one field) and
  found the file as a whole carries at least one *deliberate* divergence from what
  `supabase gen types` would produce: `create_purchase`/`update_purchase`'s `p_fx_rate_to_nok` is
  typed `string` by hand (the app passes a decimal string to avoid float imprecision on a
  `numeric(18,8)` parameter) where the generator infers `number`. A full-file replacement compiles
  cleanly except for this one spot — `src/data/purchases.ts` fails to typecheck. A future session
  with Docker regenerating this file must re-apply that field's type by hand afterward.

## Commands

```bash
pnpm install
pnpm dev          # http://localhost:5173
pnpm check        # typecheck + lint + format:check + test — the pre-commit gate
pnpm test:db      # database + authorization suites — needs `pnpm db:start` (Docker), or read CI
pnpm test:e2e     # Playwright, builds + previews first
pnpm build
```

Remote, all deliberate acts rather than a loop (DEVELOPMENT.md §3):

```bash
pnpm exec supabase db push
pnpm exec supabase config push
pnpm exec supabase functions deploy redeem-invitation
pnpm exec supabase functions deploy sync-catalog --use-api   # --use-api avoids needing Docker
pnpm exec supabase functions deploy fetch-fx-rate --use-api  # M8
pnpm exec supabase secrets set ALLOWED_ORIGINS=https://pokeportfolio-dev.pages.dev
pnpm exec supabase secrets set CATALOG_SYNC_SECRET=<random>  # operator secret, D-035
```

M8's manual, occasional, never-in-CI live Norges Bank contract check (API_SOURCES.md, prompt §93):

```bash
node scripts/verify-norges-bank-contract.mjs
```

Full catalog refresh (M5), not part of any loop — initial ingest plus manual refresh only:

```bash
CATALOG_SYNC_URL=https://nopmkroeygmlvndzjjqs.supabase.co/functions/v1/sync-catalog \
CATALOG_SYNC_SECRET=<the secret set above> \
node scripts/run-catalog-sync.mjs --language=en --language=ja
```

M7's 10 000-lot Portfolio benchmark, against an isolated synthetic account only — never the
owner's real one (DEVELOPMENT.md, "Live since M7"):

```bash
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... SUPABASE_ANON_KEY=... \
node scripts/portfolio-perf-benchmark.mjs --lots=10000
```

Then the deployment gate (SECURITY.md §13) — never skip it after touching auth, policies or grants:

```bash
node scripts/remote-security-check.mjs   # Supabase, publishable key only
node scripts/deployment-check.mjs        # Cloudflare, what browsers actually receive
```

Plus `scripts/grant-audit.sql` pasted into the Supabase SQL editor. It reads catalog metadata only;
clean means "Success. No rows returned."

Deployment itself needs no command. Merging to `main` builds it.

**Green as of the M6 merge (PR #12):** 80 domain/property/data tests · 40 Playwright tests
(desktop + iPhone) · 251 database and authorization tests across 17 files · 33/33 remote checks ·
27/27 deployment checks · `grant-audit.sql` clean against the live project · a real end-to-end M6
collection flow against the deployed bundle with synthetic accounts, zero residue.

**Green on PR #14 (`feat/m7-portfolio-display`), merged, and since verified against the real
project:** 80 domain/property/data tests (unchanged — M7 added no `src/domain` logic) · 50
Playwright tests (desktop + iPhone; +12 unique cases for the new/renamed routes and the
`/collection` → `/portfolio` redirects) · **269 database and authorization tests across 19 files**
(up from 251/17 at M6 — the two new M7 files, `tests/db/m7_constraints.test.ts` and
`tests/authorization/m7_portfolio.test.ts`) · the new PUBLIC-grant audit check and its
hostile-grants proof, both passing · `pnpm typecheck`/`pnpm lint`/`pnpm format:check`/`pnpm build`
all green. Migrations pushed to `pokeportfolio-dev`, `grant-audit.sql` clean,
`remote-security-check.mjs` 33/33, the real 10,000-lot benchmark passed. **Green on PR #15
(`fix/m7-csp-image-host`), merged:** the CSP `img-src` fix found during deployed-browser
verification (see "M7 verification state" above) — same CI suites, all green.

**Green on PR #18 (`feat/m7-1-ui-refinement`) and PR #19 (`fix/m71-deployment-check-lazy-chunks`),
both merged:** 80 domain/property/data tests (unchanged — M7.1 added no `src/domain` logic) ·
database/authorization suite green on CI including the two new test files' worth of M7.1 coverage
(`hide_values`/`use_eu_pricing` in `tests/authorization/profiles.test.ts`,
`natural_sort_key`/`number_asc`/`number_desc` in `tests/authorization/m7_portfolio.test.ts`) · one
updated E2E case (`/more`'s legacy redirect) · `pnpm typecheck`/`pnpm lint`/`pnpm format:check`/
`pnpm build` all green, bundle ~320 KB (98 KB gzipped, down from ~638 KB). Migrations pushed to
`pokeportfolio-dev`, `grant-audit.sql` clean, `remote-security-check.mjs` phase 1 17/17,
`deployment-check.mjs` **28/28** after PR #19's fix (the check itself had a real gap against
M7.1's code-split output — see the M7.1 section above).

CI runs `build-and-test` (gate + E2E + gitleaks) and `db-tests` (ephemeral Supabase stack → migrate
→ assert the Edge Function is reachable → **assert the privilege baseline → make the database
hostile, prove the audit rejects it, re-apply, prove convergence** → suites → generate types) on
every push and PR, with **no remote credentials anywhere**.

**Green on PR #21 (`feat/m8-purchases-ledger`), merged:** 85 domain/property/data tests (up from
80 — `tests/data/norges-bank.test.ts`) · database/authorization suite green on CI, **320 tests
across 21 files** (up from 269/19 at M7 — `tests/db/m8_purchase_ledger.test.ts`,
`tests/authorization/m8_purchases.test.ts`, plus five new routines and one new trigger function
added to `tests/authorization/function_grants.test.ts`), including the hostile-grant convergence
proof · 58 Playwright tests (up from 50 — four new `/purchases*` guard cases × desktop+iPhone) ·
`pnpm typecheck`/`pnpm lint`/`pnpm format:check`/`pnpm build` all green. All five M8 migrations
pushed to `pokeportfolio-dev`, `grant-audit.sql` clean, `remote-security-check.mjs` phase 1 17/17,
`fetch-fx-rate` deployed and confirmed to require a real session (`HTTP 401` with no JWT),
`deployment-check.mjs` **28/28** against the real rebuilt bundle (34 precache entries, all four new
`Purchase*` chunks present — polled until the service worker's manifest genuinely updated rather
than trusting a stale edge cache). **Green on PR #22 (`docs/m8-deployment-verification-and-
handover`), merged.** Both merges' own post-merge `push`-triggered CI runs on `main` are also
green (`build-and-test`/`db-tests`), confirmed directly from the Actions history, not assumed from
the PR-triggered runs alone.

**Green on PR #23 (`fix/m81-portfolio-remove-purchase-ux`), merged:** 85 domain/property/data
tests (unchanged — M8.1 touched no `src/domain` logic) · database/authorization suite green on CI,
**336 tests across 23 files** (up from 320/21 at M8 — `tests/db/m81_remove_from_portfolio.test.ts`,
`tests/authorization/m81_portfolio_removal.test.ts`, two new cases in
`tests/db/m8_purchase_ledger.test.ts`, two new cases in
`tests/authorization/function_grants.test.ts`), including the hostile-grant convergence proof · 58
Playwright tests (unchanged — no new routes) · `pnpm typecheck`/`pnpm lint`/`pnpm format:check`/
`pnpm build` all green. Both M8.1 migrations pushed to `pokeportfolio-dev`, `grant-audit.sql`
clean, `remote-security-check.mjs` phase 1 17/17, `deployment-check.mjs` **28/28** against the real
rebuilt bundle (new hashes for every changed chunk, confirming the deploy genuinely picked up the
change).

**Green on PR #25 (`feat/m9-pricing-snapshots`), merged:** 100 domain/property/data tests (up from
85 — 16 new `tests/data/tcgdex-pricing.test.ts` cases against real captured TCGdex payloads) ·
database/authorization suite green on CI, **353 tests across 24 files** (up from 336/23 at
M8.1 — `tests/db/m9_valuation_resolver.test.ts`), including the hostile-grant convergence proof —
took three pushes; CI's real ephemeral Postgres caught two genuine plpgsql bugs (ambiguous-column
errors `CREATE FUNCTION` cannot validate) that no local check could have found, both fixed before
the suite went green · 58 Playwright tests (unchanged — no new routes) · `pnpm typecheck`/
`pnpm lint`/`pnpm format:check`/`pnpm build` all green. All 8 M9 migrations pushed to
`pokeportfolio-dev` (including `pg_cron`/`pg_net` activation, confirmed working on the real
project); `grant-audit.sql` clean; `remote-security-check.mjs` phase 1 17/17; three Edge Functions
deployed (`ingest-prices`/`ingest-fx`/`search-prices`), all confirmed to reject unauthorized
requests via real `curl` checks; `PRICE_SYNC_SECRET` generated and set (Edge Function secret +
Supabase Vault, matching); real `cron.job` rows confirmed active; **a real initial price-sync
batch ran via the real cron tick** (2 variants, 4 snapshots written, zero errors — verified via
`price_sync_runs` and `price_snapshots` directly); `deployment-check.mjs` **28/28** against the
real rebuilt bundle.

## Owner actions outstanding

| # | Action | Blocks |
|---|---|---|
| 1 | Optional: install Docker Desktop | Local iteration convenience — every M7/M7.1/M8/M8.1 DB/authorization test still had to wait for CI this session instead of running locally first |
| 2 | Optional: fix Node/pnpm absence from the default PATH | Convenience only |
| 3 | A short real-device check on the deployed M7.1 UI (see "M7.1 — owner UI/UX refinement" above for the exact checklist) | Final sign-off on the nav/theme/gestures on real hardware — outstanding since M7 |
| 4 | **A short signed-in M8 check** (see "M8 — Purchases and the spending ledger" → "Next actions" above for the exact steps: record two small synthetic purchases, one NOK/multi-line and one EUR/manual-rate, check the Purchases summary, void both) | The one thing this session could not verify itself — see below |
| 5 | **A short signed-in M8.1 check** (see "M8.1" → "Next actions" above: add and remove a card via Portfolio Select, confirm the central + menu's Record purchase is easy to find, record one small purchase and confirm the success banner) | Same boundary as item 4 |
| 6 | Give feedback on the deployed M7.1/M8/M8.1/M9 UI (nav, Home, Search, Portfolio, Profile, Purchases, theme, real values) | Informs M10+ and the eventual M12a visual pass — not a blocker, but the owner explicitly wants to be asked here |
| 7 | **A short signed-in M9 check** — see "M9 — Pricing and snapshots" → prompt §101's outline: open Portfolio and confirm an automatically-priced raw card shows a real value; open the card and check value/source/freshness; confirm the Portfolio total updates; toggle hide/show values; search a common card and confirm visible price references; check Market Movers (may honestly say insufficient history on day one) | Same boundary as items 4/5 |
| 8 | ~~Real 10,000-lot Portfolio benchmark re-run~~ | **Resolved M9.2/M11** — the benchmark is now a permanent CI step (D-059), re-run again for M11's `list_portfolio` change with no regression (output_19.txt) |
| 9 | **A short signed-in M11 check** — see "M11 — Sealed Inventory" → "Owner check" in `ai_outputs/Claude_outputs/output_19.txt` for the exact steps: Search → Sealed, add one product, set quantity/intent, set and clear a manual value, confirm the Cards/Sealed breakdown, create one custom sealed product | Same boundary as items 4/5/7 |

This session could not perform items 3/4/5/7/9 itself: creating or signing into even a throwaway
synthetic account requires entering a password, which is outside what this session performs
regardless of project convention (same boundary M7.1's session already documented, restated in
every milestone since). The admin account, the M6 deployment, the API-key model and the
installed-PWA check remain done from before M7.
