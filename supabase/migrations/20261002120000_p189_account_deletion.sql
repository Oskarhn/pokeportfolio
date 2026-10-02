-- P152: server-side account deletion.
--
-- What was true before this migration (verified against pg_constraint on a fresh stack, not taken
-- from SECURITY.md §8, which had gone stale):
--
--   * Eighteen tables reference auth.users(id) and cascade (a nineteenth uses SET NULL). FIVE do not — `sales`, `sale_lines`,
--     `lot_disposals`, `lot_cost_adjustments` (user_id) and `sealed_products.created_by_user_id`
--     kept the default NO ACTION, so `auth.admin.deleteUser` failed for any user who had ever
--     recorded a sale or created a private sealed product. No delete-account capability could
--     ever have worked for a user with a sale.
--   * `invitations.email` / `invitations.label` (an address someone else typed in on the person's
--     behalf) survive the person's deletion untouched — the invitation is kept as an admin audit
--     record and nothing scrubbed the personal fields on it.
--   * Nothing recorded that an account was being deleted, so nothing could stop a still-valid
--     session writing new rows into an account half-way through removal.
--
-- This migration is destructive machinery, so it is deliberately narrow. Nothing here is callable
-- by `anon` or `authenticated`: the only caller is the `delete-account` Edge Function, which
-- derives the target user from a server-verified bearer token and re-verifies the password
-- (docs/SECURITY.md §8). The SQL below trusts the user id it is handed and therefore must never
-- become browser-reachable; grant-audit.sql, tests/authorization/function_grants.test.ts and
-- tests/authorization/p152_account_deletion_attacks.test.ts assert exactly that.
--
-- Atomicity, stated honestly. A database transaction cannot span Postgres, the Auth Admin API and
-- an external service. The design is a short, idempotent state machine instead:
--
--   1. begin_account_deletion   commits a "pending" row      (own transaction; makes writes stop)
--   2. purge_account_data       deletes every user-owned row (in batches; each batch atomic)
--   3. auth.admin.deleteUser    removes the login             (Auth Admin API; retryable)
--   4. scrub_account_audit_trail removes GoTrue audit rows    (best effort; never fatal)
--
-- A failure between steps leaves an account that is pending and write-blocked, with some or all of
-- its data removed, and every step can simply be run again. See docs/SECURITY.md §8 and docs/DEVELOPMENT.md
-- for the operator recovery procedure.

-- ── 1. Finish the cascade ────────────────────────────────────────────────────────────────────
--
-- Same lookup-then-alter shape as M4 (20260820120000): constraint names are found, not guessed,
-- and the migration fails loudly if one has drifted rather than silently doing nothing.
--
-- sealed_products.created_by_user_id is CASCADE, deliberately not SET NULL. A NULL creator marks a
-- row as shared catalog (policy sealed_products_read: `created_by_user_id IS NULL OR = auth.uid()`),
-- so SET NULL would silently publish a departing user's private product definitions to every other
-- user. If another user's row somehow references such a product, the delete fails on that foreign
-- key and the whole purge rolls back — fail closed, never cascade into someone else's data.
do $$
declare
  target record;
  constraint_name text;
begin
  for target in
    select *
    from (values
      ('sales', 'user_id'),
      ('sale_lines', 'user_id'),
      ('lot_disposals', 'user_id'),
      ('lot_cost_adjustments', 'user_id'),
      ('sealed_products', 'created_by_user_id')
    ) as t(table_name, column_name)
  loop
    select con.conname into constraint_name
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    join pg_attribute att
      on att.attrelid = con.conrelid and att.attnum = con.conkey[1]
    where con.contype = 'f'
      and con.confrelid = 'auth.users'::regclass
      and nsp.nspname = 'public'
      and rel.relname = target.table_name
      and att.attname = target.column_name
      and array_length(con.conkey, 1) = 1;

    if constraint_name is null then
      raise exception 'expected a single-column foreign key from public.%(%) to auth.users, found none',
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

