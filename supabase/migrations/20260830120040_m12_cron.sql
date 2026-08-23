-- M12 Dashboard — scheduled recompute maintenance (prompt §50-§52).
--
-- Two pg_cron entries, deliberately plain SQL commands against same-database functions (the
-- M9 thin_price_snapshots pattern — no HTTP round trip, no secret, no Edge Function):
--
--   m12-recompute-snapshots  every 15 minutes at :07/:22/:37/:52 — offset from M9's ingest
--                            ticks (*/15) so a freshly-ingested price batch is consumed on the
--                            NEXT tick instead of racing it. Bounded batch (20 users) is far
--                            above this project's ≤10-user scale.
--   m12-daily-snapshot-sweep daily 05:11 UTC — the §50 safety sweep: guarantees every user who
--                            owns anything gets a fresh current-date snapshot even with zero
--                            transactions and zero price/FX movement, and promotes any stranded
--                            future-dated dirty_from once its date has arrived.
--
-- NOT APPLIED ANYWHERE YET: this pilot stops at READY FOR CLAUDE REVIEW. Applying migrations to
-- pokeportfolio-dev and activating these cron rows are post-review deployment steps
-- (PENDING POST-REVIEW DEPLOYMENT VERIFICATION in output_20.txt).

select cron.unschedule('m12-recompute-snapshots')
where exists (select 1 from cron.job where jobname = 'm12-recompute-snapshots');

select cron.schedule(
  'm12-recompute-snapshots',
  '7,22,37,52 * * * *',
  $job$ select public.drain_portfolio_recompute_queue(20); $job$
);

select cron.unschedule('m12-daily-snapshot-sweep')
where exists (select 1 from cron.job where jobname = 'm12-daily-snapshot-sweep');

select cron.schedule(
  'm12-daily-snapshot-sweep',
  '11 5 * * *',
  $job$ select public.enqueue_portfolio_daily_maintenance(); $job$
);
