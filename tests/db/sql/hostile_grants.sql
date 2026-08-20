-- Put the database into the state the deployed project was actually in when M4 found the
-- escalation, so CI can prove the hardening migration climbs back out of it.
--
-- WHAT THIS REPRODUCES. `pokeportfolio-dev` carried the legacy `auto_expose_new_tables` behaviour:
-- every new public-schema table and function arrived with privileges already granted to `anon` and
-- `authenticated`. The local stack CI uses does not. So M3's column-restricted
-- `grant update (display_name, …) on profiles` — written to mean "these columns and no others" —
-- added nothing to a role that already held everything, and a signed-in non-admin could
-- `PATCH /rest/v1/profiles` with `{"is_admin": true}`. The authorization suite was green the whole
-- time, because a suite that starts from a clean database can only ever test a clean database.
--
-- THE POINT. Correct migrations are not the same property as convergent ones. Everything M4 fixed
-- was verified against a database that had never been wrong. This file makes the database wrong
-- first, in exactly the way the real one was, and .github/workflows/ci.yml then re-applies
-- supabase/migrations/20260820140000_m41_privilege_baseline.sql and requires
-- scripts/grant-audit.sql to come back clean. The bug is now something CI can fail on.
--
-- Run against an ephemeral test database only. It grants `anon` full write access to every table
-- in the schema; it exists to be undone by the statement that runs after it. There is no guard
-- preventing it from being run somewhere real, because a guard would be one more thing to get
-- wrong — the protection is that it lives under tests/ and CI is the only caller.

grant create on schema public to anon, authenticated;
grant all on all tables in schema public to anon, authenticated;
grant all on all sequences in schema public to anon, authenticated;
grant execute on all routines in schema public to anon, authenticated;

-- The standing instruction, which is the half a one-off sweep cannot fix: from here, every table a
-- later migration creates arrives pre-granted.
alter default privileges for role postgres in schema public
  grant all on tables to anon, authenticated;
alter default privileges for role postgres in schema public
  grant all on sequences to anon, authenticated;
alter default privileges for role postgres in schema public
  grant execute on functions to anon, authenticated;

-- Confirm the hostile state is genuinely hostile. A regression test that silently sets up nothing
-- passes forever and proves nothing, which is the failure mode this whole exercise is about.
do $$
declare
  v_can_set_admin boolean;
  v_anon_reads_claims boolean;
begin
  select has_column_privilege('authenticated', 'public.profiles', 'is_admin', 'UPDATE')
    into v_can_set_admin;
  select has_table_privilege('anon', 'public.invitation_claims', 'SELECT')
    into v_anon_reads_claims;

  if not v_can_set_admin or not v_anon_reads_claims then
    raise exception
      'hostile grant setup did not take effect (is_admin writable: %, anon reads claims: %) — '
      'the convergence test that follows would prove nothing',
      v_can_set_admin, v_anon_reads_claims;
  end if;

  raise notice
    'hostile state established: authenticated can write profiles.is_admin, anon can read '
    'invitation_claims. Re-applying the privilege baseline must remove both.';
end;
$$;
