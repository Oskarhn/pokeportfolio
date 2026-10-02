-- P189: restore-safe account deletion.
--
-- The problem this closes (reproduced in P189 before any change: 24 of 24 account-owning relations
-- came back — auth.users, auth.identities and 22 public tables): a backup taken while an account
-- existed knows nothing about a deletion that happens afterwards, so restoring it resurrects the
-- login, the profile and the whole ledger. Nothing inside a backup can fix that. What can: a record
-- of erasures kept OUTSIDE every backup (the erasure registry, scripts/restore-gate/) and a
-- promotion gate that replays it onto a restored image before that image may serve anyone.
--
-- This migration is the database half of that design. It adds no personal data: a deletion is
-- identified by a random deletion id and by a namespaced SHA-256 of the account's random UUID.
--
--   1. erasure_subject_hash(uuid)     the one definition of the registry's stand-in for an account id
--   2. account_deletion_requests      + deletion_id, registry_state, registry_seq (the recoverable
--                                       state machine; see the sequence below)
--   3. account_erasure_receipts       a witness COPY of what the registry holds, kept in the database
--                                       so that a restore can detect a registry that is OLDER than the
--                                       backup. The registry stays the source of truth.
--   4. prepare/record/abort           service-role steps of the deletion workflow
--   5. purge_account_data             REFUSES to delete anything until the erasure is recorded
--   6. restore_gate_*                 the operator-only replay and verification run on a restored image
--
-- Deletion sequence (every step idempotent; the whole is a retryable state machine, not a transaction):
--
--   authenticate → intent → fresh password → begin (pending, writes blocked)
--     → record the erasure OFF-PLATFORM (registry) and in account_erasure_receipts   [registry_state]
--     → purge application data → delete the Auth user → scrub audit residue
--
-- The erasure is recorded BEFORE the first destructive step, and the database enforces that order
-- (step 5), so there is no moment at which data is gone but a restore would bring it back unnoticed.
-- If the registry cannot be reached, nothing has been deleted: the account is pending (write-blocked)
-- with all its data, the response says the deletion is incomplete, and the same request can be
-- repeated. An operator can release such an account with abort_account_deletion, but only after
-- checking the registry does not already hold it (docs/security/RESTORE_RUNBOOK.md §6).

-- ── 1. The subject hash ──────────────────────────────────────────────────────────────────────
-- Must stay byte-for-byte identical to hashAccountId() in scripts/restore-gate/erasure-registry.ts;
-- tests/ops/erasure-registry.test.ts and tests/db/p189_restore_gate.test.ts pin the two together.
create or replace function public.erasure_subject_hash(p_user_id uuid)
returns text
language sql
immutable
strict
parallel safe
set search_path = ''
as $$
  select encode(
    sha256(convert_to('pokeportfolio:erased-account:' || lower(p_user_id::text), 'UTF8')),
    'hex'
  )
$$;

comment on function public.erasure_subject_hash(uuid) is
  'P189: the erasure registry''s stand-in for an account id (hex SHA-256 of a namespaced, lower-cased '
  'UUID). A random UUID cannot be enumerated back from it; it is only ever compared with ids found '
  'inside a restored image.';

-- ── 2. The recoverable state on the pending record ───────────────────────────────────────────
do $$
declare
  v_name text;
begin
  select con.conname into v_name
    from pg_constraint con
   where con.conrelid = 'public.account_deletion_requests'::regclass
     and con.contype = 'c'
     and pg_get_constraintdef(con.oid) like '%last_stage%';
  if v_name is null then
    raise exception 'expected the last_stage check constraint on account_deletion_requests';
  end if;
  execute format('alter table public.account_deletion_requests drop constraint %I', v_name);
end;
$$;