-- ── 2. The pending-deletion record ───────────────────────────────────────────────────────────
--
-- One row per account whose deletion has been authorised. It is deliberately NOT a tombstone: the
-- foreign key cascades, so the row disappears together with the auth user and no record of who was
-- deleted is kept (data minimisation). It carries no personal data — a uuid, timestamps, a counter
-- and a coarse stage label.
create table public.account_deletion_requests (
  user_id uuid primary key references auth.users (id) on delete cascade,
  requested_at timestamptz not null default now(),
  last_attempt_at timestamptz not null default now(),
  attempt_count integer not null default 1 check (attempt_count >= 1),
  last_stage text not null default 'requested'
    check (last_stage in ('requested', 'purge_failed', 'purged', 'auth_delete_failed'))
);

comment on table public.account_deletion_requests is
  'P152: accounts whose deletion has been authorised (fresh password verified server-side). '
  'Presence means: writes are blocked by account_deletion_write_guard, and purge_account_data / '
  'auth deletion may run and be retried. Service-role only; cascades away with the auth user, so '
  'no tombstone survives a completed deletion.';

-- RLS on every table (CLAUDE.md). No policy exists on purpose: `anon` and `authenticated` are
-- denied outright, and holding no table privilege either (see the grants below) makes that
-- doubly true. `service_role` bypasses RLS.
alter table public.account_deletion_requests enable row level security;

revoke all on table public.account_deletion_requests from public, anon, authenticated;
grant all on table public.account_deletion_requests to service_role;

-- ── 3. Write guard ───────────────────────────────────────────────────────────────────────────
--
-- A pending account must not accept NEW rows. Without this, a second tab (or a stolen token) could
-- keep recording purchases into an account between "data purged" and "login deleted" — the
-- "surviving session recreating rows" failure. It is INSERT-only, statement-level and reads the
-- transition table, so a bulk insert costs one indexed join, not one lookup per row:
--
--   * INSERT only: the purge itself only deletes, and the two ON DELETE SET NULL cascades it
--     triggers are UPDATEs (profiles.default_storage_location_id, acquisition_lots.storage_location_id),
--     so the guard never has to be bypassed — there is no "purge mode" switch for anyone to abuse.
--   * Raised AFTER the insert, inside the same statement, so the statement — and any surrounding
--     RPC transaction — aborts and rolls back: the row is never committed.
--   * SECURITY DEFINER because `authenticated` cannot read the requests table; search_path is
--     empty and every reference is schema-qualified.
--
-- Not attached to portfolio_snapshots / portfolio_recompute_queue: those are system-derived, and
-- anything the recompute worker writes there for a pending user is swept by the final auth-user
-- cascade (and by the purge's own deletes on retry).
create or replace function public.account_deletion_write_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1
    from new_rows n
    join public.account_deletion_requests r on r.user_id = n.user_id
  ) then
    raise exception 'account_deletion_pending'
      using errcode = 'P0001',
            hint = 'This account is being deleted and no longer accepts changes.';
  end if;
  return null;
end;
$$;

-- sealed_products carries its owner in created_by_user_id, and NULL there means shared catalog.
create or replace function public.account_deletion_write_guard_sealed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1
    from new_rows n
    join public.account_deletion_requests r on r.user_id = n.created_by_user_id
  ) then
    raise exception 'account_deletion_pending'
      using errcode = 'P0001',
            hint = 'This account is being deleted and no longer accepts changes.';
  end if;
  return null;
end;
$$;

do $$
declare
  t text;
begin
  foreach t in array array[
    'retailers', 'storage_locations', 'tags',
    'purchases', 'purchase_lines',
    'holdings', 'acquisition_lots', 'manual_card_definitions',
    'holding_tags', 'manual_valuations',
    'custom_collections', 'custom_collection_members',
    'sales', 'sale_lines', 'lot_disposals', 'lot_cost_adjustments',
    'openings'
  ]
  loop
    execute format(
      'create trigger account_deletion_guard after insert on public.%I '
      'referencing new table as new_rows for each statement '
      'execute function public.account_deletion_write_guard()',
      t
    );
  end loop;
