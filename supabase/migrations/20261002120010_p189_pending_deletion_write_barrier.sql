-- P156: make "pending deletion" a real barrier, and extend it from new rows to every write.
--
-- What P152 left open (reproduced against its own schema before this file was written —
-- tests/db/p156_pending_write_barrier.test.ts):
--
--   1. The write guard was INSERT-only. An account whose deletion had been authorised could still,
--      with its still-valid bearer token, UPDATE and DELETE existing rows and call every
--      correcting RPC: void_sale, void_acquisition_lot, remove_holdings_from_portfolio,
--      reset_my_portfolio_data, update_purchase, set_sealed_lot_intent, and so on. Deleting rows
--      changes financial and recovery invariants the person had already given up on, editing a
--      profile after the purge re-creates personal data on a row that is meant to be empty, and a
--      correction racing the purge makes "what was deleted" depend on timing.
--   2. Becoming pending was not a barrier. begin_account_deletion committed the row without waiting
--      for a write already in flight, so under ordinary READ COMMITTED ordering a transaction that
--      had started before the pending row could commit its rows after every purge batch had looked.
--
-- The fix keys the check on WHO IS ASKING, not on which row is touched.
--
--   * A statement-level BEFORE trigger on every table a signed-in account can write, on INSERT,
--     UPDATE and DELETE. It reads the caller's identity (auth.uid()) and refuses if that identity
--     has a pending-deletion row. Because it looks at the caller, it needs no transition table
--     (P152's guard cost ~15% on bulk inserts) and covers SECURITY DEFINER RPCs: those run as the
--     function owner but still see the caller's request claims.
--   * No bypass switch exists. The purge runs as the service role and cascades run inside Auth's own
--     connection: neither carries a user identity, so neither is a "caller" the guard recognises.
--     There is no GUC, header or parameter a browser client can set to change that, and nothing
--     to turn off around the purge. (Contrast: an owner-keyed UPDATE/DELETE guard would have to be
--     bypassed by the purge itself, which is exactly the switch an attacker would look for.)
--   * The trigger takes a SHARED transaction-scoped advisory lock on the caller before it checks,
--     and begin_account_deletion takes the EXCLUSIVE lock on the same key before it commits the
--     pending row. Transaction-scoped locks are held to the end of the writer's transaction, so:
--
--         writer's first guarded statement before begin  → begin WAITS until the writer commits,
--                                                          so that write is visible to the purge
--         writer's first guarded statement after begin   → the writer WAITS until begin commits,
--                                                          then re-checks with a fresh READ
--                                                          COMMITTED snapshot and is refused
--
--     Either order is decided by lock acquisition, not by who happened to be faster. The account's
--     own writers never wait on each other (shared/shared), and other accounts use other keys.
--
-- P152's owner-keyed AFTER INSERT guard (account_deletion_guard) is kept as a second layer: it
-- covers a privileged caller that inserts INTO a pending account's rows without being that account
-- (nothing does today; a future admin tool might).
--
-- What this deliberately does not do: reads stay allowed (an export the person started before
-- pressing delete keeps working — and may see a partially purged account, which the deletion dialog
-- already tells them to avoid by exporting first).

-- ── 1. The caller-keyed guard ─────────────────────────────────────────────────────────────────
create or replace function public.account_deletion_caller_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller uuid := auth.uid();
begin
  -- No user identity: the service role, an operator session, Auth's own connection running the
  -- final cascade. Those are the contexts that legitimately act on a pending account.
  if v_caller is null then
    return null;
  end if;

  -- SHARED so the account's own concurrent writers never wait for each other. Held to the end of
  -- this transaction, which is what lets begin_account_deletion drain it.
  perform pg_advisory_xact_lock_shared(hashtextextended('p156:account:' || v_caller::text, 0));

  -- A fresh snapshot in READ COMMITTED: if begin_account_deletion committed while this statement
  -- was waiting for the lock above, the row is visible here.
  if exists (
    select 1 from public.account_deletion_requests r where r.user_id = v_caller
  ) then
    raise exception 'account_deletion_pending'
      using errcode = 'P0001',
            hint = 'This account is being deleted and no longer accepts changes.';
  end if;

  return null;
end;
$$;

comment on function public.account_deletion_caller_guard() is
  'P156: BEFORE-statement guard. Refuses INSERT/UPDATE/DELETE when the calling identity (auth.uid()) '
  'has a pending account_deletion_requests row; takes a shared advisory lock on the caller first so '
  'begin_account_deletion can wait for writes already in flight. No caller identity = not guarded.';

-- Every table a signed-in account can write, directly or through an RPC. This list is not the only
-- safeguard: tests/db/p156_pending_write_barrier.test.ts derives the set of tables owned by an
-- auth user from pg_constraint and fails if one is missing here, so a table added later cannot be
-- forgotten by both places.
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
    'openings', 'sealed_products',
    'profiles', 'portfolio_snapshots', 'portfolio_recompute_queue', 'invitations'
  ]
  loop
    execute format(
      'create trigger account_deletion_barrier before insert or update or delete on public.%I '
      'for each statement execute function public.account_deletion_caller_guard()',
      t
    );
  end loop;
end;
$$;

-- ── 2. begin_account_deletion drains the writers that are already in flight ─────────────────────
--
-- Same behaviour as P152 (idempotent, one row, attempt counter, a foreign-key failure means the
-- user is gone) plus the exclusive lock. The lock is released when this call's transaction ends,
-- i.e. after the pending row is committed, which is the moment queued writers are released to be
-- refused.
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

  -- Waits for every transaction of this account that has already run a guarded statement, and makes
  -- later ones wait for this transaction. Bounded by the caller's lock_timeout: a stuck writer makes
  -- this fail retryably (55P03) before anything has been changed.
  perform pg_advisory_xact_lock(hashtextextended('p156:account:' || p_user_id::text, 0));

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

-- ── 3. Privileges ──────────────────────────────────────────────────────────────────────────
-- Same stance as P152: nothing here is callable from a browser. Restated in full because
-- `create or replace` keeps whatever ACL the function already had, and an ACL is only correct if it
-- is written down where it is created.
revoke all on function public.account_deletion_caller_guard() from public, anon, authenticated;
revoke all on function public.begin_account_deletion(uuid) from public, anon, authenticated;
grant execute on function public.begin_account_deletion(uuid) to service_role;
