-- M11: add_card_acquisition gains a direct sealed-product path (prompt §23-27/§92 — "Add sealed
-- product" outside a multi-line purchase). No new function: create_purchase (M8) already proved
-- one write path can serve both 'card' and 'sealed' lines, and this is the single-item equivalent
-- of that same RPC — reusing it means Portfolio/Search/QuickAddMenu's direct-add flow and the
-- multi-line purchase builder stay on exactly one atomic write path each, never two that could
-- silently disagree (SECURITY.md §12 checklist, prompt §72's "do not create sealed-specific bypass
-- logic").
--
-- DROP+CREATE (D-054/D-059 discipline, TESTING.md §6a): adding a parameter changes a function's
-- identity (Postgres matches CREATE OR REPLACE against the exact input-parameter-type list) even
-- though every existing parameter keeps its position, type and default — the same rule
-- 20260826120030_m9_list_portfolio_resolver.sql's header already documents. The OLD 17-parameter
-- signature is dropped explicitly below so it does not linger as a second, stale overload.
--
-- sealed_intent now lives on acquisition_lots, not holdings (20260829120000) — the lot this function
-- creates gets p_sealed_intent directly; there is no holdings.sealed_intent column left to set.

drop function if exists public.add_card_acquisition(
  uuid, uuid, public.grading_state, public.card_condition, public.grader, numeric,
  text, boolean, text, public.lot_origin, public.cost_basis_state, bigint, int, date, uuid, text, bigint
);

create function public.add_card_acquisition(
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
  p_manual_value_minor bigint default null,
  p_sealed_product_id uuid default null,
  p_sealed_intent public.sealed_intent default 'undecided'
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
  v_identity_count int;
begin
  if v_user_id is null then
    raise exception 'not authenticated';
  end if;

  v_identity_count := (p_card_variant_id is not null)::int
    + (p_manual_card_id is not null)::int
    + (p_sealed_product_id is not null)::int;
  if v_identity_count <> 1 then
    raise exception 'exactly one of p_card_variant_id / p_manual_card_id / p_sealed_product_id is required';
  end if;

  if p_quantity is null or p_quantity <= 0 then
    raise exception 'p_quantity must be a positive integer';
  end if;

  if p_acquired_on is null then
    raise exception 'p_acquired_on is required';
  end if;

  if p_sealed_product_id is not null then
    v_holding_kind := 'sealed';
    p_condition := null;
    p_grading_state := 'raw';
    p_grader := null;
    p_grade := null;
    if p_sealed_intent is null then
      raise exception 'p_sealed_intent is required for a sealed product';
    end if;
    -- A sealed product may be referenced only if it is curated or the caller's own
    -- (prompt §69) — this function is SECURITY INVOKER, so this SELECT runs under RLS as the
    -- caller: sealed_products_read already hides another user's private row, so a cross-tenant
    -- id reads as "not found", never confirming the row exists. Enforced here, not merely by
    -- Search omitting it from results — a forged id must fail server-side.
    if not exists (select 1 from public.sealed_products where id = p_sealed_product_id) then
      raise exception 'sealed product % not found or not accessible', p_sealed_product_id;
    end if;
  else
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
  end if;

  -- ── Purchase + purchase line, only when the cost is actually known ──────────────────────────
  if p_cost_basis_state = 'known' then
    if p_unit_cost_basis_minor is null or p_unit_cost_basis_minor < 0 then
      raise exception 'p_unit_cost_basis_minor must be a non-negative amount when cost is known';
    end if;
    v_total_minor := p_unit_cost_basis_minor * p_quantity;

    if p_manual_card_id is not null then
      select name into v_description from public.manual_card_definitions where id = p_manual_card_id;
    elsif p_sealed_product_id is not null then
      select name into v_description from public.sealed_products where id = p_sealed_product_id;
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
      card_variant_id, sealed_product_id, condition, quantity, unit_price_minor, line_total_minor,
      attributable_cost_minor, attributable_cost_nok_minor
    ) values (
      v_purchase_id, v_user_id,
      case when p_sealed_product_id is not null then 'sealed' else 'card' end::public.line_type,
      'collectible', v_description,
      p_card_variant_id, p_sealed_product_id, p_condition, p_quantity, p_unit_cost_basis_minor,
      v_total_minor, v_total_minor, v_total_minor
    )
    returning id into v_purchase_line_id;
  end if;

  -- ── Find-or-create the holding, race-safe via holdings_identity ─────────────────────────────
  begin
    insert into public.holdings (
      user_id, holding_kind, card_variant_id, manual_card_id, sealed_product_id,
      condition, grading_state, grader, grade, cert_number, is_favorite, notes
    ) values (
      v_user_id, v_holding_kind, p_card_variant_id, p_manual_card_id, p_sealed_product_id,
      p_condition, p_grading_state, p_grader, p_grade, p_cert_number, p_is_favorite, p_holding_notes
    )
    returning id into v_holding_id;
  exception when unique_violation then
    select id into v_holding_id
      from public.holdings
      where user_id = v_user_id
        and holding_kind = v_holding_kind
        and coalesce(card_variant_id, sealed_product_id, manual_card_id)
            = coalesce(p_card_variant_id, p_sealed_product_id, p_manual_card_id)
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
    unit_cost_basis_nok_minor, storage_location_id, notes, sealed_intent
  ) values (
    v_holding_id, v_user_id, p_origin, p_cost_basis_state, v_purchase_line_id, p_acquired_on,
    p_quantity, p_quantity,
    case when p_cost_basis_state = 'known' then p_unit_cost_basis_minor end,
    case when p_cost_basis_state = 'known' then 'NOK' end,
    case when p_cost_basis_state = 'known' then p_unit_cost_basis_minor end,
    p_storage_location_id, p_lot_notes,
    case when v_holding_kind = 'sealed' then p_sealed_intent end
  )
  returning id into v_lot_id;

  -- ── Optional manual value, set at the moment it is added ────────────────────────────────────
  -- M11: sealed joins graded as the two holding kinds with no automatic price, so both may carry an
  -- initial manual valuation here (FINANCIAL_MODEL.md §6.2/§6.3 — the same manual-or-missing rule).
  if p_manual_value_minor is not null then
    if v_holding_kind not in ('graded_card', 'sealed') then
      raise exception 'p_manual_value_minor is only meaningful for a graded or sealed holding';
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
  text, boolean, text, public.lot_origin, public.cost_basis_state, bigint, int, date, uuid, text,
  bigint, uuid, public.sealed_intent
) is
  'Atomic add-to-collection for a card, manual card, or sealed product: finds or creates the holding, then writes one acquisition lot (with sealed_intent for a sealed lot) and, when the cost is known, the single-line purchase it traces to. See SECURITY.md §5.9/§12 and DATA_MODEL.md §5.4-5.5.';

revoke execute on function public.add_card_acquisition(
  uuid, uuid, public.grading_state, public.card_condition, public.grader, numeric,
  text, boolean, text, public.lot_origin, public.cost_basis_state, bigint, int, date, uuid, text,
  bigint, uuid, public.sealed_intent
) from public;
grant execute on function public.add_card_acquisition(
  uuid, uuid, public.grading_state, public.card_condition, public.grader, numeric,
  text, boolean, text, public.lot_origin, public.cost_basis_state, bigint, int, date, uuid, text,
  bigint, uuid, public.sealed_intent
) to authenticated;