end;
$$;

create trigger account_deletion_guard
  after insert on public.sealed_products
  referencing new table as new_rows
  for each statement
  execute function public.account_deletion_write_guard_sealed();

-- ── 4. Service-role-only operations ──────────────────────────────────────────────────────────

-- Step 1. Idempotent and safe to call from any number of parallel requests: every call converges
-- on the same single row and bumps the attempt counter. The foreign key makes a call for a user
-- that no longer exists fail, which the Edge Function reads as "already deleted".
create or replace function public.begin_account_deletion(p_user_id uuid)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_requested_at timestamptz;
begin
  if p_user_id is null then
    raise exception 'user id required';
  end if;

  insert into public.account_deletion_requests as r (user_id)
  values (p_user_id)
  on conflict (user_id) do update
    set last_attempt_at = now(),
        attempt_count = r.attempt_count + 1,
        last_stage = 'requested'
  returning r.requested_at into v_requested_at;

  return v_requested_at;
end;
$$;

-- Step 2. Deletes every row the user owns, in BATCHES, in the same child-first order
-- reset_my_portfolio_data() uses (which is the FK order — nothing here relies on cascade
-- ordering), and then goes further than the reset does: it also removes the user's definitions
-- (retailers, storage locations, tags, collections, manual cards, private sealed products), the
-- personal fields on the profile and the personal fields on the invitation that created the
-- account. What it deliberately LEAVES is the auth user, the profile row shell and the
-- invitation_redemptions row: those go with the auth user, and keeping them means a retry after a
-- failed auth deletion can still find the invitation to scrub.
--
-- Why batches. A first version deleted everything in ONE call and was measured against a 10,000-lot
-- synthetic account on the local stack: it hit PostgREST's 8-second statement timeout
-- ("canceling statement due to statement timeout") and so could never complete, and a plain
-- `auth.admin.deleteUser` on the same account hit GoTrue's 10-second budget. Each call here deletes
-- at most p_max_rows rows and reports `complete`; the Edge Function calls it until it does. Every
-- call is one atomic transaction, so what a failure can leave behind is "a child-first prefix of the
-- tables emptied, everything else untouched" — never a half-deleted table with dangling children,
-- because a table is only started once every table before it (its children) is empty. That
-- intermediate state is not reachable by the person: the account is write-blocked by the pending
-- row, and every call is idempotent and safe to repeat.
--
-- Never touched: the global catalog (card_series, card_sets, cards, card_variants, price_snapshots,
-- fx_rates, catalog_sync_runs, price_sync_runs, portfolio_recompute_runs, environment_ingest_config)
-- and sealed_products rows whose created_by_user_id is NULL. Deleting a user must never delete
-- something a different user's holdings point at.
--
-- Idempotent: a call on an already-purged account deletes nothing and reports complete. Serialised
-- per call with an advisory lock so two parallel requests cannot interleave inside one batch.
-- Refuses to run for an account that has not been through begin_account_deletion, so a bug in a
-- future caller cannot use it to wipe an account that never authorised deletion.
create or replace function public.purge_account_data(p_user_id uuid, p_max_rows integer default 1000)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_step record;
  v_counts jsonb := '{}'::jsonb;
  v_left integer := p_max_rows;
  v_n bigint;
  v_complete boolean := true;
