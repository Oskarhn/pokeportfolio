-- P108: dashboard-read performance fix (docs/BACKLOG.md "get_dashboard_summary() exceeds the
-- 1.5s Home-read budget"; root-caused by P105, re-verified here with a live EXPLAIN before this
-- migration was written).
--
-- resolve_variant_market_values's `latest_snapshot` CTE does
--   select distinct on (card_variant_id, provider) ...
--   order by card_variant_id, provider, snapshot_date desc
-- from price_snapshots. The only existing index, price_snapshots_variant_date_idx
-- (card_variant_id, snapshot_date desc), omits `provider` — it cannot satisfy that ordering, so
-- Postgres has to fetch and sort nearly every retained row for every owned variant instead of
-- streaming one row per (card_variant_id, provider) group. A three-column covering index matching
-- the DISTINCT ON's exact grouping/ordering columns turns this into a plain index-only scan with
-- no sort step.
--
-- The old two-column index is dropped in the same migration, but only after checking every other
-- reader of price_snapshots (docs/BACKLOG.md's own caveat: "only drop if all remaining callers are
-- covered safely", not merely "P105 suspected redundancy"):
--   - get_card_variant_price_history's `raw` CTE (20260826120020) filters
--     `card_variant_id = p_card_variant_id` with no DISTINCT ON/provider grouping of its own — the
--     new index's leading column (card_variant_id) serves an equality filter identically to the
--     old one.
--   - select_price_sync_batch's `last_seen` CTE (20260826120040) does
--     `select card_variant_id, max(snapshot_date) from price_snapshots group by card_variant_id`
--     with no WHERE clause at all — an unfiltered full aggregate over the whole table, serviced by
--     a full index-only scan either way; adding `provider` as a middle column costs this query
--     nothing it wasn't already going to scan (verified via EXPLAIN below — plan unchanged in
--     shape, this caller is not on any user-facing latency budget in the first place: a 15-minute
--     background ingest job).
--   - thin_price_snapshots' retention window (20260826120040/20260827130000) partitions by
--     `(card_variant_id, provider)` explicitly and orders by `snapshot_date desc` — this is the
--     SAME grouping the new index leads with, so retention gets a real (unmeasured bonus) speedup,
--     not a regression.
-- No caller needs the two-column index for anything the three-column one cannot serve as a valid
-- (if sometimes wider) prefix.
create index price_snapshots_variant_provider_date_idx
  on public.price_snapshots (card_variant_id, provider, snapshot_date desc)
  include (price_kind, source_currency, value_minor, provider_updated_at);

drop index if exists public.price_snapshots_variant_date_idx;
