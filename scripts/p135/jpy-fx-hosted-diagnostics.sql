-- P135 §8 — hosted-data diagnostics for the P130-02 JPY FX remediation, to run READ-ONLY, BEFORE
-- any migration, as an extension of P131's scripts/finance-integrity-diagnostics.sql (which
-- already covers jpy_purchase_count / jpy_purchase_manual_fx_count / jpy_purchase_auto_fx_count /
-- jpy_sale_count / jpy_sale_manual_fx_count / jpy_sale_auto_fx_count — see that file for those six).
-- This script adds ONLY what P131 does not already have: the fx_rates HISTORY table (shared
-- market-data cache, not a per-transaction row) and stored-rate range buckets that distinguish a
-- plausible per-unit JPY rate from a plausible raw per-100 (un-normalized) JPY rate, WITHOUT ever
-- printing a real amount or a real row — aggregate counts only, exactly like P131's script.
--
-- NOT RUN IN THIS SESSION. P135's prompt explicitly forbids any hosted query this session
-- ("No hosted query in this session"). This file is deliverable evidence for whoever runs P136 to
-- execute against the hosted project the same way P131 ran its own script:
--   pnpm exec supabase db query --linked -f scripts/p135/jpy-fx-hosted-diagnostics.sql
-- (or folded directly into a future scripts/finance-integrity-diagnostics.sql revision).
--
-- Range-bucket heuristic, independently derived (NOT from stored intent — provenance can only be
-- proven for auto-sourced rows, see HOSTED_DATA_DECISION_TREE in output_135.txt):
--   A true "NOK per 1 JPY" rate has been roughly 0.045-0.11 across any realistic historical range
--   (JPY has been a weak-to-moderate currency against NOK for decades; even a generous margin puts
--   a genuine per-unit rate well under 1.0).
--   A raw, un-normalized "NOK per 100 JPY" figure (what the released parser actually stores for
--   fx_source='norges_bank') is 100x that: roughly 4.5-11.
-- A rate outside BOTH bands is neither a plausible genuine per-unit rate nor a plausible raw
-- Norges Bank figure — flagged separately, never silently bucketed either way.

select jsonb_build_object(
  'generated_at_utc', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
  'transaction_read_only', current_setting('transaction_read_only'),

  -- fx_rates is shared cache (base_currency/quote_currency/rate_date/source), not scoped to a
  -- purchase or sale — a row existing here does NOT by itself imply a transaction used it.
  'fx_rates_jpy_total', (
    select count(*) from public.fx_rates where base_currency = 'JPY' and quote_currency = 'NOK'),
  'fx_rates_jpy_by_source', (
    select coalesce(jsonb_object_agg(source, cnt), '{}'::jsonb) from (
      select source, count(*) cnt from public.fx_rates
      where base_currency = 'JPY' and quote_currency = 'NOK'
      group by source) x),

  -- Range buckets — aggregate counts only, no row content, no amounts.
  'fx_rates_jpy_rate_range_buckets', jsonb_build_object(
    'plausible_per_unit_lt_1', (
      select count(*) from public.fx_rates
      where base_currency = 'JPY' and quote_currency = 'NOK' and rate < 1),
    'plausible_raw_per_100_between_1_and_50', (
      select count(*) from public.fx_rates
      where base_currency = 'JPY' and quote_currency = 'NOK' and rate >= 1 and rate < 50),
    'implausible_either_way_gte_50', (
      select count(*) from public.fx_rates
      where base_currency = 'JPY' and quote_currency = 'NOK' and rate >= 50)
  ),

  -- Same three buckets applied to purchases.fx_rate_to_nok / sales.fx_rate_to_nok for JPY rows —
  -- P131 already counts JPY purchases/sales by fx_source; this refines those counts by the SAME
  -- range heuristic, split by fx_source so a manual-rate row's provenance signal (self-reported,
  -- weaker — see the decision tree) is never merged with an auto-sourced row's (system-generated,
  -- stronger) count.
  'jpy_purchase_rate_buckets_by_source', (
    select coalesce(jsonb_object_agg(fx_source, buckets), '{}'::jsonb) from (
      select fx_source, jsonb_build_object(
        'lt_1', count(*) filter (where fx_rate_to_nok < 1),
        'between_1_and_50', count(*) filter (where fx_rate_to_nok >= 1 and fx_rate_to_nok < 50),
        'gte_50', count(*) filter (where fx_rate_to_nok >= 50)
      ) as buckets
      from public.purchases
      where currency = 'JPY'
      group by fx_source) x),
  'jpy_sale_rate_buckets_by_source', (
    select coalesce(jsonb_object_agg(fx_source, buckets), '{}'::jsonb) from (
      select fx_source, jsonb_build_object(
        'lt_1', count(*) filter (where fx_rate_to_nok < 1),
        'between_1_and_50', count(*) filter (where fx_rate_to_nok >= 1 and fx_rate_to_nok < 50),
        'gte_50', count(*) filter (where fx_rate_to_nok >= 50)
      ) as buckets
      from public.sales
      where currency = 'JPY'
      group by fx_source) x),

  -- Cross-check: for AUTO-sourced JPY rows only, does total_nok_minor already look "numerically
  -- right" under the CURRENT (buggy) formula, i.e. does the stored total already reflect the
  -- coincidental cancellation this audit proved in scripts/p135/repro_p130_02.sql? A row failing
  -- this check on the auto path is evidence AGAINST blind "keep the frozen NOK value" trust for
  -- that specific row and must not be waved through by the decision tree without individual review.
  'jpy_auto_purchases_where_stored_rate_looks_like_raw_per_100', (
    select count(*) from public.purchases
    where currency = 'JPY' and fx_source = 'norges_bank' and fx_rate_to_nok >= 1 and fx_rate_to_nok < 50),
  'jpy_auto_sales_where_stored_rate_looks_like_raw_per_100', (
    select count(*) from public.sales
    where currency = 'JPY' and fx_source = 'norges_bank' and fx_rate_to_nok >= 1 and fx_rate_to_nok < 50)

) as p135_jpy_fx_diagnostics;
