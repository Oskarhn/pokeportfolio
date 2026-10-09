-- Pricing pipeline health (P201) — READ-ONLY, AGGREGATE COUNTS AND AGES ONLY.
--
-- One SELECT statement: no function with side effects, no row content, no user data. Every value is a
-- count, a percentage or an age across the shared market-data tables, so it is safe to run against the
-- hosted project (read the checklist first: docs/reliability/P201_PRICING_HEALTH_CHECKLIST.md).
--
--   pnpm exec supabase db query --linked -f scripts/pricing-health-diagnostics.sql
--   (or paste it into the Supabase SQL editor; or: psql "$DB_URL" -f scripts/pricing-health-diagnostics.sql)
--
-- It needs a role that can read the `cron` schema (the `postgres` role in the SQL editor can). The
-- cron checks are the only ones that do.
--
-- Output: one row per check — (check_name, status, value, expectation). status is PASS / WARN / FAIL /
-- INFO. The last row, `overall`, is FAIL if any check FAILs, WARN if any WARNs, else PASS. A FAIL is
-- "do not release / go and look now"; a WARN is "explain it before releasing"; INFO is context.
--
-- The thresholds assume the shipped cadence: ingest-prices every 15 minutes (batch 200, so a full
-- cycle of ~3,500 watched variants takes ~4.5 hours), ingest-fx daily at 17:00 UTC, Norges Bank
-- publishing business days only (a long holiday weekend legitimately leaves the newest rate 4-5
-- days old).

