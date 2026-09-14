-- P132-B: correction-RPC concurrency (P130-03 / output_130.txt Step 4).
--
-- THE BUG. void_purchase, void_acquisition_lot, remove_holdings_from_portfolio and void_opening
-- each decide whether a lot (or a pull lot) is safe to void by reading quantity_remaining /
-- downstream-disposal state WITHOUT locking the row first, then mutate afterward. create_sale
-- (m10_sales_rpc.sql) takes the opposite, correct order: it locks every referenced lot with
-- SELECT ... FOR UPDATE, in ascending lot_id order, and only THEN re-checks quantity_remaining
-- against the live row. A correction racing a concurrent create_sale can therefore read "not yet
-- disposed" a moment before the sale's disposal commits, and go on to void a lot (or restore its
-- own purchase/opening) that a live sale now depends on -- a voided lot with a live disposal
-- referencing it, D1 broken. Reproduced with a deterministic held-lock harness (two real
-- transactions, the first holding its FOR UPDATE lock open while the second runs the unpatched
-- correction RPC) in tests/db/p132b_correction_locking.test.ts; see
-- ai_outputs/Claude_outputs/output_132_b_finance.txt for the full evidence.
--
-- THE FIX -- one canonical lock order, applied to every function this migration touches:
--   1. If the correction targets a single named parent row that must be checked for existence /
--      void state before anything else (an opening), lock that ONE row FOR UPDATE first --
--      exactly what void_opening already did, and the same order reconcile_opening_cost
--      (m16_opening_rpcs.sql, untouched by this migration) already uses.
--   2. Collect every public.acquisition_lots row the correction could void or whose
--      quantity_remaining it could restore, across the WHOLE call. Lock them FOR UPDATE in
--      ascending id order, in one pass, before any check-then-act -- never collect, then lock,
--      then collect more.
--   3. Only after every relevant lot is locked, evaluate live disposal / quantity state from
--      those now-locked rows, never from a value read before the lock.
--   4. Mutate (void the purchase/lot/opening, let the D1 trigger restore quantity) only after
--      validation passes.
-- This is create_sale's own discipline (single ascending-id lock pass, then re-validate, then
-- write), extended to every place a correction can invalidate or rewrite inventory. Because every
-- function that lock acquisition_lots (create_sale, create_opening, and now the four below) locks
-- it LAST and in ascending id order, and the only two functions that lock a second table first
-- (void_opening, reconcile_opening_cost) both lock openings before acquisition_lots -- never the
-- reverse anywhere in the codebase -- no AB/BA cycle exists between any pair of these functions.
-- See the audit in output_132_b_finance.txt (LOCK_ORDER_RULE) for the full cross-function check.
--
-- SCOPE. update_purchase is Session A's (P132-A, P130-01) -- not touched here. update_sale and
-- void_sale were audited and found NOT to have this shape: neither one locks, voids, or restores
-- quantity on any public.acquisition_lots row (update_sale only rewrites sale/sale_line charge
-- columns from the ALREADY-frozen cost basis; void_sale only flips sale_lines/lot_disposals rows
-- it owns, and the D1 trigger it fires only ever RESTORES a lot the sale itself is retreating
-- from) -- see the audit result in output_132_b_finance.txt. Neither is modified here.

-- ── 1. void_purchase — lock every live lot the purchase produced before checking disposal state ──
create or replace function public.void_purchase(p_purchase_id uuid, p_reason text default null)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_existing public.purchases;
  v_blocker record;
  v_lot_ids uuid[];
  v_lot_id uuid;
