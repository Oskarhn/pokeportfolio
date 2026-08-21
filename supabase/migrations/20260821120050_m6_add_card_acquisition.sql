-- add_card_acquisition: the atomic add-to-collection operation (M6 prompt §42).
--
-- Finding-or-creating the holding and inserting the acquisition lot are two statements that must
-- never be observed half-done — an empty holding with no lot, or a lot with no valid holding.
-- A single SQL function body is already one transaction (a raised exception rolls back everything
-- the call did), so wrapping both statements in one function gives atomicity for free, without a
-- client-side multi-request transaction the browser cannot actually guarantee.
--
-- SECURITY INVOKER, not DEFINER: authenticated already holds INSERT on every table this touches
-- (holdings, acquisition_lots, purchases, purchase_lines, manual_valuations), so a DEFINER would
-- grant nothing a plain grant does not already — and would have to defend against a forged user id
-- that invoker rights make structurally impossible, since every write derives its owner from
-- auth.uid() inside the function body, not from a caller-supplied argument. RLS stays active for
-- every statement the function runs, exactly as if the caller had issued them directly.
--
-- Concurrency: two overlapping calls that would both create "the same" new holding are resolved by
-- the real unique index (holdings_identity, 20260821120020) rather than by application locking —
-- the loser's INSERT raises unique_violation, which the nested block below catches, re-reading the
-- identity the winner just committed. Exactly one holding results either way.
--
-- Scope cut, deliberate (M6 prompt §26): this is not the M8 purchase ledger. A Purchased/known-cost
-- acquisition creates one real, ordinary purchases/purchase_lines row (a single line, no shipping,
-- no customs, no discount) rather than a "provisional" one, because it *is* a complete, correct
-- purchase as far as it goes — M8 adds the ability to build a purchase with several lines,
-- shipping and a retailer, not a different kind of purchase. Currency is fixed to NOK: no FX
-- ingestion exists before M9, so accepting another currency here would have no honest NOK
-- conversion to freeze (FINANCIAL_MODEL.md §7, invariant F11).

create or replace function public.add_card_acquisition(
  p_card_variant_id uuid default null,
  p_manual_card_id uuid default null,
  p_grading_state public.grading_state default 'raw',
  p_condition public.card_condition default null,
  p_grader public.grader default null,
  p_grade numeric(3, 1) default null,
  p_cert_number text default null,
  p_is_favorite boolean default false,
  p_holding_notes text default null,
  p_origin public.lot_origin default 'purchase',
  p_cost_basis_state public.cost_basis_state default 'unknown',
  p_unit_cost_basis_minor bigint default null,
  p_quantity int default 1,
  p_acquired_on date default current_date,
  p_storage_location_id uuid default null,
  p_lot_notes text default null,
  p_manual_value_minor bigint default null
)
returns table (holding_id uuid, lot_id uuid)
language plpgsql
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_holding_kind public.holding_kind;
  v_holding_id uuid;
  v_lot_id uuid;
  v_purchase_id uuid;
  v_purchase_line_id uuid;
  v_total_minor bigint;
  v_description text;
begin
  if v_user_id is null then
    raise exception 'not authenticated';
  end if;

  if (p_card_variant_id is not null) = (p_manual_card_id is not null) then
    raise exception 'exactly one of p_card_variant_id / p_manual_card_id is required';
  end if;

  if p_quantity is null or p_quantity <= 0 then
    raise exception 'p_quantity must be a positive integer';
  end if;

  if p_acquired_on is null then
    raise exception 'p_acquired_on is required';
  end if;

  v_holding_kind := case p_grading_state
    when 'graded' then 'graded_card'::public.holding_kind
    else 'raw_card'::public.holding_kind
  end;

  if v_holding_kind = 'raw_card' and p_condition is null then
    raise exception 'p_condition is required for a raw card';
  end if;
  if v_holding_kind = 'graded_card' and (p_grader is null or p_grade is null) then
    raise exception 'p_grader and p_grade are required for a graded card';
  end if;

  -- ── Purchase + purchase line, only when the cost is actually known ──────────────────────────
  if p_cost_basis_state = 'known' then
    if p_unit_cost_basis_minor is null or p_unit_cost_basis_minor < 0 then
      raise exception 'p_unit_cost_basis_minor must be a non-negative amount when cost is known';
    end if;
    v_total_minor := p_unit_cost_basis_minor * p_quantity;

    if p_manual_card_id is not null then
      select name into v_description from public.manual_card_definitions where id = p_manual_card_id;
    end if;

    insert into public.purchases (
      user_id, origin, purchased_on, currency,
      subtotal_minor, shipping_minor, customs_minor, discount_minor, total_minor,
      fx_rate_to_nok, fx_rate_date, fx_source, total_nok_minor
    ) values (
      v_user_id, 'manual', p_acquired_on, 'NOK',
      v_total_minor, 0, 0, 0, v_total_minor,
      1, p_acquired_on, 'manual', v_total_minor
    )
    returning id into v_purchase_id;

    insert into public.purchase_lines (
      purchase_id, user_id, line_type, spend_class, description,
      card_variant_id, condition, quantity, unit_price_minor, line_total_minor,
      attributable_cost_minor, attributable_cost_nok_minor
    ) values (
      v_purchase_id, v_user_id, 'card', 'collectible', v_description,
      p_card_variant_id, p_condition, p_quantity, p_unit_cost_basis_minor, v_total_minor,
      v_total_minor, v_total_minor
    )
    returning id into v_purchase_line_id;
  end if;

  -- ── Find-or-create the holding, race-safe via holdings_identity ─────────────────────────────
  begin
    insert into public.holdings (
      user_id, holding_kind, card_variant_id, manual_card_id,
      condition, grading_state, grader, grade, cert_number, is_favorite, notes
    ) values (
      v_user_id, v_holding_kind, p_card_variant_id, p_manual_card_id,
      p_condition, p_grading_state, p_grader, p_grade, p_cert_number, p_is_favorite, p_holding_notes
    )
    returning id into v_holding_id;
  exception when unique_violation then
    select id into v_holding_id
      from public.holdings
      where user_id = v_user_id
        and holding_kind = v_holding_kind
        and coalesce(card_variant_id, sealed_product_id, manual_card_id)
            = coalesce(p_card_variant_id, p_manual_card_id)
        and coalesce(public.card_condition_to_text(condition), '')
            = coalesce(public.card_condition_to_text(p_condition), '')
        and grading_state = p_grading_state
        and coalesce(public.grader_to_text(grader), '') = coalesce(public.grader_to_text(p_grader), '')
        and coalesce(grade, -1) = coalesce(p_grade, -1)
        and deleted_at is null;
    if v_holding_id is null then
      raise;
    end if;
  end;

  -- ── The acquisition lot itself ───────────────────────────────────────────────────────────────
  insert into public.acquisition_lots (
    holding_id, user_id, origin, cost_basis_state, purchase_line_id, acquired_on,
    quantity, quantity_remaining, unit_cost_basis_minor, cost_basis_currency,
    unit_cost_basis_nok_minor, storage_location_id, notes
  ) values (
    v_holding_id, v_user_id, p_origin, p_cost_basis_state, v_purchase_line_id, p_acquired_on,
    p_quantity, p_quantity,
    case when p_cost_basis_state = 'known' then p_unit_cost_basis_minor end,
    case when p_cost_basis_state = 'known' then 'NOK' end,
    case when p_cost_basis_state = 'known' then p_unit_cost_basis_minor end,
    p_storage_location_id, p_lot_notes
  )
  returning id into v_lot_id;

  -- ── Optional manual value for a graded card, set at the moment it is added ──────────────────
  if p_manual_value_minor is not null then
    if v_holding_kind <> 'graded_card' then
      raise exception 'p_manual_value_minor is only meaningful for a graded card';
    end if;
    insert into public.manual_valuations (
      user_id, holding_id, value_minor, currency, value_nok_minor, effective_from
    ) values (
      v_user_id, v_holding_id, p_manual_value_minor, 'NOK', p_manual_value_minor, p_acquired_on
    );
  end if;

  return query select v_holding_id, v_lot_id;