alter table public.account_deletion_requests
  add column deletion_id uuid not null default gen_random_uuid(),
  add column registry_state text not null default 'not_recorded'
    check (registry_state in ('not_recorded', 'recorded')),
  add column registry_seq bigint check (registry_seq is null or registry_seq >= 1),
  add constraint account_deletion_requests_last_stage_check
    check (last_stage in ('requested', 'registry_failed', 'purge_failed', 'purged', 'auth_delete_failed')),
  add constraint account_deletion_requests_registry_consistent
    check ((registry_state = 'recorded') = (registry_seq is not null));

comment on column public.account_deletion_requests.registry_state is
  'P189: not_recorded until the off-platform erasure registry has durably accepted this deletion; '
  'purge_account_data refuses to run before then.';

-- ── 3. The witness copy of the registry ──────────────────────────────────────────────────────
create table public.account_erasure_receipts (
  deletion_id uuid primary key,
  subject_hash text not null unique check (subject_hash ~ '^[0-9a-f]{64}$'),
  registry_seq bigint not null check (registry_seq >= 1),
  recorded_at timestamptz not null default now()
);

comment on table public.account_erasure_receipts is
  'P189: one row per erasure the registry has accepted: random deletion id, hash of the account id, '
  'the registry sequence number. No foreign key and no personal data, so it survives the account. It '
  'is a witness, not the source of truth: after a restore it lets the gate see that the registry is '
  'older than the backup. Service-role only.';

alter table public.account_erasure_receipts enable row level security;
revoke all on table public.account_erasure_receipts from public, anon, authenticated;
grant all on table public.account_erasure_receipts to service_role;