begin
  if v_user_id is null then
    raise exception 'not authenticated';
  end if;

  select * into v_existing from public.purchases where id = p_purchase_id and user_id = v_user_id;
  if v_existing.id is null then
    raise exception 'purchase % not found', p_purchase_id;
  end if;
  if v_existing.voided_at is not null then
    raise exception 'purchase % is already voided', p_purchase_id;
  end if;

  -- Lock every live lot this purchase produced, ascending id order, BEFORE looking at disposal
  -- state (P130-03 / P132-B). A concurrent create_sale already holding one of these rows is
  -- waited on here; whichever transaction is granted the lock first serializes the other.
  select coalesce(array_agg(al.id order by al.id), '{}') into v_lot_ids
    from public.acquisition_lots al
    join public.purchase_lines pl on pl.id = al.purchase_line_id
    where pl.purchase_id = p_purchase_id and al.voided_at is null;

  foreach v_lot_id in array v_lot_ids loop
    perform 1 from public.acquisition_lots where id = v_lot_id for update;
  end loop;

  -- Re-validate against the now-locked, live rows -- never a value read before the lock above.
  select pl.description, pl.line_type, al.quantity, al.quantity_remaining
    into v_blocker
    from public.purchase_lines pl
    join public.acquisition_lots al on al.purchase_line_id = pl.id
    where pl.purchase_id = p_purchase_id
      and al.id = any(v_lot_ids)
      and al.quantity_remaining <> al.quantity
    limit 1;
  if v_blocker.line_type is not null then
    raise exception 'this purchase cannot be voided: % (%) has already been partially disposed (% of % remaining)',
      coalesce(v_blocker.description, v_blocker.line_type::text), v_blocker.line_type,
      v_blocker.quantity_remaining, v_blocker.quantity;
  end if;

  update public.purchases
    set voided_at = now(), notes = coalesce(p_reason, notes)
    where id = p_purchase_id;

  update public.acquisition_lots
    set voided_at = now()
    where id = any(v_lot_ids);
end;
$$;

comment on function public.void_purchase(uuid, text) is
  'Voids a whole purchase and every lot it produced, atomically. Locks every live lot FOR UPDATE (ascending id) before checking disposal state, so a concurrent create_sale on the same lot always serializes against this instead of racing it (P130-03 / P132-B). Blocked if any lot has been disposed elsewhere.';

-- ── 2. void_acquisition_lot — lock the lot before re-checking it, same order as create_sale ──────
create or replace function public.void_acquisition_lot(p_lot_id uuid, p_reason text default null)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_lot public.acquisition_lots;
  v_purchase_id uuid;
  v_unaccounted_lines int;
begin
  if v_user_id is null then
    raise exception 'not authenticated';
  end if;

  -- Lock this lot FIRST (P130-03 / P132-B): the same row create_sale locks before disposing from
  -- it. Only after the lock is granted do we read quantity_remaining -- never before.
  select * into v_lot from public.acquisition_lots where id = p_lot_id and user_id = v_user_id for update;
  if v_lot.id is null then
    raise exception 'acquisition lot % not found', p_lot_id;
  end if;
  if v_lot.voided_at is not null then
    raise exception 'acquisition lot % is already voided', p_lot_id;
  end if;
  if v_lot.quantity_remaining <> v_lot.quantity then
    raise exception
      'acquisition lot % has already been partially disposed elsewhere (% of % remaining) and cannot be voided here',
      p_lot_id, v_lot.quantity_remaining, v_lot.quantity;
  end if;

  update public.acquisition_lots
    set voided_at = now(), notes = coalesce(p_reason, notes)
    where id = p_lot_id and user_id = v_user_id;

  if v_lot.purchase_line_id is not null then
    select purchase_id into v_purchase_id
      from public.purchase_lines where id = v_lot.purchase_line_id;

    -- Unchanged from M8.1 (D-051): every *other* line on this purchase must already be accounted
    -- for. Not part of the P130-03 lot-locking fix -- this reads only voided_at on OTHER lots'
    -- rows, never quantity_remaining, and never restores anything a disposal depends on.
    select count(*) into v_unaccounted_lines
      from public.purchase_lines pl
      left join public.acquisition_lots al on al.purchase_line_id = pl.id
      where pl.purchase_id = v_purchase_id
        and pl.id <> v_lot.purchase_line_id
        and (al.id is null or al.voided_at is null);

    if v_unaccounted_lines = 0 then
      update public.purchases
        set voided_at = now()
        where id = v_purchase_id and voided_at is null;
    end if;
  end if;
end;
$$;

comment on function public.void_acquisition_lot(uuid, text) is
  'Correction path for one acquisition lot. Locks the lot FOR UPDATE before reading its quantity_remaining, so a concurrent create_sale on the same lot always serializes against this instead of racing it (P130-03 / P132-B). Auto-voids its parent purchase only when every other line on the receipt is already accounted for (a voided lot, or no other line at all) — never when a non-inventory line (accessory, shipping, etc.) still represents live spend. Refuses to void a lot that has already been partially disposed elsewhere. See DECISIONS.md D-051.';

