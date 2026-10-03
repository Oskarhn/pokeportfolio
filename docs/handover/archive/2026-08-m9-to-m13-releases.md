> **Archived historical handover content — not authoritative.**
> This file is a preserved slice of the pre-P176 monolithic `HANDOVER.md` (268,674 bytes,
> 3,433 lines as of base SHA `d8682e047b757f63673a63ac8185a4806d68cb98`). It is kept for
> historical reference only. **Current project state lives in `HANDOVER.md` and
> `docs/PROJECT_STATE.json` at the repository root — do not infer current state from this file.**
> See [docs/handover/README.md](../README.md) for the archive index and
> [docs/handover/STATE_RECONCILIATION.md](../STATE_RECONCILIATION.md) for known contradictions
> between this material and current state.
>
> Covers M9 pricing/snapshots through M13 export/backup, plus the P26-P63 parallel release and portfolio-reset work.

# Handover archive: M9-M13 releases (pricing, sales, sealed inventory, dashboard, export)

## Released state below this line predates M16

**M13 (Export and versioned backup) is MERGED and
RELEASED: PR #47 squash-merged as `0fa3021b8f7415b4c3b427917845406d36d0d40f` on `main`,
Cloudflare deployed and verified (`deployment-check.mjs` 28/28, `grant-audit.sql` clean,
`remote-security-check.mjs` 17/17 phase 1; no migration exists for M13, so none was
applied).** **P42 (owner recompute-refresh fix) is MERGED and RELEASED on top of it: PR #48
squash-merged as `837942e6a50976323aaba558a1cfaacae9c17e5e`; its cron-cadence migration
(`20260901120000_p42_cron_cadence.sql`) was applied to `pokeportfolio-dev` BEFORE the
frontend merge — every-minute drain verified ticking naturally (~0.01 s no-op ticks),
nightly run-log prune scheduled, deployment check 28/28.** **P43 (portfolio reset + unified
correction-aware History) is MERGED and RELEASED on top of both: PR #49 squash-merged as
`59401e480e5c9c57c6dc096f864ce85a5fe4c878`; its two migrations
(`20260901120010_p43_reset_and_history.sql`, `20260901120020_p43_privilege_baseline.sql`) were
applied to `pokeportfolio-dev` BEFORE the frontend merge; hosted function/security state verified
(reset = SECURITY DEFINER, `search_path=''`, no-argument signature, EXECUTE to authenticated only;
history = SECURITY INVOKER, owner-scoped), grant audit clean, deployment check 28/28.**
**P48 (Home live Current Portfolio Value) is MERGED and RELEASED on top of all three: PR #51
squash-merged as `23b7ff5f5fdd80798355abe776bd98e405a6964b`; Home's CURRENT figures (headline,
TTEP) now come from the live canonical/resolved state `get_dashboard_summary()` already returns
(D-086: current = live state, history = portfolio_snapshots); no migration exists or was
applied; Cloudflare deployed from this exact commit and verified (`deployment-check.mjs` 28/28;
the live bundle carries the "Updating history…" label and no longer the old headline badge).**
**Open items are owner-facing manual checks only: the Home live-value repro, History browsing, the
reset flow and the M13 installed-iPhone export walkthrough — see "Owner manual checklist" below.**
See "P43 — Portfolio reset + unified History" below, then "M13 — Export
and backup". Beneath that: M1–M12 plus the parallel Home/Search/quantity release are
complete in code, merged and deployed. M12 (Dashboard) was merged through PR #35 and released

## Owner manual checklist (all three releases, signed-in as the administrator)

No safe authenticated browser automation exists this session (standing no-sign-in boundary since
M7.1), so these four checks remain for the owner:

- **A. Home live value (P48, successor of the P42 repro)**: quick-add a disposable test card →
  Current Portfolio Value must change immediately (agreeing with the Value breakdown total),
  WITHOUT waiting for history; while the worker catches up an "Updating history…" status sits
  near the chart (never beside the headline) and disappears by itself within roughly a minute
  plus one 3-second poll tick. Then remove/correct the same card → the headline updates
  immediately again; history catches up separately.
