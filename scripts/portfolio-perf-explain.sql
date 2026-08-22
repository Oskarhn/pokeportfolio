-- M9.2 investigation tool (docs/TESTING.md §7, HANDOVER.md's M9.1 "root cause not yet identified").
--
-- Captures real EXPLAIN (ANALYZE, BUFFERS, SETTINGS) evidence for list_portfolio against the
-- benchmark's own seeded synthetic 10,000-lot account (scripts/portfolio-perf-benchmark.mjs),
-- never against real data. Run via psql, impersonating the synthetic user the same way Supabase's
-- own stack does: auth.uid() reads current_setting('request.jwt.claims', true)::json->>'sub'.
-- Nothing here bypasses RLS — this sets the session to the `authenticated` role and supplies that
-- one claim, exactly what a real signed-in request presents. superuser sessions (as `postgres`,
-- which is how CI connects) can `SET ROLE authenticated` locally because the local stack grants
-- that membership; this mirrors how tests/db already impersonate users for RLS assertions.
--
-- Usage: psql "$DB_URL" -v user_id=<uuid> -v phase=label -f scripts/portfolio-perf-explain.sql
-- (raw, unquoted values — this script uses psql's `:'var'` quote-substitution, not manual quoting)
--
-- Prints, per call: a phase marker, pg_class reltuples/relpages for the tables list_portfolio
-- touches (vs their real row counts, to expose stale-statistics-driven misestimation), then
-- EXPLAIN (ANALYZE, BUFFERS, SETTINGS) for value_desc and name_asc first pages, portfolio_counts()
-- as a control, and three back-to-back repeats of value_desc to separate cold-cache/replan effects
-- from a genuine per-call cost.

-- NOT `set local`/is_local=true: psql runs each statement in the file as its own autocommitted
-- implicit transaction (no explicit BEGIN here), so a transaction-scoped SET would revert before
-- the next statement ever saw it. This needs to persist for the rest of the psql session instead.
set role authenticated;
select set_config(
  'request.jwt.claims',
  json_build_object('sub', :'user_id', 'role', 'authenticated')::text,
  false
);

select '=== phase: ' || :'phase' || ' ===' as marker;

select
  'pg_class stats (whole table — this DB holds only this one synthetic account)' as note;
select relname, reltuples, relpages
from pg_class
where relname in (
  'holdings', 'acquisition_lots', 'card_variants', 'cards', 'card_sets',
  'manual_valuations', 'price_snapshots'
)
order by relname;

select 'actual row counts (RLS-scoped to this session''s user)' as note;
select 'holdings' as table_name, count(*) from public.holdings
union all
select 'acquisition_lots', count(*) from public.acquisition_lots
union all
select 'price_snapshots', count(*) from public.price_snapshots;

\echo '########## EXPLAIN: list_portfolio value_desc, first page (p_limit=30), run 1 ##########'
explain (analyze, buffers, settings, format text)
select * from public.list_portfolio(p_sort := 'value_desc', p_limit := 30);

\echo '########## EXPLAIN: list_portfolio value_desc, first page, run 2 (same session, warm) ##########'
explain (analyze, buffers, settings, format text)
select * from public.list_portfolio(p_sort := 'value_desc', p_limit := 30);

\echo '########## EXPLAIN: list_portfolio value_desc, first page, run 3 (same session, warm) ##########'
explain (analyze, buffers, format text)
select * from public.list_portfolio(p_sort := 'value_desc', p_limit := 30);

\echo '########## EXPLAIN: list_portfolio name_asc, first page ##########'
explain (analyze, buffers, settings, format text)
select * from public.list_portfolio(p_sort := 'name_asc', p_limit := 30);

\echo '########## EXPLAIN: portfolio_counts() [control] ##########'
explain (analyze, buffers, settings, format text)
select * from public.portfolio_counts();
