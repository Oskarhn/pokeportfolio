-- M4, part 1 of 4: fixes found by the adversarial review of the M3 foundation.
-- These are corrections to M3, kept in their own migration so the invite-only work that follows
-- reads as one story and this one can be reviewed on its own terms.
--
-- FINDING 1 — account deletion was impossible.
-- Every user-private table declares `user_id uuid not null references auth.users (id)` with no
-- ON DELETE action, so the FK defaults to NO ACTION. Deleting an auth.users row therefore fails
-- as soon as the user owns a single row anywhere. SECURITY.md §8 states account deletion removes
-- all user-private data by cascade and deletes the auth.users row; that was not true. It went
-- unnoticed because the M3 test fixture ignores the result of `auth.admin.deleteUser` and no M3
-- test ever created an invitation_redemptions row. M4 makes it load-bearing: the invite-only
-- backstop below references auth.users from invitation_claims, and the auth/invite suite creates
-- and deletes real users constantly.
--
-- FINDING 2 — SECURITY DEFINER functions inherited PUBLIC's default EXECUTE.
-- PostgreSQL grants EXECUTE on a new function to PUBLIC by default, and `authenticated`/`anon`
-- are members of PUBLIC. None of M3's functions were actually exploitable through that route
-- (handle_new_user returns `trigger` and cannot be called as an RPC; is_admin only reads the
-- caller's own flag), so this is hygiene rather than a live hole — but M4 adds functions where
-- it would be a hole, so the pattern is made uniform now: revoke from PUBLIC, then grant to
-- exactly the roles that need it.

-- ── Finding 1: cascade user-private data on account deletion ─────────────────────────────────
--
-- Constraint names are looked up rather than guessed. PostgreSQL's default name for these is
-- `<table>_<column>_fkey`, but a migration that silently no-ops because a name drifted is worse
-- than one that fails loudly, so this asserts it found something to alter.
do $$
declare
  target record;
  constraint_name text;
begin
  for target in
    select *
    from (values
      ('retailers', 'user_id'),
      ('storage_locations', 'user_id'),
      ('tags', 'user_id'),
      ('purchases', 'user_id'),
      ('purchase_lines', 'user_id'),
      ('holdings', 'user_id'),
      ('acquisition_lots', 'user_id'),
      ('invitation_redemptions', 'user_id')
    ) as t(table_name, column_name)
  loop
    select con.conname into constraint_name
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    join pg_attribute att
      on att.attrelid = con.conrelid and att.attnum = con.conkey[1]
    where con.contype = 'f'
      and nsp.nspname = 'public'
      and rel.relname = target.table_name
      and att.attname = target.column_name
      and array_length(con.conkey, 1) = 1;

    if constraint_name is null then
      raise exception 'expected a single-column foreign key on public.%(%), found none',
        target.table_name, target.column_name;
    end if;

    execute format('alter table public.%I drop constraint %I', target.table_name, constraint_name);
    execute format(
      'alter table public.%I add constraint %I foreign key (%I) references auth.users (id) on delete cascade',
      target.table_name, constraint_name, target.column_name
    );
  end loop;
end;
$$;

-- invitations.created_by is the exception: an invitation is an audit record of an administrative
-- action, and deleting the admin who issued it must not delete the record of it having existed.
-- created_by becomes nullable in the next migration for the bootstrap case; ON DELETE SET NULL is
-- the matching behaviour here.
alter table public.invitations drop constraint invitations_created_by_fkey;
alter table public.invitations
  add constraint invitations_created_by_fkey
  foreign key (created_by) references auth.users (id) on delete set null;

-- ── Finding 2: no function relies on PUBLIC's default EXECUTE ────────────────────────────────

revoke execute on function public.handle_new_user() from public;
revoke execute on function public.set_updated_at() from public;
revoke execute on function public.purchase_lines_check_owner() from public;
revoke execute on function public.acquisition_lots_check_owner() from public;

-- is_admin() and the two enum-to-text wrappers are deliberately callable — the wrappers are
-- evaluated as part of the holdings_identity index expression on every write, and is_admin() is
-- read by the invitations policies. They keep their explicit grants from M3; only the implicit
-- PUBLIC grant is withdrawn, so the reachable set is exactly what M3's GRANT statements name.
revoke execute on function public.is_admin() from public;
revoke execute on function public.card_condition_to_text(public.card_condition) from public;
revoke execute on function public.grader_to_text(public.grader) from public;
