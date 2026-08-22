-- M11 (Sealed Inventory): moves sealed_intent from holdings to acquisition_lots.
--
-- THE BUG (prompt §17, audited before any UI was built on the old shape). holdings_identity
-- (20260817120070) does not include sealed_intent, so every acquisition lot for the same sealed
-- product/condition/grading-state combination collapses into one holding row, and that one row
-- carries exactly one sealed_intent value (defaulted to 'undecided' by create_purchase,
-- 20260824120010, and never touched again on a repeat acquisition that matches the same identity).
-- A user who owns three identical booster boxes and wants two "keep sealed" and one "planned to
-- open" cannot express that: the old model has one intent slot per position, not one per physical
-- unit.
--
-- THE FIX. sealed_intent moves to `acquisition_lots`, which already tracks quantity as discrete
-- batches (one row per acquisition event) and already has a precedent for "organisational-only,
-- explicit, audited correction" (voiding, storage_location_id reassignment) rather than a silent
-- edit. holdings keeps its role as the identity bucket ("N units of Product X, in total"); lots
-- carry cost basis and, for sealed lots, intent. A Portfolio tile aggregates its own lots' intents
-- for display (list_portfolio, next migration) so the product still reads as one tile with a mixed-
-- intent breakdown, not as two duplicate Portfolio rows for the same product (prompt §19).
--
-- No real data is affected: sealed_intent has never been read or written by any shipped UI (M11 is
-- the first milestone to build on it), so this is a pre-launch schema correction, not a change
-- against real user data. The backfill below exists purely so a lot created by a stray manual test
-- against a dev project keeps a sensible value, not because production data depends on it.

-- ── 1. Move the column ──────────────────────────────────────────────────────────────────────────

alter table public.acquisition_lots
  add column sealed_intent public.sealed_intent;

update public.acquisition_lots al
  set sealed_intent = coalesce(h.sealed_intent, 'undecided')
  from public.holdings h
  where h.id = al.holding_id and h.holding_kind = 'sealed';

alter table public.holdings
  drop constraint holdings_sealed_intent_scope;

alter table public.holdings
  drop column sealed_intent;

-- ── 2. Enforce scope on the new column ──────────────────────────────────────────────────────────
-- acquisition_lots has no holding_kind column of its own — it is derived from the parent holding —
-- so this cannot be a plain CHECK constraint on this table; it is folded into the existing
-- ownership trigger below, which already looks the parent holding up for every insert/update.

create or replace function public.acquisition_lots_check_owner()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  parent_user_id uuid;
  parent_holding_kind public.holding_kind;
  line_user_id uuid;
begin
  select user_id, holding_kind into parent_user_id, parent_holding_kind
    from public.holdings where id = new.holding_id;
  if parent_user_id is null or new.user_id <> parent_user_id then
    raise exception 'acquisition_lots.user_id must match the owner of holding %', new.holding_id;
  end if;

  if parent_holding_kind = 'sealed' and new.sealed_intent is null then
    raise exception 'sealed_intent is required for a lot on a sealed holding';
  end if;
  if parent_holding_kind <> 'sealed' and new.sealed_intent is not null then
    raise exception 'sealed_intent only applies to a lot on a sealed holding';
  end if;

  if new.purchase_line_id is not null then
    select user_id into line_user_id from public.purchase_lines where id = new.purchase_line_id;
    if line_user_id is null or line_user_id <> new.user_id then
      raise exception 'acquisition_lots.purchase_line_id must belong to the same owner';
    end if;
  end if;

  return new;
end;
$$;

