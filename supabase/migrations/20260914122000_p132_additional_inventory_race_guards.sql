-- P132: set_sealed_lot_intent and void_sale lock their lots before validating or writing.
--
-- THE BUG. set_sealed_lot_intent (20260829120000_m11_sealed_intent_lot_level.sql) read the target
-- lot WITHOUT a lock, validated the requested split quantity against that read's
-- quantity_remaining, then inserted the carved sibling lot and shrank the original. Racing a
-- create_sale on the same lot (which locks the lot FOR UPDATE and disposes units from it), the
-- validation passed against units the sale had just taken; the only thing that stopped the write
-- was the acquisition_lots_remaining_in_range CHECK, surfacing as a raw SQLSTATE 23514 instead of
-- a domain refusal. Integrity held only because the schema backstop fired.
--
-- A second consequence of the same order: the partial path's FIRST write is the INSERT of the new
-- sibling lot, whose ledger triggers upsert the owner's portfolio recompute queue row, and only
-- the following UPDATE took the original lot's row lock. Every other ledger RPC takes its lot
-- locks first and writes that queue row afterwards, so a split racing update_purchase or
-- void_purchase on the same purchase could deadlock (40P01). Found by the independent P132-C
-- package (held-lock matrix row M20; deadlock search) against the integrated P132 candidate.
--
-- THE FIX. Lock the target lot with SELECT ... FOR UPDATE as the function's first statement that
-- touches the ledger, then validate voided state, holding kind and quantity_remaining from the
-- locked row, then write. A single target lot needs no ordering beyond that: the function locks
-- exactly one acquisition_lots row, and it does so before any write, which is the same
-- lots-before-writes order create_sale, update_purchase, void_purchase, void_acquisition_lot,
-- remove_holdings_from_portfolio and void_opening use. A split request that a concurrent sale has
-- made too large is now the existing domain refusal ("p_quantity must be between 1 and the lot's
-- quantity_remaining"). Intent semantics, cost-basis conservation and the signature are unchanged.
--
-- CREATE OR REPLACE with the identical signature: PostgreSQL keeps the existing EXECUTE grants
-- (authenticated only), so no grant statement is issued; scripts/grant-audit.sql verifies it.

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

  -- Lock first: every check below reads the locked row, and nothing is written before the lock.
  select * into v_lot from public.acquisition_lots
    where id = p_lot_id and user_id = v_user_id
    for update;
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
  -- shrink the original by the same amount. Cost basis is conserved exactly (unchanged M11 rule).
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

-- ── void_sale: lock the sale's lots before its first ledger write ───────────────────────────────
--
-- THE BUG. void_sale (20260828120010_m10_sales_rpc.sql) first UPDATEs the sales row -- whose
-- ledger trigger upserts the owner's portfolio recompute queue row -- and only then voids the
-- sale's disposals, where the D1 recompute trigger takes each disposed lot's row lock. create_sale
-- takes the opposite order: lot locks first, queue row later. A void_sale and a create_sale on the
-- same lot could therefore each hold what the other needed: the P132-C deadlock search found
-- 40P01 deadlocks for exactly this pair (4 of 500 seeded iterations, unsynchronised mode) once
-- every other correction RPC had been fixed. The same order also leaves the D1 trigger exposed to
-- the race fixed for void_opening in 20260914121000: its read of live disposals could run before a
-- concurrent sale's disposal committed and then write a stale quantity_remaining.
--
-- THE FIX. Lock every lot the sale disposed from, ascending id, before the first write; re-check
-- the sale's voided state from a statement that starts after those locks are held (a concurrent
-- void of the same sale that committed meanwhile is the existing named refusal), then write. The
-- sale's lines cannot change underneath (update_sale never adds or repoints a line), so the lot
-- set read before the locks is complete. Semantics, signature, SECURITY DEFINER and grants are
-- unchanged.
create or replace function public.void_sale(p_sale_id uuid, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_existing public.sales;
  v_lot_ids uuid[];
  v_lot_id uuid;
begin
  if v_user_id is null then
    raise exception 'not authenticated';
  end if;

  select * into v_existing from public.sales where id = p_sale_id and user_id = v_user_id;
  if v_existing.id is null then
    raise exception 'sale % not found', p_sale_id;
  end if;
  if v_existing.voided_at is not null then
    raise exception 'sale % is already voided', p_sale_id;
  end if;

  select coalesce(array_agg(distinct sl.lot_id order by sl.lot_id), '{}') into v_lot_ids
    from public.sale_lines sl
    where sl.sale_id = p_sale_id;

  foreach v_lot_id in array v_lot_ids loop
    perform 1 from public.acquisition_lots where id = v_lot_id for update;
  end loop;

  if exists (select 1 from public.sales where id = p_sale_id and voided_at is not null) then
    raise exception 'sale % is already voided', p_sale_id;
  end if;

  update public.sales
    set voided_at = now(), notes = coalesce(p_reason, notes)
    where id = p_sale_id;

  update public.lot_disposals ld
    set voided_at = now()
    from public.sale_lines sl
    where sl.id = ld.sale_line_id
      and sl.sale_id = p_sale_id
      and ld.voided_at is null;
end;
$$;

comment on function public.void_sale(uuid, text) is
  'Voids a whole sale and reverses every disposal it produced, atomically. Locks every lot the sale disposed from (ascending id) before its first write, so it serializes against create_sale on those lots instead of deadlocking or letting the D1 recompute read a stale disposal set (P132). Already-voided is a named error (prompt §93), never a silent no-op that could double-restore quantity.';