-- ── 3. remove_holdings_from_portfolio — lock every candidate lot before the blocked-status pass ──
create or replace function public.remove_holdings_from_portfolio(p_holding_ids uuid[])
returns table (
  holding_id uuid,
  blocked boolean,
  blocked_reason text,
  physical_count integer
)
language plpgsql
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_has_blocked boolean := false;
  v_hid uuid;
  v_result_holding uuid[] := '{}';
  v_result_blocked boolean[] := '{}';
  v_result_reason text[] := '{}';
  v_result_count int[] := '{}';
  v_lot_ids uuid[];
  v_lot_id uuid;
begin
  if v_user_id is null then
    raise exception 'not authenticated';
  end if;
  if p_holding_ids is null or array_length(p_holding_ids, 1) is null then
    raise exception 'p_holding_ids must be a non-empty array';
  end if;

  if exists (
    select 1 from unnest(p_holding_ids) as x(hid)
    where not exists (
      select 1 from public.holdings h where h.id = x.hid and h.user_id = v_user_id
    )
  ) then
    raise exception 'one or more holdings were not found';
  end if;

  -- Lock every live lot of every selected holding, ascending id order, in ONE pass, BEFORE
  -- evaluating any disposal state (P130-03 / P132-B) -- the same discipline create_sale and the
  -- two functions above now share. A concurrent create_sale already holding one of these rows is
  -- waited on here, so the "blocked" pass below can never run against a lot whose disposal hasn't
  -- committed yet. Caller-supplied holding order is irrelevant: the lock order is the lot id, not
  -- the array position, so two overlapping calls (however the caller orders their holdings) can
  -- never deadlock against each other or against create_sale.
  select coalesce(array_agg(al.id order by al.id), '{}') into v_lot_ids
    from public.acquisition_lots al
    where al.holding_id = any(p_holding_ids) and al.user_id = v_user_id and al.voided_at is null;

  foreach v_lot_id in array v_lot_ids loop
    perform 1 from public.acquisition_lots where id = v_lot_id for update;
  end loop;

  -- Pass 1 (now race-safe): determine per-holding blocked status from the locked, live rows.
  -- Nothing else can make a removal unsafe: the parent-purchase correction is handled entirely
  -- inside void_acquisition_lot itself.
  for v_hid in select unnest(p_holding_ids) loop
    declare
      v_blocked boolean;
      v_qty bigint;
    begin
      select coalesce(bool_or(al.quantity_remaining <> al.quantity), false),
             coalesce(sum(al.quantity_remaining), 0)
        into v_blocked, v_qty
        from public.acquisition_lots al
        where al.holding_id = v_hid and al.user_id = v_user_id and al.voided_at is null;

      if v_blocked then
        v_has_blocked := true;
      end if;

      v_result_holding := v_result_holding || v_hid;
      v_result_blocked := v_result_blocked || v_blocked;
      v_result_reason := v_result_reason || (
        case when v_blocked
          then 'One or more copies have already been partially removed elsewhere and cannot be corrected this way yet.'
          else null
        end
      );
      v_result_count := v_result_count || v_qty::int;
    end;
  end loop;

  -- Pass 2: nothing blocked anywhere in the selection -- void every live lot of every selected
  -- holding via void_acquisition_lot itself. The locks taken above are already held by this same
  -- transaction, so each void_acquisition_lot call's own FOR UPDATE re-acquires (never re-waits
  -- on) the row it already holds -- no additional blocking, no new deadlock exposure.
  if not v_has_blocked then
    perform public.void_acquisition_lot(al.id)
      from public.acquisition_lots al
      where al.holding_id = any(p_holding_ids) and al.user_id = v_user_id and al.voided_at is null;
  end if;

  return query
    select v_result_holding[i], v_result_blocked[i], v_result_reason[i], v_result_count[i]
    from generate_subscripts(v_result_holding, 1) as i;
end;
$$;