with
  now_ts as (select now() as t, current_date as d),
  runs as (
    select kind, status, error, finished_at
    from public.price_sync_runs
    where finished_at is not null
  ),
  last_ok as (
    select
      (select max(finished_at) from runs where kind = 'prices' and status in ('succeeded', 'partial')) as prices,
      (select max(finished_at) from runs where kind = 'fx' and status = 'succeeded') as fx
  ),
  prices_24h as (
    select * from runs, now_ts
    where kind = 'prices' and finished_at > now_ts.t - interval '24 hours'
  ),
  watched as (select card_variant_id from public.watched_card_variants),
  newest as (
    select w.card_variant_id, max(ps.snapshot_date) as newest_date
    from watched w
    left join public.price_snapshots ps on ps.card_variant_id = w.card_variant_id
    group by w.card_variant_id
  ),
  freshness as (
    select
      count(*) as total,
      count(*) filter (where newest_date >= (select d from now_ts) - 3) as fresh,
      count(*) filter (where newest_date < (select d from now_ts) - 3
                         and newest_date >= (select d from now_ts) - 30) as stale,
      count(*) filter (where newest_date < (select d from now_ts) - 30) as outdated,
      count(*) filter (where newest_date is null) as never_priced
    from newest
  ),
  attempts as (
    select a.*
    from public.price_sync_attempts a
    join watched w on w.card_variant_id = a.card_variant_id
  ),
  fx_latest as (
    select base_currency, max(rate_date) as newest_date
    from public.fx_rates
    where quote_currency = 'NOK' and source = 'norges_bank' and base_currency in ('EUR', 'USD')
    group by base_currency
  ),
  fx_gaps as (
    select c.cur as base_currency,
           count(*) filter (
             where not exists (
               select 1 from public.fx_rates fr
               where fr.base_currency = c.cur and fr.quote_currency = 'NOK'
                 and fr.source = 'norges_bank' and fr.rate_date = g.day::date)
           ) as missing_weekdays
    from (values ('EUR'), ('USD')) as c(cur)
    cross join generate_series(
      (select d from now_ts) - 30, (select d from now_ts) - 1, interval '1 day') as g(day)
    where extract(isodow from g.day) < 6
    group by c.cur
  ),
  latest_catalog_run as (
    select distinct on (language, tcgdex_set_id) language, tcgdex_set_id, status, error, finished_at
    from public.catalog_sync_runs
    where finished_at is not null
    order by language, tcgdex_set_id, finished_at desc
  ),
  checks as (
    -- ── ingest-prices ─────────────────────────────────────────────────────────────────────────
    select 10 as ord, 'ingest_prices_minutes_since_last_run' as check_name,
      case when (select prices from last_ok) is null then 'FAIL'
           when now() - (select prices from last_ok) > interval '180 minutes' then 'FAIL'
           when now() - (select prices from last_ok) > interval '45 minutes' then 'WARN'
           else 'PASS' end as status,
      coalesce(round(extract(epoch from now() - (select prices from last_ok)) / 60)::text, 'never') as value,
      'a succeeded or partial run within 45 minutes (cron every 15)' as expectation
    union all select 11, 'ingest_prices_failed_runs_24h',
      case when count(*) filter (where status = 'failed') = 0 then 'PASS'
           when count(*) filter (where status = 'failed') * 2 >= greatest(count(*), 1) then 'FAIL'
           else 'WARN' end,
      count(*) filter (where status = 'failed')::text || ' of ' || count(*)::text,
      '0 failed runs' from prices_24h
    union all select 12, 'ingest_prices_partial_runs_24h',
      case when count(*) filter (where status = 'partial') = 0 then 'PASS' else 'WARN' end,
      count(*) filter (where status = 'partial')::text, 'partial runs are explained by their error text' from prices_24h
    union all select 13, 'ingest_prices_runs_stopped_early_24h',
      case when count(*) filter (where error like '%stopped:%') = 0 then 'PASS' else 'WARN' end,
      count(*) filter (where error like '%stopped:%')::text,
      '0 runs stopped by the provider breaker or the deadline' from prices_24h
    union all select 14, 'ingest_prices_runs_with_rejected_rows_24h',
      case when count(*) filter (where error like '%rejected_rows=%') = 0 then 'PASS' else 'WARN' end,
      count(*) filter (where error like '%rejected_rows=%')::text,
      '0 runs in which the database refused a row' from prices_24h
    -- ── freshness of what is owned ────────────────────────────────────────────────────────────
    union all select 20, 'watched_variants_total', 'INFO', total::text, 'owned printings that get prices' from freshness
    union all select 21, 'watched_variants_fresh_pct',
      case when total = 0 then 'INFO'
           when fresh * 100 < total * 50 then 'FAIL'
           when fresh * 100 < total * 80 then 'WARN' else 'PASS' end,
      case when total = 0 then 'n/a' else round(fresh * 100.0 / total, 1)::text end,
      '>= 80% with a snapshot newer than 3 days' from freshness
    union all select 22, 'watched_variants_stale', 'INFO', stale::text, 'newest snapshot 4-30 days old (shown as stale)' from freshness
    union all select 23, 'watched_variants_outdated',
      case when outdated = 0 then 'PASS' else 'WARN' end, outdated::text,
      'newest snapshot older than 30 days (valued as missing)' from freshness
    union all select 24, 'watched_variants_never_priced', 'INFO', never_priced::text,
      'no snapshot yet: new, or the provider has no price for that printing' from freshness
    -- ── the work queue ────────────────────────────────────────────────────────────────────────
    union all select 30, 'queue_oldest_attempt_age_hours',
      case when count(*) filter (where last_outcome <> 'no_price') = 0 then 'INFO'
           when now() - min(last_attempt_at) filter (where last_outcome <> 'no_price') > interval '96 hours' then 'FAIL'
           when now() - min(last_attempt_at) filter (where last_outcome <> 'no_price') > interval '48 hours' then 'WARN'
           else 'PASS' end,
      coalesce(round(extract(epoch from now() - min(last_attempt_at) filter (where last_outcome <> 'no_price')) / 3600)::text, 'n/a'),
      'every priced variant attempted within 48 hours' from attempts
    union all select 31, 'queue_variants_provider_failed_3_in_a_row',
      case when count(*) filter (where consecutive_failed >= 3) = 0 then 'PASS' else 'WARN' end,
      count(*) filter (where consecutive_failed >= 3)::text, '0 variants failing repeatedly' from attempts
    union all select 32, 'queue_variants_unpriced_backed_off', 'INFO',
      count(*) filter (where last_outcome = 'no_price')::text,
      'retried every 1-7 days; the provider has no price for them' from attempts
    union all select 33, 'queue_variants_unpriced_for_7_attempts_or_more', 'INFO',
      count(*) filter (where consecutive_unpriced >= 7)::text, 'candidates for a manual look' from attempts
    -- ── FX ────────────────────────────────────────────────────────────────────────────────────
    union all select 40, 'ingest_fx_hours_since_last_success',
      case when (select fx from last_ok) is null then 'FAIL'
           when now() - (select fx from last_ok) > interval '56 hours' then 'FAIL'
           when now() - (select fx from last_ok) > interval '30 hours' then 'WARN'
           else 'PASS' end,
      coalesce(round(extract(epoch from now() - (select fx from last_ok)) / 3600)::text, 'never'),
      'a succeeded run within 30 hours (daily)'
    union all select 41, 'fx_newest_rate_age_days_' || c.cur,
      case when l.newest_date is null then 'FAIL'
           when (select d from now_ts) - l.newest_date > 7 then 'FAIL'
           when (select d from now_ts) - l.newest_date > 5 then 'WARN'
           else 'PASS' end,
      coalesce(((select d from now_ts) - l.newest_date)::text, 'none'),
      'newest Norges Bank rate no older than 5 days (holiday weekends reach 4-5)'
    from (values ('EUR'), ('USD')) as c(cur) left join fx_latest l on l.base_currency = c.cur
    union all select 42, 'fx_missing_weekdays_30d_' || g.base_currency,
      case when g.missing_weekdays > 8 then 'FAIL' when g.missing_weekdays > 4 then 'WARN' else 'PASS' end,
      g.missing_weekdays::text, 'a few (bank holidays); many means missed ingest days'
    from fx_gaps g
    -- ── data integrity ────────────────────────────────────────────────────────────────────────
    union all select 50, 'snapshots_future_dated',
      case when count(*) = 0 then 'PASS' else 'FAIL' end, count(*)::text,
      '0 (a future date pins a variant "fresh" for good)'
    from public.price_snapshots where snapshot_date > current_date + 1
    union all select 51, 'snapshots_negative_value',
      case when count(*) = 0 then 'PASS' else 'FAIL' end, count(*)::text, '0'
    from public.price_snapshots where value_minor < 0
    union all select 52, 'snapshots_provider_updated_in_the_future',
      case when count(*) = 0 then 'PASS' else 'WARN' end, count(*)::text, '0'
    from public.price_snapshots where provider_updated_at > now() + interval '1 day'
    -- ── catalog ───────────────────────────────────────────────────────────────────────────────
    union all select 60, 'catalog_sets_whose_latest_sync_failed_or_was_incomplete',
      case when count(*) filter (where status = 'failed' or error is not null) = 0 then 'PASS' else 'WARN' end,
      count(*) filter (where status = 'failed' or error is not null)::text,
      '0 (re-run the listed sets with scripts/run-catalog-sync.mjs --only=<id>)'
    from latest_catalog_run
    union all select 61, 'catalog_active_cards_without_an_active_variant',
      case when count(*) = 0 then 'PASS' else 'WARN' end, count(*)::text,
      '0 (such a card cannot be priced or added)'
    from public.cards c
    where c.is_active and not exists (
      select 1 from public.card_variants v where v.card_id = c.id and v.is_active)
    union all select 62, 'catalog_inactive_cards_pct',
      case when count(*) = 0 then 'INFO'
           when count(*) filter (where not is_active) * 100 > count(*) * 10 then 'WARN' else 'PASS' end,
      case when count(*) = 0 then 'n/a'
           else round(count(*) filter (where not is_active) * 100.0 / count(*), 2)::text end,
      '< 10% (a jump means a bad sync deactivated cards)'
    from public.cards
    union all select 63, 'catalog_days_since_last_successful_set_sync', 'INFO',
      coalesce(((select d from now_ts) - (select max(finished_at)::date from public.catalog_sync_runs where status = 'succeeded'))::text, 'never'),
      'the catalog is refreshed by hand; context only'
    -- ── scheduling ────────────────────────────────────────────────────────────────────────────
    union all select 70, 'cron_ingest_jobs_active',
      case when count(*) filter (where active and jobname in ('m9-ingest-prices', 'm9-ingest-fx')) = 2 then 'PASS' else 'FAIL' end,
      count(*) filter (where active and jobname in ('m9-ingest-prices', 'm9-ingest-fx'))::text || ' of 2',
      'both ingest jobs active in the environment that should be ingesting'
    from cron.job
    union all select 71, 'ingest_dispatch_target_configured', 'INFO',
      (select count(*) filter (where base_url is not null)::text from public.environment_ingest_config),
      '1 only in the environment that should ingest; 0 everywhere else (P137)'
  )
select check_name, status, value, expectation
from (
  select ord, check_name, status, value, expectation from checks
  union all
  select 999, 'overall',
    case when count(*) filter (where status = 'FAIL') > 0 then 'FAIL'
         when count(*) filter (where status = 'WARN') > 0 then 'WARN' else 'PASS' end,
    count(*) filter (where status = 'FAIL')::text || ' FAIL, ' || count(*) filter (where status = 'WARN')::text || ' WARN',
    'PASS before a release'
  from checks
) all_rows
order by ord, check_name;
