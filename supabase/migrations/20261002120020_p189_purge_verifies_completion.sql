-- P156: purge_account_data must not report `complete` over a row it skipped.
--
-- The purge picks a batch by ctid and deletes those tuples. A ctid names one physical row VERSION:
-- if a writer with no user identity (a maintenance job, an operator session) updates a row after
-- the batch was selected, the DELETE waits for the row lock, re-checks the NEW version, finds that
-- its ctid is not in the array and skips it — and the batch, having deleted fewer rows than its
-- limit, concluded the table was empty. Reproduced in tests/db/p156_purge_concurrent_update.test.ts:
-- `complete: true` with one row left. Nothing was lost (the final Auth deletion cascades every
-- owned table), but the function's contract — and the `purged` stage the Edge Function records on
-- the strength of it — was false.
--
-- The fix keeps the design and the batch size and adds the one thing that was missing: a table is
-- only considered finished when a second look, in the same call, finds no row left in it. A row
-- that was skipped is simply found by the next call. Everything else is unchanged from P152
-- (20260920120000): same order, same predicates, same final personal-field cleanup, same grants.

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

    -- A short batch does NOT prove the table is empty: a tuple updated after the batch was selected
    -- is skipped (see the header). Look again, with the same predicate, before starting its parents.
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

comment on function public.purge_account_data(uuid, integer) is
  'P152/P156: deletes up to p_max_rows rows per call of what a user owns, child-first, for a user that has '
  'a pending account_deletion_requests row, and reports `complete` only when a second look finds nothing '
  'left in any owned table. Each call is one atomic transaction; call until complete. Service-role only. '
  'Idempotent. Never touches the global catalog or shared (created_by_user_id IS NULL) sealed products.';

revoke all on function public.purge_account_data(uuid, integer) from public, anon, authenticated;
grant execute on function public.purge_account_data(uuid, integer) to service_role;
