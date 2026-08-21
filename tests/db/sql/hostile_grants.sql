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

-- M7: the PUBLIC-EXECUTE blind spot the M6 grant-audit could not see (M7 prompt §69-71). A
-- function created without the "revoke ... from public" step at creation time carries this grant
-- regardless of what is later revoked from anon/authenticated by name — reproduced here the same
-- way the anon/authenticated escalation above is, so the audit's new PUBLIC check has something
-- real to reject.
grant execute on all routines in schema public to public;

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
  v_public_can_call_is_admin boolean;
begin
  select has_column_privilege('authenticated', 'public.profiles', 'is_admin', 'UPDATE')
    into v_can_set_admin;
  select has_table_privilege('anon', 'public.invitation_claims', 'SELECT')
    into v_anon_reads_claims;

  -- has_function_privilege has no "PUBLIC" role to query against — PUBLIC is not a role, it is a
  -- separate ACL entry (grantee oid 0) — so this checks pg_proc.proacl directly, the same
  -- technique scripts/grant-audit.sql's new PUBLIC check uses.
  select exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    cross join lateral aclexplode(p.proacl) a
    where n.nspname = 'public' and p.proname = 'is_admin' and a.grantee = 0
  ) into v_public_can_call_is_admin;

  if not v_can_set_admin or not v_anon_reads_claims or not v_public_can_call_is_admin then
    raise exception
      'hostile grant setup did not take effect (is_admin writable: %, anon reads claims: %, '
      'PUBLIC can execute is_admin: %) — the convergence test that follows would prove nothing',
      v_can_set_admin, v_anon_reads_claims, v_public_can_call_is_admin;
  end if;

  raise notice
    'hostile state established: authenticated can write profiles.is_admin, anon can read '
    'invitation_claims, PUBLIC can execute is_admin(). Re-applying the privilege baseline must '
    'remove all three.';
end;
$$;