- **B. History**: `/history` loads; All / Purchases / Sales / Added / Values chips all work;
  "Show corrections / voided" reveals voided entries; voided entries do not affect active totals.
- **C. Reset** (only if genuinely wiping current test data): Profile → Reset portfolio data →
  confirmation → "Yes, reset portfolio". Afterward: Portfolio empty, spend/sales/history empty,
  Home shows its empty state, settings survive.
- **D. M13 export**: Profile → Export & backup → prepare backup → Ready → Save/Share; CSV export.
  On the installed iPhone PWA specifically: Save to Files + return to the app.

---

## M13 — Export and backup (released: PR #47, squash `0fa3021b`)

Three parallel sources combined deliberately on one integration branch — no source PR was merged to main:
P35 export core (PR #46 @ `b906cc0`), P36 UI/platform delivery (PR #44 @ `befa4c2`), P37
implementation-blind adversarial contract package (PR #45 @ `2c4ccb5`). The three remain OPEN/DRAFT
historical source PRs; the integrated candidate shipped as PR #47 after Claude Prompt 45's APPROVED
final adversarial review at head `a9681b3`.

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
  steps (reports duration/request-count/artifact bytes; catastrophic-only 60 s budget). Released
  after: Claude review APPROVED, full CI green on the integration PR, squash merge and Cloudflare
  deploy verified (`deployment-check.mjs` 28/28; no migration exists, so none was applied).
  Restore remains M19 (D-025).

---

## P43 — Portfolio reset + unified History (released: PR #49, squash `59401e4`; rebased onto M13+P42)

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
- **CI: GREEN** on the pre-rebase PR head (both jobs; 502/502 db+authorization tests across 39
  files) and again on the repaired/rebased head that actually merged (run 32822968054: db suite
  520 passed / 1 skipped across 41 files — the combined chain including P42's suite; hostile-grant
  convergence re-applying `20260901120020_p43_privilege_baseline.sql`; migrate-from-scratch green
  over `20260901120000_p42` → `20260901120010_p43_reset_and_history` →
  `20260901120020_p43_privilege_baseline`). Four red runs preceded green and
  every failure was a genuine catch by CI's ephemeral Postgres: a wrong-case fixture enum
  ('PSA' vs 'psa'), missing `.single()` on rpc results in test helpers, an accumulation-based
  isolation assertion, **one real function bug — reset's returned counts were computed after
  the deletes (always zero), now captured via GET DIAGNOSTICS ROW_COUNT per statement** — and
  a fixture lot silently failing M11's sealed_intent rule. Local checks before each push:
  typecheck/lint/format clean, domain tests 168/168, production build green. Atomicity is
  structurally asserted (one PostgREST request = one transaction + exercised FK order); true
  fault-injection needs DDL the harness lacks — disclosed in TESTING.md.
- **Reviewer items closed**: the reset-vs-drain concurrency argument was independently confirmed
  (and extended) by the Prompt 46 cross-PR review; the Values chip label stays as shipped;
  both migrations were applied to `pokeportfolio-dev` before the frontend merge, and the hosted
  function/security state was verified directly (definer/invoker split, `search_path=''`,
  no-argument reset signature, authenticated-only EXECUTE). The owner-facing reset walkthrough is
  checklist item C above.

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

**M1-M12, the parallel release, and M13/P42/P43/P48/M16 are all merged/deployed. No open engineering
item remains in any released family; the open items are the owner manual checks above (the M16
openings smoke checklist A-G, the Home live-value repro, History browsing, reset flow,
installed-iPhone export) and the standing owner-device check carried since M7.1. A formal
release tag remains a separate owner decision - none was created for M16.**

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

Scope is settled — do not reopen it (see [docs/PLANNING_FREEZE.md](../../../docs/PLANNING_FREEZE.md) §9).

