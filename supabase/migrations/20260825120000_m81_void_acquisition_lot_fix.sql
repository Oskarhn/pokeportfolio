-- M8.1: Portfolio correction (prompt §3-13, DECISIONS.md D-051).
--
-- The owner tested the deployed M8 build and found Portfolio's select mode has no way to remove
-- an accidentally-added card. Before wiring that up, the prompt required auditing
-- void_acquisition_lot's M8-era auto-void-parent-purchase logic against a mixed receipt (a card
-- line plus a non-inventory line, e.g. an accessory) — and the audit found a real bug: the check
-- only ever counted *other live lots*, never *other lines*. A purchase line that never produces a
-- lot at all (accessory, shipping_standalone, customs_standalone, grading_fee, grading_shipping,
-- bulk_lot, other) was invisible to it, so voiding the sole card lot in a "card + accessory"
-- purchase silently auto-voided the whole receipt — erasing real, unrelated accessory spend from
-- CS/HS/GPO as a side effect of correcting one card. tests/db/m8_purchase_ledger.test.ts's existing
-- "two-card purchase" case never exercised this, because both of its lines produce lots.
--
-- THE FIX. Auto-void the parent purchase only when every *other* line on the receipt is already
-- accounted for: a card/sealed line whose own lot has also been voided, or no other line exists at
-- all. A line that can never have a lot (accessory and the rest) can never become "accounted for",
-- so its mere presence permanently blocks auto-void — its spend has no other way to leave the
-- ledger. This is a strict correction, not a behaviour change, for every purchase that exists
-- today: a single-line (M6-shape) purchase still auto-voids exactly as before, and the existing
-- two-card-purchase test (both lines are 'card') still auto-voids once the *second* lot is voided,
-- unchanged — the old check and the new one agree whenever every line produces a lot. They disagree
-- only for the case that was wrong.
--
-- SECOND FIX, discovered by the same audit (not previously guarded at all): void_acquisition_lot
-- never checked quantity_remaining before voiding. update_purchase/void_purchase already refuse to
-- touch a purchase if any of its lots has quantity_remaining <> quantity (something has disposed
-- part of it) — the same guard belongs on a single lot's void, for the same reason: voiding a lot
-- that has already been partially sold/opened/traded elsewhere would retroactively erase the cost
-- basis a real, already-recorded disposal still needs. Like that existing guard, this is currently
-- unreachable through any real product flow (no disposal-producing milestone has shipped), and is
-- implemented now, pre-emptively, so a future milestone does not have to touch this function.
--
-- THE NEW RPC. remove_holdings_from_portfolio(uuid[]) is the atomic, all-or-nothing bulk surface
-- Portfolio's select mode calls (BACKLOG.md's "bulk_void_lots(uuid[])" item, DECISIONS.md D-045).
-- It voids every live lot of every given holding via void_acquisition_lot itself — the parent-
-- purchase correction above therefore applies uniformly whether a holding is removed individually
-- (the pre-existing Holding Detail "Void" button) or in bulk. The only way a holding can be
-- "blocked" is the same quantity_remaining guard above; when any selected holding is blocked, the
-- whole call performs zero mutations and reports which holdings and why, rather than voiding some
-- and silently skipping others.

-- ── 1. void_acquisition_lot, corrected ──────────────────────────────────────────────────────────
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

  select * into v_lot from public.acquisition_lots where id = p_lot_id and user_id = v_user_id;
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

    -- Every *other* line on this purchase must already be accounted for: a card/sealed line whose
    -- own lot is also voided (al.id is not null and al.voided_at is not null), counted as safe by
    -- the `and (al.id is null or al.voided_at is null)` predicate evaluating to false for it. A
    -- line with no lot at all (al.id is null via the LEFT JOIN) always evaluates true — permanently
    -- unaccounted, permanently blocking auto-void. This is the exact fix for the bug above.
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
  'Correction path for one acquisition lot. Auto-voids its parent purchase only when every other line on the receipt is already accounted for (a voided lot, or no other line at all) — never when a non-inventory line (accessory, shipping, etc.) still represents live spend. Refuses to void a lot that has already been partially disposed elsewhere. See DECISIONS.md D-051.';

-- ── 2. remove_holdings_from_portfolio — the bulk-safe Remove from Portfolio surface ─────────────
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

  -- Pass 1: determine per-holding blocked status without mutating anything. A holding is blocked
  -- only when one of its live lots has already been partially disposed elsewhere — the same guard
  -- void_acquisition_lot itself now enforces (§1 above). Nothing else can make a removal unsafe:
  -- the parent-purchase correction is handled entirely inside void_acquisition_lot itself, so a
  -- multi-line purchase is never a reason to block here.
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

  -- Pass 2: nothing blocked anywhere in the selection — void every live lot of every selected
  -- holding. One statement, not a client-side loop: PERFORM's target-list function call is
  -- evaluated once per row the FROM clause returns, and a raised exception here (defence in depth
  -- only — pass 1 already ruled every one of these lots safe) aborts this whole function call,
  -- rolling back any lot already voided earlier in the same statement. No partial mutation either
  -- way.
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
  'Bulk-safe Remove from Portfolio (M8.1 prompt §11): voids every live acquisition lot for each given holding via void_acquisition_lot, atomically. No mutation happens if any holding is blocked. See DATA_MODEL.md §9 / DECISIONS.md D-051.';

-- PostgreSQL grants EXECUTE on a newly created function to PUBLIC by default — revoke it
-- explicitly at creation, same as every function-creating migration since M4. void_acquisition_lot
-- keeps its existing grants across CREATE OR REPLACE (same signature, so no re-grant needed there).
revoke execute on function public.remove_holdings_from_portfolio(uuid[]) from public;
grant execute on function public.remove_holdings_from_portfolio(uuid[]) to authenticated;
