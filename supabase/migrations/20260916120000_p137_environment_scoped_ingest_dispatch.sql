-- P137 — disaster-recovery/environment-isolation fix for P130-12.
--
-- PROBLEM (proven locally before this migration was written; see ai_outputs P137 evidence):
-- 20260826120050_m9_cron_schedule.sql:39,56 puts the Production project's edge-function hostname
-- literally inside the two `cron.schedule(...)` command bodies. Because a database gets its cron
-- jobs the same way it gets every other object — by having the migration replayed against it — any
-- database that has ever had all migrations applied (a fresh local `supabase db reset`, a CI
-- ephemeral stack, or a future restored database that replays migrations to reconstruct
-- application behaviour) ends up with an ACTIVE, hardcoded-URL cron job that fires every 15
-- minutes, indefinitely, with no per-environment opt-in. The only reason this has not produced a
-- real Production side effect anywhere it has run is that `vault.decrypted_secrets` has no
-- `price_sync_secret` row outside the real Production project, so the Authorization header is
-- always empty and the target function's own bearer check (supabase/functions/ingest-prices/
-- index.ts:79-83) answers 401 before touching the database. That is a lucky, incidental backstop
-- (an empty secret), not a designed one — and it is exactly the kind of thing a restored or
-- promoted environment could accidentally acquire (e.g. a Vault dump that DOES carry the secret,
-- or a future restore path that copies Vault state). P131's local/CI harnesses work around this
-- today by manually calling `cron.alter_job(active := false)` immediately after this migration
-- runs, every single time — a safety workaround, not the target architecture (see W-8 in
-- ai_outputs/Claude_outputs/output_131.txt and the carried-forward note in output_132_i.txt).
--
-- FIX. `20260826120050_m9_cron_schedule.sql` already exists on Production and is never edited
-- (CLAUDE.md "Never edit an applied migration"). This migration instead makes the cron *commands*
-- environment-generic and moves the only environment-specific fact — "what Production's ingest
-- base URL is" — out of every migration and into a plain, empty-by-default settings row that no
-- migration ever populates. `cron.schedule(name, schedule, command)` updates an existing job in
-- place when called again with the same name (m9's own comment, re-verified against current
-- Supabase docs), so re-scheduling the same two job names here is additive and reversible, exactly
-- like 20260901120000_p42_cron_cadence.sql already does for a different job.
--
-- Fail-closed by construction, not by a follow-up step: `public.dispatch_ingest_call` reads
-- `public.environment_ingest_config` and does nothing at all — no `net.http_post`, no queued
-- request, nothing to redirect or intercept — whenever that table has no row or `base_url` is
-- null. A fresh `supabase db reset` never inserts a row (this migration creates the table but
-- performs no INSERT), so there is no window, however brief, in which the literal Production
-- hostname exists anywhere in a fresh or restored database. Enabling real dispatch is a one-time,
-- out-of-band operator action against the real Production project only — the same operational
-- shape the `price_sync_secret` Vault entry already has (m9's own comment: "set out-of-band, once,
-- directly against the real project — never in this file"). This migration does not perform that
-- step and does not know the Production URL; nothing here is Production-specific.
--
-- REJECTED ALTERNATIVES (recorded per the P137 prompt; see output_137.txt §6 for the fuller
-- comparison):
--   A. "migration creates jobs disabled, Production enables them explicitly" — rejected: an
--      operator (or a future migration) that flips `active := true` without also knowing to
--      restore the URL/secret reintroduces exactly today's bug; disabling is a boolean anyone can
--      flip back, not a missing fact that fails closed by itself.
--   B. "generic Vault-configured base URL, absent locally" — Vault is scoped to secrets, and the
--      base URL is explicitly documented as non-secret (m9's own comment). Reusing Vault for a
--      non-secret adds no safety over a plain table and would blur why the *actual* secret
--      (`price_sync_secret`) lives there. Vault is unaffected by this migration.
--   D. "environment-specific scheduling entirely outside schema migrations" — rejected as more
--      complex for this project: it would need a second deployment mechanism (e.g. a hand-run SQL
--      script kept outside `supabase/migrations/`) purely to schedule two `pg_cron` jobs, losing
--      the "every environment gets the same reproducible migration set" property for no extra
--      safety over Option C, which already keeps the job schedule itself in ordinary migrations
--      and only the URL out of band.
-- Chosen: C ("wrapper function that refuses execution unless the target is explicitly
-- configured"), combined with A's shape only for the *name* of the jobs (same two job names,
-- re-scheduled in place) so the cron schedule itself stays fully reproducible and auditable from
-- migrations alone.
--
-- HOSTED ROLLOUT NOTE (not performed by this migration or by P137 — see output_137.txt): the
-- moment this migration is applied to Production, the two ingest jobs stop calling out (the config
-- table starts empty there too) until an operator runs, once, directly against Production and
-- never commits:
--   insert into public.environment_ingest_config (id, base_url, configured_note)
--   values (true, 'https://<production-project-ref>.supabase.co', 'production ingest dispatch')
--   on conflict (id) do update set base_url = excluded.base_url, configured_at = now();
-- This is a coordinated-deploy concern (ingestion pauses until the row is set) of the same shape
-- P136 already handled for the JPY FX change, and must be planned for explicitly before this
-- migration ever reaches Production.

-- ── 1. Environment identity: empty by default everywhere, set only by an out-of-band operator ──

create table public.environment_ingest_config (
  id boolean primary key default true,
  base_url text,
  configured_at timestamptz,
  configured_note text,
  constraint environment_ingest_config_singleton check (id),
  constraint environment_ingest_config_url_shape
    check (base_url is null or base_url ~ '^https://[a-z0-9-]+\.supabase\.co$')
);

comment on table public.environment_ingest_config is
  'Singleton, service-role-only. Empty (base_url null) in every environment except the one an '
  'operator has explicitly configured out-of-band. Never populated by a migration — see '
  '20260916120000_p137_environment_scoped_ingest_dispatch.sql. A restored or freshly-migrated '
  'database always starts with zero rows here, which is what keeps outbound ingest dispatch '
  'disabled by default (P130-12/P137).';

alter table public.environment_ingest_config enable row level security;
-- No policies: RLS with zero policies denies every row to every non-bypassing role, including
-- authenticated and anon. Only service_role (which bypasses RLS) and the migration/cron-owning
-- role (postgres) can read or write this table — same posture as public.price_sync_runs.

revoke all on public.environment_ingest_config from public, anon, authenticated;
grant select, insert, update on public.environment_ingest_config to service_role;

-- ── 2. The only place the ingest base URL is ever assembled ──────────────────────────────────

create function public.dispatch_ingest_call(p_function_path text)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_base_url text;
  v_secret text;
begin
  select c.base_url into v_base_url from public.environment_ingest_config c where c.id;

  if v_base_url is null then
    -- Fail closed: no configured target in this environment (the default for every fresh,
    -- restored, CI or local database). No net.http_post, no queued request, nothing to redirect.
    raise log 'dispatch_ingest_call: no environment_ingest_config.base_url set — % not dispatched',
      p_function_path;
    return;
  end if;

  select decrypted_secret into v_secret
  from vault.decrypted_secrets
  where name = 'price_sync_secret';

  perform net.http_post(
    url := v_base_url || p_function_path,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || coalesce(v_secret, '')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000
  );
end;
$$;

comment on function public.dispatch_ingest_call(text) is
  'Environment-generic cron dispatch target for the ingest edge functions (P130-12/P137). Contains '
  'no Production hostname; reads it from environment_ingest_config, which is empty by default. '
  'Only cron (running as the job-owning role) is expected to call this — no EXECUTE grant is given '
  'to public/anon/authenticated (see the privilege sweep in the latest *_privilege_baseline.sql, '
  'which this function is subject to like every other routine in schema public).';

revoke execute on function public.dispatch_ingest_call(text) from public, anon, authenticated;

-- ── 3. Re-point the two existing job names at the generic dispatcher ─────────────────────────
-- `cron.schedule` with an existing job name updates it in place (m9's own comment, re-verified).
-- This does not touch 'm9-retention-thin' (m9_cron_schedule.sql:69-73): that job is a same-database
-- SQL call with no URL and was never part of P130-12.

select cron.schedule(
  'm9-ingest-prices',
  '*/15 * * * *',
  $$select public.dispatch_ingest_call('/functions/v1/ingest-prices');$$
);

select cron.schedule(
  'm9-ingest-fx',
  '0 17 * * *',
  $$select public.dispatch_ingest_call('/functions/v1/ingest-fx');$$
);
