-- M9.1 capacity gate (prompt §24-29, COST_POLICY.md): the 12-month daily-retention window shipped
-- with M9 was a placeholder pending real measurement (D-053's own note). It is now measured, not
-- estimated: a representative 365,000-row synthetic price_snapshots dataset (500 variants x 2
-- providers x 365 days, scripts/price-snapshots-storage-benchmark.sql, run in CI's ephemeral stack)
-- measured 245.30 bytes/row (table + its two indexes), close to but a genuine confirmation of the
-- pre-M9.1 ~200-300 byte/row estimate — the pre-M9 ~48-byte sketch that omitted index overhead was
-- the one that was actually wrong.
--
-- Projected at 250 bytes/row (rounded up from 245.30 for margin), 3,500 watched variants (the
-- documented realistic scale for a 10,000-card collection, DATA_MODEL.md §4.2) x 2 providers
-- (the worst case — most cards resolve on one provider, but the watch set does not know that in
-- advance):
--
--   12-month daily (the M9 default, UNTHINNED for the first 12 months regardless of the weekly
--   policy beyond it, since thinning only ever touches data OLDER than the daily window):
--     3,500 x 2 x 365 x 250 bytes = ~609 MB — EXCEEDS the entire Supabase Free 500 MB budget on
--     price_snapshots alone, before counting the catalog, holdings, purchases, sales or indexes on
--     any other table. This is a real, measured problem, not the earlier session's guess.
--
--   60-day daily + weekly beyond (this migration's choice):
--     1 year:  180 MB (36% of the 500 MB budget)
--     2 years: 271 MB (54%)
--     3 years: 362 MB (72% — close to COST_POLICY.md's existing "reconsider at ~350 MB" trigger,
--              which already anticipates a review checkpoint; this is not being newly invented)
--
-- 60 days keeps real daily granularity for a "1M" chart entirely and for "3M" mostly (the oldest
-- ~30 days of a 3-month view falls back to weekly points — informative, not fabricated, matching
-- D-008). "6M/1Y/MAX" legitimately use weekly older observations, exactly as prompt §27 asked.
-- The single latest observation per (variant, provider) is still always retained regardless of age
-- (thin_price_snapshots' own latest_rn guard, unchanged).
--
-- This is a genuine, disclosed trade-off, not a "solved forever" claim: the weekly tail is not
-- asymptotically bounded — it grows by one row per (variant, provider) per week, forever, just at
-- 1/7th the rate of daily. COST_POLICY.md's existing "reconsider when database exceeds ~350 MB"
-- trigger is the honest answer to "what happens after several more years," not a hidden problem.

create or replace function public.thin_price_snapshots()
returns table (deleted_count bigint)
language sql
set search_path = ''
as $$
  with doomed as (
    select id
    from (
      select
        id,
        row_number() over (
          partition by card_variant_id, provider, date_trunc('week', snapshot_date)
          order by snapshot_date desc
        ) as rn,
        row_number() over (
          partition by card_variant_id, provider
          order by snapshot_date desc
        ) as latest_rn
      from public.price_snapshots
      where snapshot_date < (current_date - interval '60 days')
    ) ranked
    -- Keep the latest observation in each ISO week, and always keep the single latest row per
    -- (variant, provider) regardless of age, so a variant nobody has refreshed in over 60 days
    -- never loses its last known price entirely.
    where rn > 1 and latest_rn > 1
  ),
  removed as (
    delete from public.price_snapshots where id in (select id from doomed)
    returning id
  )
  select count(*) from removed;
$$;

comment on function public.thin_price_snapshots() is
  'Service-role-only, idempotent retention thinning (M9.1 prompt §24-29, measured capacity gate): '
  'the most recent 60 days keep daily granularity; older than that keeps one observation per ISO '
  'week per (variant, provider), and always keeps the single latest row. Grant unchanged from M9.';