-- ── 4. The workflow steps ────────────────────────────────────────────────────────────────────
create or replace function public.prepare_account_erasure(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.account_deletion_requests;
begin
  if p_user_id is null then
    raise exception 'user id required';
  end if;
  select * into v_row from public.account_deletion_requests r where r.user_id = p_user_id;
  if not found then
    raise exception 'account_deletion_not_requested';
  end if;
  return jsonb_build_object(
    'deletion_id', v_row.deletion_id,
    'subject_hash', public.erasure_subject_hash(p_user_id),
    'registry_state', v_row.registry_state,
    'registry_seq', v_row.registry_seq
  );
end;
$$;

create or replace function public.record_account_erasure(
  p_user_id uuid,
  p_deletion_id uuid,
  p_registry_seq bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.account_deletion_requests;
  v_subject text := public.erasure_subject_hash(p_user_id);
  v_existing public.account_erasure_receipts;
begin
  if p_user_id is null or p_deletion_id is null or p_registry_seq is null or p_registry_seq < 1 then
    raise exception 'user id, deletion id and registry sequence required';
  end if;

  select * into v_row from public.account_deletion_requests r
   where r.user_id = p_user_id for update;
  if not found then
    raise exception 'account_deletion_not_requested';
  end if;
  -- The registry is the source of truth for the deletion id. If it already held this account under
  -- another id (an earlier attempt whose answer was lost), adopt its id — but never rewrite an id
  -- that has already been recorded.
  if v_row.deletion_id <> p_deletion_id then
    if v_row.registry_state = 'recorded' then
      raise exception 'account_erasure_mismatch';
    end if;
    update public.account_deletion_requests r set deletion_id = p_deletion_id where r.user_id = p_user_id;
  end if;

  select * into v_existing from public.account_erasure_receipts c where c.deletion_id = p_deletion_id;
  if found then
    if v_existing.subject_hash <> v_subject or v_existing.registry_seq <> p_registry_seq then
      raise exception 'account_erasure_mismatch';
    end if;
  else
    insert into public.account_erasure_receipts (deletion_id, subject_hash, registry_seq)
    values (p_deletion_id, v_subject, p_registry_seq);
  end if;

  update public.account_deletion_requests r
     set registry_state = 'recorded',
         registry_seq = p_registry_seq,
         last_stage = case when r.last_stage = 'registry_failed' then 'requested' else r.last_stage end
   where r.user_id = p_user_id;

  return jsonb_build_object('registry_state', 'recorded', 'registry_seq', p_registry_seq);
end;
$$;

-- Releases an account whose erasure was never recorded (the registry stayed unreachable). Operator
-- only: if the registry actually accepted the request and only the answer was lost, aborting would
-- leave a live account in the registry, which the gate would then delete on the next restore. The
-- runbook makes the registry check a required step first.
create or replace function public.abort_account_deletion(p_user_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_state text;
begin
  if p_user_id is null then
    raise exception 'user id required';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('p156:account:' || p_user_id::text, 0));
  select r.registry_state into v_state
    from public.account_deletion_requests r where r.user_id = p_user_id for update;
  if not found then
    return false;
  end if;
  if v_state = 'recorded' then
    raise exception 'account_erasure_already_recorded';
  end if;
  delete from public.account_deletion_requests r where r.user_id = p_user_id;
  return true;
end;
$$;

revoke all on function public.prepare_account_erasure(uuid) from public, anon, authenticated;
revoke all on function public.record_account_erasure(uuid, uuid, bigint) from public, anon, authenticated;
revoke all on function public.abort_account_deletion(uuid) from public, anon, authenticated;
grant execute on function public.prepare_account_erasure(uuid) to service_role;
grant execute on function public.record_account_erasure(uuid, uuid, bigint) to service_role;
-- abort_account_deletion: operator (database owner) only. Deliberately not granted to service_role.
revoke all on function public.erasure_subject_hash(uuid) from public, anon, authenticated;
grant execute on function public.erasure_subject_hash(uuid) to service_role;

-- ── 5. The purge refuses to run before the erasure is recorded ──────────────────────────────
-- Identical to the P156 version (20261002120020) except for the registry_state check.
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
  v_more boolean;
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

  -- P189: no destructive step before the restore-safe record exists. This is the database enforcing
  -- the ordering the Edge Function follows, so a future caller cannot reorder it by mistake.
  if not exists (
    select 1 from public.account_deletion_requests r
     where r.user_id = p_user_id and r.registry_state = 'recorded'
  ) then
    raise exception 'account_erasure_not_recorded';
  end if;

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

    if v_n >= v_left then
      v_complete := false;
      exit;
    end if;

    execute format(
      'select exists (select 1 from public.%1$I y where y.%2$I = $1 %3$s)',
      v_step.tbl,
      v_step.col,
      case when v_step.extra = '' then '' else 'and y.' || v_step.extra end
    )
    into v_more
    using p_user_id;
    if v_more then
      v_complete := false;
      exit;
    end if;

    v_left := v_left - v_n::integer;
  end loop;

  if v_complete then
    update public.profiles p
       set display_name = null,
           default_storage_location_id = null
     where p.id = p_user_id;

    update public.invitations i
       set email = 'redacted-' || i.id::text || '@redacted.invalid',
           label = null
     where i.id in (
       select r.invitation_id from public.invitation_redemptions r where r.user_id = p_user_id
     );
    get diagnostics v_n = row_count;
    v_counts := v_counts || jsonb_build_object('invitations_redacted', v_n);

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

revoke all on function public.purge_account_data(uuid, integer) from public, anon, authenticated;
grant execute on function public.purge_account_data(uuid, integer) to service_role;

-- ── 6. The restore gate (operator only) ──────────────────────────────────────────────────────
-- Run against a RESTORED, ISOLATED database before it serves anyone. The registry is parsed and
-- integrity-checked by the tooling (scripts/restore-gate/); these functions take its validated
-- content as jsonb — an array of {"deletion_id": uuid, "subject": hex, "seq": n} — and do the work
-- next to the data. They never return an account id, an address or a row: counts and names only.
-- They are granted to nobody but the database owner: the service role the Edge Functions use must
-- not be able to delete accounts by registry, and the gate runs as the operator.

-- Every column that names an account: auth.users.id plus each foreign key to auth.users in public
-- (catalog-derived, so a table added later is covered without anyone remembering it).
create or replace function public.restore_gate_account_columns()
returns table (relation text, col text)
language sql
stable
set search_path = ''
as $$
  select 'auth.users'::text, 'id'::text
  union all
  select 'auth.identities', 'user_id'
  union all
  select 'public.' || rel.relname::text, att.attname::text
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_attribute att on att.attrelid = con.conrelid and att.attnum = con.conkey[1]
   where con.contype = 'f'
     and con.confrelid = 'auth.users'::regclass
     and rel.relnamespace = 'public'::regnamespace
     and array_length(con.conkey, 1) = 1
$$;

create or replace function public.restore_gate_scan(p_subjects text[])
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_col record;
  v_ids uuid[];
  v_all uuid[] := '{}';
  v_n bigint;
  v_tables jsonb := '{}'::jsonb;
  v_orphans integer;
begin
  for v_col in select * from public.restore_gate_account_columns() loop
    execute format(
      'select coalesce(array_agg(distinct x.%2$I), ''{}'') from %1$s x where x.%2$I is not null '
      'and public.erasure_subject_hash(x.%2$I) = any ($1)',
      v_col.relation, v_col.col
    ) into v_ids using p_subjects;
    if cardinality(v_ids) > 0 then
      execute format('select count(*) from %1$s x where x.%2$I = any ($1)', v_col.relation, v_col.col)
        into v_n using v_ids;
      v_tables := v_tables || jsonb_build_object(v_col.relation, v_n);
      v_all := v_all || v_ids;
    end if;
  end loop;

  select count(*) into v_orphans
    from (select distinct unnest(v_all) as id) d
   where not exists (select 1 from auth.users u where u.id = d.id);

  return jsonb_build_object(
    'present_accounts', (select count(distinct id) from unnest(v_all) id),
    'orphan_accounts', v_orphans,
    'tables', v_tables
  );
end;
$$;

-- Read-only: scan + the witness comparison. A receipt in this image that the registry does not hold
-- (or holds under a different subject/sequence) means the registry is not the one that was current
-- when this backup was taken; a receipt with a sequence above the registry's head means the registry
-- is OLDER than the backup. Either way the image cannot be trusted to be fully replayed.
create or replace function public.restore_gate_check(p_registry jsonb, p_head_seq bigint)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_subjects text[];
  v_scan jsonb;
  v_unknown integer;
  v_mismatch integer;
  v_max_receipt bigint;
begin
  select coalesce(array_agg(e ->> 'subject'), '{}') into v_subjects
    from jsonb_array_elements(p_registry) e;
  v_scan := public.restore_gate_scan(v_subjects);

  select count(*) into v_unknown
    from public.account_erasure_receipts c
   where not exists (
     select 1 from jsonb_array_elements(p_registry) e where (e ->> 'deletion_id')::uuid = c.deletion_id
   );
  select count(*) into v_mismatch
    from public.account_erasure_receipts c
    join jsonb_array_elements(p_registry) e on (e ->> 'deletion_id')::uuid = c.deletion_id
   where e ->> 'subject' <> c.subject_hash or (e ->> 'seq')::bigint <> c.registry_seq;
  select coalesce(max(c.registry_seq), 0) into v_max_receipt from public.account_erasure_receipts c;

  return v_scan || jsonb_build_object(
    'receipts_unknown_to_registry', v_unknown,
    'receipts_contradicting_registry', v_mismatch,
    'max_receipt_seq', v_max_receipt,
    'registry_older_than_image', v_max_receipt > coalesce(p_head_seq, 0)
  );
end;
$$;

-- Replays the registry onto the image: every account the registry says was erased and that this
-- image contains is taken through the same workflow a live deletion uses (pending → recorded →
-- purge → delete the Auth user → scrub). Idempotent: a second run finds nothing and changes nothing.
-- p_dry_run reports what would be replayed and writes nothing.
create or replace function public.restore_gate_apply(p_registry jsonb, p_dry_run boolean default true)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_entry record;
  v_uid uuid;
  v_replayed integer := 0;
  v_purge jsonb;
  v_rounds integer;
begin
  for v_entry in
    select (e ->> 'deletion_id')::uuid as deletion_id, e ->> 'subject' as subject, (e ->> 'seq')::bigint as seq
      from jsonb_array_elements(p_registry) e
     order by (e ->> 'seq')::bigint
  loop
    for v_uid in select u.id from auth.users u where public.erasure_subject_hash(u.id) = v_entry.subject loop
      v_replayed := v_replayed + 1;
      if p_dry_run then
        continue;
      end if;
      perform public.begin_account_deletion(v_uid);
      -- The registry IS the record here; mirror it into this image so the witness copy is complete.
      -- begin_account_deletion generated a fresh deletion_id for the request row; align it first.
      update public.account_deletion_requests r set deletion_id = v_entry.deletion_id where r.user_id = v_uid;
      perform public.record_account_erasure(v_uid, v_entry.deletion_id, v_entry.seq);
      v_rounds := 0;
      loop
        v_purge := public.purge_account_data(v_uid, 5000);
        exit when (v_purge ->> 'complete')::boolean;
        v_rounds := v_rounds + 1;
        if v_rounds > 100000 then
          raise exception 'restore_gate_apply: purge did not converge';
        end if;
      end loop;
      delete from auth.users u where u.id = v_uid;
      perform public.scrub_account_audit_trail(v_uid);
    end loop;
  end loop;

  return jsonb_build_object('replayed_accounts', v_replayed, 'dry_run', p_dry_run);
end;
$$;

create table public.restore_gate_runs (
  id bigint generated always as identity primary key,
  ran_at timestamptz not null default now(),
  registry_head_seq bigint not null,
  registry_head_mac text not null,
  registry_records integer not null,
  status text not null check (status in ('passed', 'failed'))
);

comment on table public.restore_gate_runs is
  'P189: one row per postcheck of a restored image. promote-check reads the newest row and then '
  'verifies again; a stamp alone never authorises promotion. Operator only.';

alter table public.restore_gate_runs enable row level security;
revoke all on table public.restore_gate_runs from public, anon, authenticated, service_role;

-- Stamps the image: re-checks, records passed/failed. A stamp is evidence of one check at one
-- registry head, nothing more — promote-check re-verifies against the current registry.
create or replace function public.restore_gate_postcheck(
  p_registry jsonb,
  p_head_seq bigint,
  p_head_mac text,
  p_records integer
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_check jsonb := public.restore_gate_check(p_registry, p_head_seq);
  v_ok boolean;
begin
  v_ok := (v_check ->> 'present_accounts')::int = 0
      and (v_check ->> 'orphan_accounts')::int = 0
      and (v_check ->> 'receipts_unknown_to_registry')::int = 0
      and (v_check ->> 'receipts_contradicting_registry')::int = 0
      and not (v_check ->> 'registry_older_than_image')::boolean;
  insert into public.restore_gate_runs (registry_head_seq, registry_head_mac, registry_records, status)
  values (p_head_seq, p_head_mac, p_records, case when v_ok then 'passed' else 'failed' end);
  return v_check || jsonb_build_object('status', case when v_ok then 'passed' else 'failed' end);
end;
$$;

-- Operator (database owner) only: nothing below is granted to any API role.
revoke all on function public.restore_gate_account_columns() from public, anon, authenticated, service_role;
revoke all on function public.restore_gate_scan(text[]) from public, anon, authenticated, service_role;
revoke all on function public.restore_gate_check(jsonb, bigint) from public, anon, authenticated, service_role;
revoke all on function public.restore_gate_apply(jsonb, boolean) from public, anon, authenticated, service_role;
revoke all on function public.restore_gate_postcheck(jsonb, bigint, text, integer) from public, anon, authenticated, service_role;
