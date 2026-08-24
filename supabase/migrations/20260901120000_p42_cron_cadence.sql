-- P42 — Owner-reported "Updating…" stuck for minutes + spend appearing stale after
-- Remove from Portfolio. Hosted diagnosis (2026-08-24, read-only) confirmed the canonical
-- ledger self-corrects synchronously (every quick-add test lot's parent purchase was already
-- auto-voided; zero ghost purchases; queue empty) — the reported symptoms were REFRESH latency:
--
--   1. Home polled nothing while pending_recompute was true, so the badge and figures sat on
--      the last fetched summary until some unrelated refetch happened (fixed in the app layer,
--      which polls dashboard-summary every 3 s ONLY while pending).
--   2. The recompute worker itself ran every 15 minutes at :07/:22/:37/:52, so a mutation at
--      :08 could legitimately stay pending until :22 — up to a quarter of an hour of honest,
--      avoidable staleness behind the badge.
--
-- THIS MIGRATION fixes 2: reschedules m12-recompute-snapshots to EVERY MINUTE.
--
-- Why this is cheap at this project's ≤10-user scale (measured, not assumed):
--   * Hosted cron.job_run_details show the no-op ticks at :07/:22/:37/:52 each completing in
--     ~0.0 s (one portfolio_recompute_runs row + one bounded queue scan). Frequency changes;
--     per-tick cost does not.
--   * drain_portfolio_recompute_queue is bounded (batch of 20 users, clamped ≤100), SKIP
--     LOCKED so an overlapping tick can never process another tick's rows destructively, and
--     its CI benchmark measures ~250 ms incremental work at ~480-lot scale — far above real
--     usage here. Worst case a big rebuild straddles two ticks; the second simply finds the
--     row gone or locked-and-skipped.
--   * A plain same-database SQL command (the M9 thin_price_snapshots pattern): no HTTP round
--     trip, no secret, no Edge Function invocation, no new grants — nothing here touches the
--     browser privilege surface, so no privilege-baseline migration accompanies this file.
--
-- Run-log growth is handled in the same stroke rather than left to silently accumulate:
-- one-minute ticks write ~1 440 tiny portfolio_recompute_runs rows/day (~52 MB/year with
-- indexes if never pruned — real money against the free-tier storage budget). A dedicated
-- nightly prune job keeps 30 days of run history (≈43 k rows, still ample diagnostics) and
-- stays deliberately SEPARATE from the daily sweep job: one single-statement command each,
-- independent failure isolation, and the sweep's own semantics are untouched.
--
-- Additive and reversible: unschedule-then-schedule of named jobs only, exactly like M12's
-- original cron migration. No table, function, grant or policy changes.

select cron.unschedule('m12-recompute-snapshots')
where exists (select 1 from cron.job where jobname = 'm12-recompute-snapshots');

select cron.schedule(
  'm12-recompute-snapshots',
  '* * * * *',
  $job$ select public.drain_portfolio_recompute_queue(20); $job$
);

select cron.unschedule('m12-run-log-prune')
where exists (select 1 from cron.job where jobname = 'm12-run-log-prune');

select cron.schedule(
  'm12-run-log-prune',
  '33 4 * * *',
  $job$ delete from public.portfolio_recompute_runs where started_at < now() - interval '30 days' $job$
);