comment on function public.remove_holdings_from_portfolio(uuid[]) is
  'Bulk-safe Remove from Portfolio (M8.1 prompt §11): voids every live acquisition lot for each given holding via void_acquisition_lot, atomically. Locks every candidate lot FOR UPDATE (ascending id, one pass) before the blocked-status determination, so a concurrent create_sale always serializes against this instead of racing it (P130-03 / P132-B). No mutation happens if any holding is blocked. See DATA_MODEL.md §9 / DECISIONS.md D-051.';

-- ── 4. void_opening — lock every live pull lot before checking for a downstream disposal ─────────
create or replace function public.void_opening(p_opening_id uuid, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_opening public.openings;
  v_blocker record;
  v_pull_lot_ids uuid[];
  v_lot_id uuid;
begin
  if v_user_id is null then
    raise exception 'not authenticated';
  end if;

  select * into v_opening from public.openings
    where id = p_opening_id and user_id = v_user_id
  for update;

  if v_opening.id is null then
    raise exception 'opening % not found', p_opening_id;
  end if;
  if v_opening.voided_at is not null then
    raise exception 'opening % is already voided', p_opening_id;
  end if;

  -- Lock every still-live pull lot this opening produced, ascending id order, BEFORE checking for
  -- a downstream disposal (P130-03 / P132-B) -- the exact rows create_sale locks when it sells a
  -- pulled card. A concurrent sale already holding one of them is waited on here, so the blocker
  -- check below can never run against a lot whose disposal hasn't committed yet. The source lot
  -- (this opening's own consumption) is not in this set and needs no extra lock here: its restore
  -- is an unconditional D1 recompute, not a check-then-act decision.
  select coalesce(array_agg(al.id order by al.id), '{}') into v_pull_lot_ids
    from public.acquisition_lots al
    where al.opening_id = v_opening.id and al.voided_at is null;

  foreach v_lot_id in array v_pull_lot_ids loop
    perform 1 from public.acquisition_lots where id = v_lot_id for update;
  end loop;

  -- Downstream-dependency guard, re-evaluated against the now-locked rows: any non-voided
  -- disposal on any pull lot blocks the void.
  select ld.id as disposal_id, sl.sale_id
    into v_blocker
  from public.lot_disposals ld
  join public.acquisition_lots al on al.id = ld.lot_id
  left join public.sale_lines sl on sl.id = ld.sale_line_id
  where al.opening_id = v_opening.id
    and ld.voided_at is null
  limit 1;

  if v_blocker.disposal_id is not null then
    raise exception
      'opening % cannot be voided: a pulled card already has a downstream disposal (%) — void that transaction first',
      p_opening_id, coalesce(v_blocker.sale_id::text, v_blocker.disposal_id::text);
  end if;

  update public.openings
    set voided_at = now(), notes = coalesce(p_reason, notes)
    where id = v_opening.id;

  -- Restores the source lot via recompute_lot_quantity_remaining (D1).
  update public.lot_disposals
    set voided_at = now()
    where opening_id = v_opening.id and voided_at is null;

  update public.acquisition_lots
    set voided_at = now()
    where opening_id = v_opening.id and voided_at is null;

  -- P53 §10 policy (unchanged): NO purchase is touched here. The provisional purchase stays
  -- active so sealed inventory never outlives the money that paid for it.
end;
$$;

comment on function public.void_opening(uuid, text) is
  'Voids an opening atomically: restores the sealed lot (D1), corrects the pull lots through the void lifecycle. Locks every live pull lot FOR UPDATE (ascending id) before checking for a downstream disposal, so a concurrent sale of a pulled card always serializes against this instead of racing it (P130-03 / P132-B). The source purchase — provisional or real — deliberately STAYS ACTIVE. Blocked while any pull has been sold or otherwise disposed downstream. Already-voided is a named error.';

-- ── 5. Grants ────────────────────────────────────────────────────────────────────────────────
-- Every signature above is unchanged from its prior definition, so PostgreSQL preserves the
-- existing GRANT/REVOKE state across CREATE OR REPLACE automatically (same convention already
-- documented in 20260825120000_m81_void_acquisition_lot_fix.sql's own grants section) -- no new
-- revoke/grant statements are issued here. Verified post-migration by scripts/grant-audit.sql
-- reporting no drift for any of these four functions (see output_132_b_finance.txt GRANT_AUDIT).