end;
$$;

comment on function public.add_card_acquisition(
  uuid, uuid, public.grading_state, public.card_condition, public.grader, numeric,
  text, boolean, text, public.lot_origin, public.cost_basis_state, bigint, int, date, uuid, text, bigint
) is
  'Atomic add-to-collection: finds or creates the holding, then writes one acquisition lot (and, when the cost is known, the single-line purchase it traces to). See SECURITY.md §5.9/§12 and DATA_MODEL.md §5.4-5.5.';

-- set_manual_valuation: supersede-then-insert, so a graded/sealed holding's value history stays
-- append-only (DATA_MODEL.md §5.12) even though the client only ever calls one RPC.
create or replace function public.set_manual_valuation(
  p_holding_id uuid,
  p_value_minor bigint,
  p_note text default null,
  p_effective_from date default current_date
)
returns public.manual_valuations
language plpgsql
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_row public.manual_valuations;
begin
  if v_user_id is null then
    raise exception 'not authenticated';
  end if;
  if p_value_minor is null or p_value_minor < 0 then
    raise exception 'p_value_minor must be a non-negative amount';
  end if;

  update public.manual_valuations
    set superseded_at = now()
    where holding_id = p_holding_id and user_id = v_user_id and superseded_at is null;

  insert into public.manual_valuations (
    user_id, holding_id, value_minor, currency, value_nok_minor, effective_from, note
  ) values (
    v_user_id, p_holding_id, p_value_minor, 'NOK', p_value_minor, p_effective_from, p_note
  )
  returning * into v_row;

  return v_row;
end;
$$;

-- void_acquisition_lot: the correction path for a card added by mistake (M6 prompt §69). Retains
-- the row and excludes it from every calculation (DATA_MODEL.md §9's void semantics) rather than
-- deleting it. When the lot traces to a purchase this RPC itself created — M6's fast-add is always
-- one purchase, one line, one lot — and no other live lot still cites that line, the purchase is
-- voided too, so a corrected mistake never leaves a ghost spend counted in GPO/CS (invariant F1).
create or replace function public.void_acquisition_lot(p_lot_id uuid, p_reason text default null)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_lot public.acquisition_lots;
  v_other_live_lots int;
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

  update public.acquisition_lots
    set voided_at = now(), notes = coalesce(p_reason, notes)
    where id = p_lot_id and user_id = v_user_id;

  if v_lot.purchase_line_id is not null then
    select count(*) into v_other_live_lots
      from public.acquisition_lots
      where purchase_line_id = v_lot.purchase_line_id
        and id <> p_lot_id
        and voided_at is null;
    if v_other_live_lots = 0 then
      update public.purchases
        set voided_at = now()
        where id = (
          select purchase_id from public.purchase_lines where id = v_lot.purchase_line_id
        )
        and voided_at is null;
    end if;
  end if;
end;
$$;

grant execute on function public.add_card_acquisition(
  uuid, uuid, public.grading_state, public.card_condition, public.grader, numeric,
  text, boolean, text, public.lot_origin, public.cost_basis_state, bigint, int, date, uuid, text, bigint
) to authenticated;

grant execute on function public.set_manual_valuation(uuid, bigint, text, date) to authenticated;

grant execute on function public.void_acquisition_lot(uuid, text) to authenticated;
