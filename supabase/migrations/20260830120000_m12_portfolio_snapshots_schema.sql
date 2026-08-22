-- M12 Dashboard — derived snapshot cache (DATA_MODEL.md §6, shipped).
--
-- portfolio_snapshots is a CACHE, not a ledger. Canonical truth remains purchases/
-- purchase_lines/acquisition_lots/lot_disposals/sales/sale_lines/manual_valuations/
-- price_snapshots/fx_rates. Every row here is reproducible by
-- rebuild_portfolio_snapshots() from canonical rows alone (20260830120010), and the
-- full-rebuild == incremental-recompute equality is a permanent test gate
-- (tests/db/m12_dashboard_snapshots.test.ts, TESTING.md §3).
--
-- ── Why these aggregates are NOT NULL DEFAULT 0 without violating invariant M1 ────────────────
-- M1 forbids a NULL-money column meaning zero for a FACT about a single item ("how much did
-- this cost?" is unknown, not free). These columns are SUMS over well-defined sets: the sum of
-- an empty set genuinely is 0, and "no valued lots yet" making CMV 0 is the documented CMV
-- semantic (FINANCIAL_MODEL.md §2.4) — surfaced honestly alongside unvalued_lot_count, never
-- presented as "worth nothing". Absence of a SNAPSHOT ROW (before the user's first tracked
-- date) is how "no history" is expressed — never a fabricated zero-filled row.
--
-- Coverage honesty (prompt §32/§33): market_value_nok_minor is the sum over RESOLVED lots only.
-- A date with open lots but zero resolvable values stores 0 with
-- unvalued_lot_count = open_lot_count; readers (get_portfolio_history.has_coverage) use that
-- pair to render a gap/"No priced holdings", never a chart point implying worthlessness.
--
-- Security (DATA_MODEL.md §1 "Derived cache"): owner-read-only. The recompute engine
-- (service-only) is the ONLY writer; browsers get SELECT on their own rows via RLS and hold no
-- INSERT/UPDATE/DELETE grant at all. The queue and run-log tables are service/internal-only:
-- RLS enabled with no policies and no grants to anon/authenticated, the same shape as
-- invitation_claims/catalog_sync_runs — unreachable through the Data API under every role a
-- browser can hold.

-- ── portfolio_snapshots ──────────────────────────────────────────────────────────────────────

create table public.portfolio_snapshots (
  user_id uuid not null references auth.users(id) on delete cascade,
  snapshot_date date not null,
  -- CMV as of snapshot_date: Σ over open-as-of-date lots of quantity_remaining_as_of ×
  -- resolved as-of unit value (FINANCIAL_MODEL.md §2.4). Missing values excluded and counted,
  -- never treated as zero (F14).
  market_value_nok_minor bigint not null default 0,
  -- ACMV: CMV restricted to lots with cost_basis_state = 'known'.
  attributed_value_nok_minor bigint not null default 0,
  -- DCB: historical direct cost basis of open known-cost inventory as of the date
  -- (FINANCIAL_MODEL.md §2.5; adjustment share rule documented in DECISIONS.md D-068).
  cost_basis_nok_minor bigint not null default 0,
  -- Frozen-ledger cumulatives through snapshot_date (business-date semantics, voided excluded).
  collectible_spend_to_date_nok_minor bigint not null default 0,
  sales_proceeds_to_date_nok_minor bigint not null default 0,
  -- Open acquisition lots as of the date (ownership timeline, FINANCIAL_MODEL.md §3).
  open_lot_count bigint not null default 0,
  -- Of those, lots with no resolvable unit value (UHC, F14).
  unvalued_lot_count bigint not null default 0,
  -- Operational timestamp only — deliberately EXCLUDED from the full-vs-incremental equality
  -- comparison, which compares the complete semantic column set (prompt §16).
  computed_at timestamptz not null default now(),
  primary key (user_id, snapshot_date)
);

comment on table public.portfolio_snapshots is
  'M12 derived dashboard cache: one end-of-business-day portfolio state per user per date. '
  'Fully reproducible from canonical tables by rebuild_portfolio_snapshots(); browsers are '
  'read-only on their own rows; the recompute engine is the sole writer.';

alter table public.portfolio_snapshots enable row level security;

create policy portfolio_snapshots_select_own
  on public.portfolio_snapshots
  for select to authenticated
  using (user_id = auth.uid());

-- No INSERT/UPDATE/DELETE policy exists: the cache is written exclusively by
-- rebuild_portfolio_snapshots() running under the service role (which bypasses RLS), so no
-- browser session can forge or mutate portfolio history (prompt §13/§92/§96).

-- ── portfolio_recompute_queue ────────────────────────────────────────────────────────────────
-- One row per user with un-rebuilt history; dirty_from is the earliest business date whose
-- snapshot state may have changed. Writers coalesce with LEAST (never move the boundary later —
-- prompt §15/§53). Drained by drain_portfolio_recompute_queue() on the pg_cron worker.

create table public.portfolio_recompute_queue (
  user_id uuid primary key references auth.users(id) on delete cascade,
  dirty_from date not null,
  updated_at timestamptz not null default now()
);

comment on table public.portfolio_recompute_queue is
  'M12 internal dirty-marking for the snapshot cache. Written only by the invalidation '
  'triggers (20260830120020) via enqueue_portfolio_recompute(). Service/internal-only: RLS '
  'enabled, no policies, no grants to anon/authenticated — a browser can neither read another '
  ''user''s dirty state nor enqueue arbitrary users (prompt §93).';

alter table public.portfolio_recompute_queue enable row level security;

-- Deliberately no policies: not even the owner reads their own queue row through the Data API.
-- The dashboard learns "your data is being refreshed" via get_dashboard_summary()'s
-- pending_recompute flag, evaluated inside the database, never by exposing the queue itself.

-- ── portfolio_recompute_runs ─────────────────────────────────────────────────────────────────
-- Minimal observability for the worker (prompt §55): one row per drain invocation. Never logs
-- portfolio values, never exposes user ids beyond a count — diagnosing "did the job run, did it
-- write, did it fail" is the whole purpose.

create table public.portfolio_recompute_runs (
  id bigint generated always as identity primary key,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  users_processed int not null default 0,
  snapshots_written int not null default 0,
  error text
);

comment on table public.portfolio_recompute_runs is
  'M12 worker observability (prompt §55): started/finished/users/rows/error per drain run. '
  'Service-only, same shape as price_sync_runs — RLS enabled, no policies, no browser grants.';

alter table public.portfolio_recompute_runs enable row level security;

-- Indexes: the composite PK serves the per-user chart range scan (snapshot_date is the second
-- column, and every reader filters by user_id first). No further indexes — the table is small
-- by construction (≤10 users × daily rows) and the measured footprint lives in
-- COST_POLICY.md §6 via scripts/portfolio-snapshots-benchmark.mjs.
