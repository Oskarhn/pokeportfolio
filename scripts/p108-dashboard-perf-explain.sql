-- P108 investigation tool (docs/BACKLOG.md dashboard-performance item; mirrors the technique
-- scripts/portfolio-perf-explain.sql already established for list_portfolio).
--
-- Extracts resolve_variant_market_values's dominant-cost `latest_snapshot` CTE (per P105's own
-- real EXPLAIN finding: 733/836ms, 87.5%, is this one Function Scan) and get_dashboard_summary's
-- top-level RPC call, and EXPLAINs both directly against the benchmark's own seeded synthetic
-- account — never real data. Impersonates the target user the same way a real signed-in request
-- does (SET ROLE authenticated + request.jwt.claims 'sub').
--
-- Usage: psql "$DB_URL" -v user_id=<uuid> -v phase=label -f scripts/p108-dashboard-perf-explain.sql

set role authenticated;
select set_config(
  'request.jwt.claims',
  json_build_object('sub', :'user_id', 'role', 'authenticated')::text,
  false
);

select '=== phase: ' || :'phase' || ' ===' as marker;

select 'indexes currently on price_snapshots' as note;
select indexname, indexdef from pg_indexes where tablename = 'price_snapshots' order by indexname;

\echo '########## EXPLAIN: latest_snapshot CTE alone (the P105-identified dominant cost) ##########'
explain (analyze, buffers, settings, format text)
select distinct on (ps.card_variant_id, ps.provider)
  ps.card_variant_id, ps.provider, ps.price_kind, ps.source_currency, ps.value_minor,
  ps.snapshot_date, ps.provider_updated_at
from public.price_snapshots ps
where ps.card_variant_id in (
  select distinct card_variant_id from public.holdings
   where user_id = :'user_id' and card_variant_id is not null
)
order by ps.card_variant_id, ps.provider, ps.snapshot_date desc;

\echo '########## EXPLAIN: get_dashboard_summary() top-level RPC call, run 1 ##########'
explain (analyze, buffers, settings, format text)
select * from public.get_dashboard_summary();

\echo '########## EXPLAIN: get_dashboard_summary() top-level RPC call, run 2 (warm) ##########'
explain (analyze, buffers, format text)
select * from public.get_dashboard_summary();

\echo '########## EXPLAIN: get_dashboard_summary() top-level RPC call, run 3 (warm) ##########'
explain (analyze, buffers, format text)
select * from public.get_dashboard_summary();

\echo '########## Ten back-to-back timed calls (\timing), for median/p95/min/max ##########'
\timing on
select * from public.get_dashboard_summary();
select * from public.get_dashboard_summary();
select * from public.get_dashboard_summary();
select * from public.get_dashboard_summary();
select * from public.get_dashboard_summary();
select * from public.get_dashboard_summary();
select * from public.get_dashboard_summary();
select * from public.get_dashboard_summary();
select * from public.get_dashboard_summary();
select * from public.get_dashboard_summary();
\timing off