begin
  if p_user_id is null then
    raise exception 'user id required';
  end if;
  if p_max_rows is null or p_max_rows < 1 or p_max_rows > 100000 then
    raise exception 'p_max_rows must be between 1 and 100000';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('p152:purge_account_data:' || p_user_id::text, 0));

  if not exists (
    select 1 from public.account_deletion_requests r where r.user_id = p_user_id
  ) then
    raise exception 'account_deletion_not_requested';
  end if;

  -- The order is the foreign-key order: every table appears AFTER everything that references it.
  -- Step 1 is the M12 recompute queue, so no drain can resurrect derived state mid-purge (same
  -- reasoning as reset_my_portfolio_data step 0). Opening-linked pull lots (`opening_id is not
  -- null`) go before openings, which reference source lots. Owner column and any extra predicate
  -- are per step; sealed_products is matched on its creator so shared catalog rows (NULL creator)
  -- can never be selected. If another user's row references a private sealed product the delete
  -- fails on the foreign key and the whole call rolls back — fail closed.
  for v_step in
    select * from (values
      (1,  'portfolio_recompute_queue',  'user_id',            ''),
      (2,  'lot_disposals',              'user_id',            ''),
      (3,  'sale_lines',                 'user_id',            ''),
      (4,  'sales',                      'user_id',            ''),
      (5,  'lot_cost_adjustments',       'user_id',            ''),
      (6,  'manual_valuations',          'user_id',            ''),
      (7,  'custom_collection_members',  'user_id',            ''),
      (8,  'holding_tags',               'user_id',            ''),
      (9,  'acquisition_lots',           'user_id',            'opening_id is not null'),
      (10, 'openings',                   'user_id',            ''),
      (11, 'acquisition_lots',           'user_id',            ''),
      (12, 'purchase_lines',             'user_id',            ''),
      (13, 'purchases',                  'user_id',            ''),
      (14, 'holdings',                   'user_id',            ''),
      (15, 'portfolio_snapshots',        'user_id',            ''),
      (16, 'custom_collections',         'user_id',            ''),
      (17, 'tags',                       'user_id',            ''),
      (18, 'retailers',                  'user_id',            ''),
      (19, 'storage_locations',          'user_id',            ''),
      (20, 'manual_card_definitions',    'user_id',            ''),
      (21, 'sealed_products',            'created_by_user_id', '')
    ) as s(ord, tbl, col, extra)
    order by ord
  loop
    execute format(
      'delete from public.%1$I x where x.ctid = any (array('
        'select y.ctid from public.%1$I y where y.%2$I = $1 %3$s limit $2))',
      v_step.tbl,
      v_step.col,
      case when v_step.extra = '' then '' else 'and y.' || v_step.extra end
    )
    using p_user_id, v_left;
    get diagnostics v_n = row_count;

    v_counts := v_counts || jsonb_build_object(
      v_step.tbl,
      coalesce((v_counts ->> v_step.tbl)::bigint, 0) + v_n
    );

    -- A full batch may have left more rows in this table, so nothing after it (its parents) may
    -- start yet: stop and report incomplete. An exactly-full batch costs one extra, empty call.
    if v_n >= v_left then
      v_complete := false;
      exit;
    end if;
    v_left := v_left - v_n::integer;
  end loop;

  if v_complete then
    -- 12. Personal fields that live on rows which are NOT deleted here.
    --
    --     profiles.display_name is free text the user typed. The other profile columns are display
    --     preferences with no identifying content and go with the row when the auth user is deleted.
    update public.profiles p
       set display_name = null,
           default_storage_location_id = null
     where p.id = p_user_id;

    --     The invitation that created this account holds the address an administrator typed in and
    --     an optional free-text label. The invitation stays as an audit record of an administrative
    --     action (counts, dates, who issued it); the personal fields do not. `email` is NOT NULL,
    --     so it is replaced by a value derived from the invitation's own random id — not from the
    --     address, which would be a guessable pseudonym of it. `.invalid` is reserved by RFC 2606
    --     so the placeholder can never resolve or collide with a real address.
    update public.invitations i
       set email = 'redacted-' || i.id::text || '@redacted.invalid',
           label = null
     where i.id in (
       select r.invitation_id from public.invitation_redemptions r where r.user_id = p_user_id
     );
    get diagnostics v_n = row_count;
    v_counts := v_counts || jsonb_build_object('invitations_redacted', v_n);

    --     Claims hold the same address. A live claim would also block re-inviting the same person.
    delete from public.invitation_claims c
     where c.consumed_user_id = p_user_id
        or c.invitation_id in (
             select r.invitation_id from public.invitation_redemptions r where r.user_id = p_user_id
           );
    get diagnostics v_n = row_count;
    v_counts := v_counts || jsonb_build_object('invitation_claims', v_n);

    update public.account_deletion_requests r
       set last_stage = 'purged'
     where r.user_id = p_user_id;
  end if;

  return v_counts || jsonb_build_object('complete', v_complete);