-- ── 3. set_sealed_lot_intent — the organisational-only intent change ───────────────────────────
-- Splits the lot when the change applies to only part of what remains in it (prompt §18/§79's
-- mandatory cardinality gate). SECURITY INVOKER: RLS already lets the owner update/insert their own
-- acquisition_lots rows; the only reason this needs an RPC at all (rather than a plain column-level
-- UPDATE grant, like storage_location_id already has) is that a partial change must insert a
-- sibling lot and shrink the original atomically, which two separate REST calls could never
-- guarantee. Both resulting lots keep the OLD lot's unit_cost_basis_minor/unit_cost_basis_nok_minor
-- unchanged, so total cost basis is conserved exactly; residual_minor/residual_nok_minor (a small
-- leftover from the ORIGINAL purchase allocation's integer division, unrelated to this split) stays
-- entirely on the shrunk original lot, so nothing is invented or dropped (FINANCIAL_MODEL.md §1.1,
-- prompt §20/§80: changing intent must never touch cost basis, spend or market value). The D1
-- invariant (quantity_remaining = quantity − Σ disposals, 20260828120000) is preserved by
-- construction: both quantity and quantity_remaining shrink by the same amount on the original lot,
-- and the new lot starts with zero disposals against it either way.
create or replace function public.set_sealed_lot_intent(
  p_lot_id uuid,
  p_intent public.sealed_intent,
  p_quantity int default null
)
returns public.acquisition_lots
language plpgsql
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_lot public.acquisition_lots;
  v_holding_kind public.holding_kind;
  v_split_qty int;
  v_new_lot public.acquisition_lots;
begin
  if v_user_id is null then
    raise exception 'not authenticated';
  end if;
  if p_intent is null then
    raise exception 'p_intent is required';
  end if;

  select * into v_lot from public.acquisition_lots where id = p_lot_id and user_id = v_user_id;
  if v_lot.id is null then
    raise exception 'acquisition lot % not found', p_lot_id;
  end if;
  if v_lot.voided_at is not null then
    raise exception 'acquisition lot % is voided', p_lot_id;
  end if;

  select holding_kind into v_holding_kind from public.holdings where id = v_lot.holding_id;
  if v_holding_kind <> 'sealed' then
    raise exception 'sealed_intent only applies to a sealed holding''s lot';
  end if;

  v_split_qty := coalesce(p_quantity, v_lot.quantity_remaining);
  if v_split_qty <= 0 or v_split_qty > v_lot.quantity_remaining then
    raise exception 'p_quantity must be between 1 and the lot''s quantity_remaining (%)', v_lot.quantity_remaining;
  end if;

  if v_split_qty = v_lot.quantity_remaining then
    -- Whole lot: every unit still in this lot moves to the new intent, no split needed.
    update public.acquisition_lots
      set sealed_intent = p_intent
      where id = p_lot_id
      returning * into v_lot;
    return v_lot;
  end if;

  -- Partial: carve v_split_qty units into a new, otherwise-identical lot at the new intent, and
  -- shrink the original by the same amount.
  insert into public.acquisition_lots (
    holding_id, user_id, origin, cost_basis_state, purchase_line_id, acquired_on,
    quantity, quantity_remaining, unit_cost_basis_minor, cost_basis_currency,
    unit_cost_basis_nok_minor, residual_minor, residual_nok_minor, storage_location_id, notes,
    sealed_intent
  ) values (
    v_lot.holding_id, v_user_id, v_lot.origin, v_lot.cost_basis_state, v_lot.purchase_line_id,
    v_lot.acquired_on, v_split_qty, v_split_qty, v_lot.unit_cost_basis_minor, v_lot.cost_basis_currency,
    v_lot.unit_cost_basis_nok_minor, 0, 0, v_lot.storage_location_id, v_lot.notes,
    p_intent
  )
  returning * into v_new_lot;

  update public.acquisition_lots
    set quantity = quantity - v_split_qty,
        quantity_remaining = quantity_remaining - v_split_qty
    where id = p_lot_id;

  return v_new_lot;
end;
$$;

revoke execute on function public.set_sealed_lot_intent(uuid, public.sealed_intent, int) from public;
grant execute on function public.set_sealed_lot_intent(uuid, public.sealed_intent, int) to authenticated;
