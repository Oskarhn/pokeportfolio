-- M9 scheduled ingestion (prompt §22-26/§64/§98). Re-verified against current Supabase docs at
-- implementation time (docs.supabase.com/guides/cron and .../functions/schedule-functions,
-- 2026-08-26): the documented pattern is `pg_cron` + `pg_net`, with the Edge Function's own
-- authentication secret read from Supabase Vault at call time via `vault.decrypted_secrets`,
-- never a literal in the scheduled command or in any migration text. Job scheduling itself uses
-- `cron.schedule(name, schedule, command)`, which the current docs confirm updates an existing job
-- in place when called again with the same name, rather than accumulating duplicates — so this
-- migration is safe to have existed from the start rather than needing an unschedule-then-reschedule
-- dance.
--
-- The bearer secret itself (`price_sync_secret` in Vault, `PRICE_SYNC_SECRET` as the matching Edge
-- Function secret) is set out-of-band, once, directly against the real project — never in this
-- file, never logged, never asked of the owner in chat (prompt §24). Until that secret exists,
-- `vault.decrypted_secrets` simply has no matching row, the Authorization header pg_net sends is
-- null, and both Edge Functions correctly answer 401 — a safe failure mode, not a crash, and
-- exactly what a fresh CI ephemeral stack (which never has this secret) exercises on every run.
--
-- `net.http_post` is asynchronous — it queues the request and returns a `request_id` immediately;
-- pg_net's own background worker performs the actual HTTP call. This is why none of these jobs
-- need a timeout parameter here: pg_net enforces its own.

create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;

-- price_sync_runs (a service-role-only table) already gives per-invocation observability; the
-- job schedule itself is inspectable via `cron.job`/`cron.job_run_details` directly (prompt §65),
-- which needs no additional table here.

select cron.schedule(
  'm9-ingest-prices',
  '*/15 * * * *', -- every 15 minutes: ~96 batches/day at batch_size 200 comfortably cycles a
                  -- ~3-4k-variant watched set within a day (prompt §26), well under any
                  -- "considerate" TCGdex request-rate concern (API_SOURCES.md).
  $$
  select net.http_post(
    -- The project URL is public identifying information, not a secret (HANDOVER.md already
    -- states it in plaintext), so it is a literal here rather than a second Vault entry —
    -- environment-specific but harmless if read by anyone with database access.
    url := 'https://nopmkroeygmlvndzjjqs.supabase.co/functions/v1/ingest-prices',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization',
      'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'price_sync_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000
  ) as request_id;
  $$
);

select cron.schedule(
  'm9-ingest-fx',
  '0 17 * * *', -- daily, well after Norges Bank's ~16:00 CET publication window (API_SOURCES.md)
  $$
  select net.http_post(
    url := 'https://nopmkroeygmlvndzjjqs.supabase.co/functions/v1/ingest-fx',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization',
      'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'price_sync_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 20000
  ) as request_id;
  $$
);

-- Retention is a plain SQL function call, not an HTTP round trip — no Vault/pg_net needed for it.
select cron.schedule(
  'm9-retention-thin',
  '0 3 * * 0', -- weekly, Sunday 03:00 UTC — low frequency, prompt §64
  $$select public.thin_price_snapshots();$$
);