end;
$$;

comment on function public.purge_account_data(uuid, integer) is
  'P152: deletes up to p_max_rows rows per call of what a user owns, child-first, for a user that has '
  'a pending account_deletion_requests row, and reports `complete`. Each call is one atomic '
  'transaction; call until complete. Service-role only. Idempotent. Never touches the global '
  'catalog or shared (created_by_user_id IS NULL) sealed products.';

-- Supporting index for the purge. Deleting a manual card definition makes Postgres check
-- holdings.manual_card_id for every deleted row, and that column had no index, so each check was a
-- sequential scan of `holdings` — every user's rows, dead tuples included. Measured on 4,000 manual
-- cards against a 24,000-row table: the delete took 6.8 s, all of it that trigger (P132-B recorded
-- the same shape at M13 scale). Partial because most holdings are not manual cards.
create index if not exists holdings_manual_card_id_idx
  on public.holdings (manual_card_id)
  where manual_card_id is not null;

-- Step 4 (after the auth user is gone). GoTrue's own audit table keeps the person's address after
-- `auth.admin.deleteUser`: login entries carry it as `actor_username`, and the deletion itself is
-- logged with `traits.user_email` — written AFTER purge_account_data ran, so it cannot be handled
-- there. Nothing cascades from auth.users to it (verified on a fresh stack: entries survive their
-- user). Whether a hosted project writes this table at all is a platform fact this repository
-- cannot establish, so this is best-effort and never fatal: a platform that withholds the
-- privilege returns -1 instead of failing a deletion that has already succeeded.
--
-- Refuses to touch a live account's trail (a service-role bug must not be able to erase the audit
-- history of an active user): the user must be gone, or pending deletion.
create or replace function public.scrub_account_audit_trail(p_user_id uuid)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n bigint := 0;
begin
  if p_user_id is null then
    raise exception 'user id required';
  end if;

  if exists (select 1 from auth.users u where u.id = p_user_id)
     and not exists (
       select 1 from public.account_deletion_requests r where r.user_id = p_user_id
     ) then
    raise exception 'account_not_pending_deletion';
  end if;

  begin
    delete from auth.audit_log_entries e
     where e.payload ->> 'actor_id' = p_user_id::text
        or e.payload -> 'traits' ->> 'user_id' = p_user_id::text;
    get diagnostics v_n = row_count;
  exception
    when insufficient_privilege or undefined_table or undefined_column then
      return -1;
  end;

  return v_n;
end;
$$;

comment on function public.scrub_account_audit_trail(uuid) is
  'P152: best-effort removal of GoTrue audit_log_entries that name a deleted (or pending-deletion) '
  'user. Returns the number of rows removed, or -1 when the platform withholds the privilege. '
  'Service-role only; refuses to act on a live, non-pending account.';

-- Execute privileges. Explicit for every role: `revoke ... from public` alone does not remove a
-- grant to anon/authenticated that the platform's own default privileges may have attached, and
-- the baseline sweep is not a substitute for this file being correct on its own.
revoke all on function public.begin_account_deletion(uuid) from public, anon, authenticated;
revoke all on function public.purge_account_data(uuid, integer) from public, anon, authenticated;
revoke all on function public.scrub_account_audit_trail(uuid) from public, anon, authenticated;
revoke all on function public.account_deletion_write_guard() from public, anon, authenticated;
revoke all on function public.account_deletion_write_guard_sealed() from public, anon, authenticated;

grant execute on function public.begin_account_deletion(uuid) to service_role;
grant execute on function public.purge_account_data(uuid, integer) to service_role;
grant execute on function public.scrub_account_audit_trail(uuid) to service_role;
