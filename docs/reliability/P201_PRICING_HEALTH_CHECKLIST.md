# Pricing health checklist (read-only)

Run this before a release that touches the catalog, prices or exchange rates, and whenever a price looks
wrong. Everything below is **read-only**: it reads counts and ages from shared market-data tables, never
a user's rows, never a secret.

## 1. Run the check

```bash
pnpm exec supabase db query --linked -f scripts/pricing-health-diagnostics.sql
```

Or paste [`scripts/pricing-health-diagnostics.sql`](../../scripts/pricing-health-diagnostics.sql) into the
Supabase SQL editor (the `postgres` role can read the `cron` schema; the two scheduling checks need that).
The script is a single `SELECT`; a test runs it inside `BEGIN READ ONLY` to keep that true.

It prints one row per check: `check_name | status | value | expectation`, and a last row `overall`.

| Status | Meaning                                              |
| ------ | ---------------------------------------------------- |
| PASS   | as expected                                          |
| INFO   | context, no judgement                                |
| WARN   | explain it before releasing                          |
| FAIL   | do not release; look now                             |

**Release rule:** `overall` is `PASS`, or every `WARN` has a written explanation in the release record and
there is no `FAIL`. A `FAIL` on an environment that is deliberately not ingesting (a local stack, a restored
copy) is expected — say so; do not "fix" it by enabling ingestion there (P137).

## 2. What each check means and what to do

| Check                                                          | If it is not PASS                                                                                                                                                                                                                       |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ingest_prices_minutes_since_last_run`                         | The 15-minute cron has not produced a succeeded or partial run. Check `cron_ingest_jobs_active`, then the Edge Function logs for `ingest-prices` (`event: run_finished`). `never` on a fresh environment is normal.                     |
| `ingest_prices_failed_runs_24h`                                | Read the `error` column of the failed `price_sync_runs` rows. `provider: server_error=…` or `rate_limited=…` is the price source; `upsert:` is the database; `nothing fetched` means every request failed.                              |
| `ingest_prices_runs_stopped_early_24h`                         | The run stopped asking the provider (`stopped: provider_unhealthy` = five provider failures, `stopped: deadline` = the 38 s budget). Unattempted variants stay queued; repeated stops mean the provider is unwell or the batch too big. |
| `ingest_prices_runs_with_rejected_rows_24h`                    | The database refused individual rows (`rejected_rows=N`). Data the mapper should have dropped reached the write; find the variant and the provider payload shape and extend the mapper tests.                                           |
| `ingest_prices_partial_runs_24h`                               | Informational unless it is every run. Partial = some cards failed or were skipped.                                                                                                                                                      |
| `watched_variants_fresh_pct`                                   | Share of owned printings with a snapshot newer than 3 days. Below 80 % the portfolio values will show as stale; below 50 % treat ingestion as down.                                                                                    |
| `watched_variants_outdated`                                    | Owned printings whose newest snapshot is over 30 days old: valued as _missing_ in the portfolio.                                                                                                                                        |
| `watched_variants_never_priced`                                | Context. New acquisitions wait up to one cycle (~4.5 h at 3,500 variants); printings the provider has no price for stay here.                                                                                                           |
| `queue_oldest_attempt_age_hours`                               | Priced variants should all be attempted within 48 h. Above that the queue is not advancing — compare with `ingest_prices_minutes_since_last_run`.                                                                                       |
| `queue_variants_provider_failed_3_in_a_row`                    | A variant whose provider lookup keeps failing. Usually a card id the provider changed or removed (`not_found`).                                                                                                                         |
| `queue_variants_unpriced_*`                                    | Context: printings the provider has no price for back off 1–7 days instead of being retried every tick.                                                                                                                                 |
| `ingest_fx_hours_since_last_success`                           | Daily 17:00 UTC job. Over 30 h: check the `ingest-fx` logs and `fx_newest_rate_age_days_*`.                                                                                                                                             |
| `fx_newest_rate_age_days_EUR` / `_USD`                         | Norges Bank publishes business days only; 4–5 days over a holiday weekend is normal. Over 5 days is flagged, over 7 fails. Stale rates silently skew every NOK conversion (the portfolio resolver has no age bound).                    |
| `fx_missing_weekdays_30d_*`                                    | Weekdays in the last 30 days with no cached rate. A few are bank holidays; many mean missed ingest days (they backfill on the next successful run).                                                                                     |
| `snapshots_future_dated`                                       | Must be 0. A future `snapshot_date` pins a variant "fresh" for good. The write path and a trigger refuse it; a non-zero count means something bypassed both.                                                                           |
| `snapshots_negative_value`, `snapshots_provider_updated_…`     | Must be 0.                                                                                                                                                                                                                              |
| `catalog_sets_whose_latest_sync_failed_or_was_incomplete`      | The operator sync (`scripts/run-catalog-sync.mjs`) prints `incomplete: --language=… --only=…`; re-run those sets.                                                                                                                       |
| `catalog_active_cards_without_an_active_variant`               | Cards that cannot be priced or added.                                                                                                                                                                                                   |
| `catalog_inactive_cards_pct`                                   | A jump above 10 % means a sync deactivated cards it should not have (the listing-based rule prevents the known cause; investigate any jump).                                                                                            |
| `cron_ingest_jobs_active`                                      | Must be `2 of 2` where ingestion is meant to run.                                                                                                                                                                                       |
| `ingest_dispatch_target_configured`                            | `1` only in the environment that ingests; `0` everywhere else.                                                                                                                                                                          |

## 3. Reading the Edge Function logs

Every pricing function writes **one JSON object per line**: `{ "fn", "event", "level", ...fields }`.
Fields are numbers, booleans or short redacted strings; no provider payload, no header, no e-mail. Useful
filters in the Supabase log explorer:

- `fn = "ingest-prices"` and `event = "run_finished"` — status, counts per outcome, `stopped`.
- `event = "provider_failures"` (search-prices) — `failed_<class>` counters.
- `event = "fx_lookup_failed"`, `"norges_bank_failed"` — `failure_kind`.
- `event = "set_finished"` (sync-catalog) — `failure_count`.

Failure classes (`failure_kind`, `failed_<class>`): `timeout`, `network`, `rate_limited`, `server_error`,
`client_error`, `not_found`, `invalid_json`, `budget_exhausted`, `skipped` (never requested), `invalid_shape`,
`unexpected`.

## 4. What this check does not tell you

- Whether a price is _right_. It checks that data arrives, is recent and is well-formed.
- Anything about a user's collection or valuation.
- Anything on the Production frontend; it reads the backend's shared tables only.
