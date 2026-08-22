-- M9.1 storage-capacity gate (COST_POLICY.md, DATA_MODEL.md §4.2, docs/PROJECT_JOURNAL.md).
--
-- Measures the REAL Postgres storage footprint of `price_snapshots` (table + its two indexes)
-- against a representative synthetic dataset, instead of the pre-M9.1 ~200-300 byte/row estimate
-- (which was itself already a correction of the original pre-M9 ~48-byte sketch that omitted index
-- overhead entirely).
--
-- SAFETY: this must only ever run against CI's ephemeral local Supabase/Postgres stack (destroyed
-- when the job's container stops) or another throwaway database. It inserts 500 synthetic catalog
-- rows and 365,000 synthetic price_snapshots rows. Never run this against a database holding real
-- data — see DEVELOPMENT.md's benchmark-safety pattern (scripts/portfolio-perf-benchmark.mjs).
--
-- Sample size reasoning: 500 variants x 2 providers x 365 days = 365,000 rows is large enough that
-- btree index page-fill and TOAST/alignment overhead settle to their steady-state average (a
-- handful of rows would understate index overhead badly), while staying fast enough to run inside
-- a normal CI job. bytes/row is what gets extrapolated to the real watched-variant scale; the
-- specific row count here does not need to match the real fleet size, since bytes/row does not grow
-- with row count. Rather, it is stable at this size.

do $$
begin
  raise notice 'price_snapshots BEFORE: % rows, % total bytes',
    (select count(*) from public.price_snapshots),
    pg_total_relation_size('public.price_snapshots');
end $$;

with series as (
  insert into public.card_series (slug, name)
  values ('m91-storage-bench-series', 'M9.1 Storage Benchmark Series')
  returning id
),
one_set as (
  insert into public.card_sets (series_id, slug, name, language)
  select id, 'm91-storage-bench-set', 'M9.1 Storage Benchmark Set', 'en' from series
  returning id
),
new_cards as (
  insert into public.cards (set_id, local_id, name)
  select one_set.id, i::text, 'Storage Bench Card ' || i
  from one_set, generate_series(1, 500) as i
  returning id
),
new_variants as (
  insert into public.card_variants (card_id, finish, stamp, subtype)
  select id, 'normal', '', '' from new_cards
  returning id
)
insert into public.price_snapshots
  (card_variant_id, provider, price_kind, source_currency, value_minor, snapshot_date, provider_updated_at)
select
  v.id,
  p.provider,
  case when p.provider = 'tcgdex_cardmarket' then 'cm_trend' else 'tp_market' end::public.price_kind,
  case when p.provider = 'tcgdex_cardmarket' then 'EUR' else 'USD' end,
  (100 + floor(random() * 900))::bigint,
  current_date - d.n,
  (current_date - d.n)::timestamptz
from new_variants v
cross join (
  values ('tcgdex_cardmarket'::public.price_provider), ('tcgdex_tcgplayer'::public.price_provider)
) as p(provider)
cross join generate_series(0, 364) as d(n);

vacuum analyze public.price_snapshots;

select
  count(*) as row_count,
  pg_size_pretty(pg_total_relation_size('public.price_snapshots')) as total_pretty,
  pg_total_relation_size('public.price_snapshots') as total_bytes,
  pg_relation_size('public.price_snapshots') as table_bytes,
  pg_indexes_size('public.price_snapshots') as index_bytes,
  round(pg_total_relation_size('public.price_snapshots')::numeric / count(*), 2) as bytes_per_row_total,
  round(pg_relation_size('public.price_snapshots')::numeric / count(*), 2) as bytes_per_row_table,
  round(pg_indexes_size('public.price_snapshots')::numeric / count(*), 2) as bytes_per_row_index
from public.price_snapshots;

-- Per-index breakdown, since price_snapshots_date_idx (plain date, low cardinality-ish) and
-- price_snapshots_variant_date_idx (composite, high cardinality) are expected to differ.
select
  indexrelname,
  pg_size_pretty(pg_relation_size(indexrelid)) as size_pretty,
  pg_relation_size(indexrelid) as size_bytes
from pg_stat_user_indexes
where relname = 'price_snapshots';
