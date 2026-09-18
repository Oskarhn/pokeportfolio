-- P144 (docs/DECISIONS.md D-135, the P130 audit report (output_130.txt) P130-16, P130-17, P130-18
-- date dimension). Three independent server-side boundary defects in the finance write path, fixed
-- together because each needs the same kind of change (a new migration that only widens what is
-- accepted, or narrows it to values that were never legitimate) and none changes an RPC signature.
--
--  1. P130-16  a valid receipt was refused because the discount was allocated by goods weight only
--  2. P130-17  a sale with unknown cost basis and negative net proceeds could not be recorded
--  3. P130-18  completed-event dates were unchecked (0001-01-01 and 9999-12-31 were accepted)
--
-- (P130-18's currency dimension was closed by P133 and is not touched here. P130-25, blank price
-- input, is a client-side finding with no migration.)
--
-- FUNCTION_SIGNATURES_CHANGED=no for every existing RPC. One NEW function is added
-- (allocate_purchase_discount) and is granted below and in 20260918120010_p144_privilege_baseline.sql.
-- OLD_CLIENT_COMPATIBILITY: the released frontend keeps working unchanged — every change either
-- accepts strictly more (P130-16, P130-17) or refuses only values the released forms already refuse
-- client-side (P130-18: the purchase/sale/scanner date inputs carry max=today). The one behavioural
-- difference a released client can observe is that a receipt it could not save before can now be
-- saved. COORDINATED_DEPLOYMENT_REQUIRED=no: this migration may be applied to the hosted database
-- before or after the P144 frontend, in either order.
--
-- ── 1. P130-16 — discount allocation ─────────────────────────────────────────────────────────────
-- THE BUG. create_purchase/update_purchase allocated shipping, customs and the discount each by
-- line_total, then set  attributable_i = line_total_i + ship_i + customs_i - discount_i  and passed
-- those to allocate_largest_remainder(total_nok, attributable), which rejects negative weights.
-- The documented rule (FINANCIAL_MODEL.md §4.1) is sound while the discount does not exceed the
-- goods: allocate(D, line_totals)_i <= line_total_i, so attributable_i >= 0. When the discount also
-- consumes shipping/customs (D > subtotal, still a valid receipt as long as D <= subtotal +
-- shipping + customs), allocating all of D by goods weight can take MORE than line_total_i from a
-- line whose share of shipping/customs was rounded down, and the line goes negative. Minimal
-- reproduction (P130 T8-alloc): goods [1, 2], shipping 1, customs 1, discount 5. The receipt total
-- is 0 (a free order), but goods-only weights split the discount [2, 3] against attributable
-- [1, 4], leaving [-1, 1] and the call failed with "weights must be non-negative". A second class
-- (all-zero goods, shipping 3 + customs 7, discount 10) fails the same way through the equal-split
-- fallback's tie-breaking. Neither is an invalid receipt; both were refused.
--
-- THE FIX (allocate_purchase_discount). Two tiers, both the exact largest-remainder allocator:
--   goods tier   least(D, subtotal), allocated by line_total   — the documented rule, unchanged
--   charge tier  D - goods tier (the part of the discount that exceeds the goods), allocated by each
--                line's already-allocated shipping + customs
-- Lemma (exercised by the property tests in tests/db/p144_financial_boundary.test.ts): for
-- non-negative integer weights w with sum W and 0 <= T <= W, allocate(T, w)_i <= w_i. Proof sketch:
-- T = W gives w_i exactly; T < W gives floor(T*w_i/W) <= w_i - 1 for w_i > 0 plus at most one
-- leftover unit, and a zero-weight line has remainder 0 and can never be among the leftover
-- recipients (there are strictly more positive-remainder lines than leftover units, because the
-- remainders sum to leftover * W and each is < W). Applied to each tier this gives discount_i <=
-- line_total_i + shipping_i + customs_i, so attributable_i >= 0 for every receipt with D <=
-- subtotal + shipping + customs, and sum(attributable_i) = subtotal + shipping + customs - D =
-- total exactly (F6 holds per tier). For D <= subtotal the charge tier is empty and the result is
-- IDENTICAL to the pre-P144 allocation — no existing purchase's stored or re-derived allocation
-- changes. A receipt with D > subtotal + shipping + customs cannot be allocated (a negative total)
-- and is still refused with the unchanged message "discount cannot exceed the purchase subtotal
-- plus shipping and customs". Nothing is clipped, floored or hidden.
create or replace function public.allocate_purchase_discount(
  p_discount bigint,
  p_line_totals bigint[],
  p_alloc_shipping bigint[],
  p_alloc_customs bigint[]
)
returns bigint[]
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_n int := coalesce(array_length(p_line_totals, 1), 0);
  v_subtotal numeric := 0;
  v_charges numeric := 0;
  v_goods_discount bigint;
  v_charge_discount bigint;
  v_charge_weights bigint[] := '{}';
  v_goods_alloc bigint[];
  v_charge_alloc bigint[];
  v_result bigint[] := '{}';
  i int;
begin
  if v_n = 0 then
    raise exception 'allocate_purchase_discount: at least one line is required';
  end if;
  if coalesce(array_length(p_alloc_shipping, 1), 0) <> v_n
     or coalesce(array_length(p_alloc_customs, 1), 0) <> v_n then
    raise exception 'allocate_purchase_discount: line totals, shipping and customs must have the same length';
  end if;
  if p_discount is null or p_discount < 0 then
    raise exception 'allocate_purchase_discount: discount must be non-negative';
  end if;

  for i in 1 .. v_n loop
    if p_line_totals[i] is null or p_alloc_shipping[i] is null or p_alloc_customs[i] is null then
      raise exception 'allocate_purchase_discount: arrays must not contain NULL';
    end if;
    v_subtotal := v_subtotal + p_line_totals[i];
    v_charges := v_charges + p_alloc_shipping[i]::numeric + p_alloc_customs[i]::numeric;
    v_charge_weights := v_charge_weights || (p_alloc_shipping[i] + p_alloc_customs[i]);
  end loop;

  if p_discount::numeric > v_subtotal + v_charges then
    raise exception 'discount cannot exceed the purchase subtotal plus shipping and customs';
  end if;

  v_goods_discount := least(p_discount::numeric, v_subtotal)::bigint;
  v_charge_discount := p_discount - v_goods_discount;

  v_goods_alloc := public.allocate_largest_remainder(v_goods_discount, p_line_totals);
  v_charge_alloc := public.allocate_largest_remainder(v_charge_discount, v_charge_weights);

  for i in 1 .. v_n loop
    v_result := v_result || (v_goods_alloc[i] + v_charge_alloc[i]);
  end loop;
  return v_result;
end;
$$;

revoke execute on function public.allocate_purchase_discount(bigint, bigint[], bigint[], bigint[]) from public;
grant execute on function public.allocate_purchase_discount(bigint, bigint[], bigint[], bigint[]) to authenticated;

comment on function public.allocate_purchase_discount(bigint, bigint[], bigint[], bigint[]) is
  'Per-line share of a purchase-level discount (P130-16/P144, D-135). Two tiers, both exact largest-remainder: least(discount, subtotal) by line total (the documented FINANCIAL_MODEL.md §4.1 rule), then the remainder of the discount by each line''s already-allocated shipping + customs. Guarantees 0 <= discount_i <= line_total_i + shipping_i + customs_i for every receipt whose discount does not exceed subtotal + shipping + customs (which is refused, unchanged, otherwise), and sum(discount_i) = discount exactly. Identical to allocate_largest_remainder(discount, line_totals) whenever discount <= subtotal. Granted to authenticated because create_purchase/update_purchase are SECURITY INVOKER and reach it as the caller''s own role.';

-- create_purchase and update_purchase: bodies restated in full (CREATE OR REPLACE), exactly ONE
-- statement changed in each — the v_alloc_discount assignment. Everything else, including the
-- idempotent-replay handling (D-121/D-122), the P132 multi-lot integrity and lock-order fixes and
-- the P133 exponent-aware NOK conversion, is copied unchanged from 20260915120000.
create or replace function public.create_purchase(
  p_purchased_on date,
  p_currency text,
  p_lines jsonb,
  p_retailer_id uuid default null,
  p_shipping_minor bigint default 0,
  p_customs_minor bigint default 0,
  p_discount_minor bigint default 0,
  p_fx_rate_to_nok numeric(18, 8) default null,
  p_fx_rate_date date default null,
  p_fx_source public.fx_source default null,
  p_notes text default null,
  p_idempotency_key uuid default null
)
returns public.purchases
language plpgsql
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_purchase public.purchases;
  v_line jsonb;
  v_line_count int;
  v_idx int;
  v_line_totals bigint[] := '{}';
  v_line_types public.line_type[] := '{}';
  v_spend_classes public.spend_class[] := '{}';
  v_subtotal bigint := 0;
  v_total bigint;
  v_total_nok bigint;
  v_fx_rate numeric(18, 8);
  v_alloc_ship bigint[];
  v_alloc_customs bigint[];
  v_alloc_discount bigint[];
  v_attributable bigint[] := '{}';
  v_attributable_nok bigint[];
  v_collectible_total bigint := 0;
  v_hobby_total bigint := 0;
  v_line_type public.line_type;
  v_quantity int;
  v_unit_price bigint;
  v_line_total bigint;
  v_spend_class public.spend_class;
  v_spend_class_override text;
  v_description text;
  v_card_variant_id uuid;
  v_manual_card_id uuid;
  v_sealed_product_id uuid;
  v_condition public.card_condition;
  v_grading_state public.grading_state;
  v_grader public.grader;
  v_grade numeric(3, 1);
  v_cert_number text;
  v_storage_location_id uuid;
  v_is_favorite boolean;
  v_lot_notes text;
  v_manual_value_minor bigint;
  v_manual_name text;
  v_holding_kind public.holding_kind;
  v_holding_id uuid;
  v_lot_id uuid;
  v_line_id uuid;
  v_unit_cost_basis bigint;
  v_residual int;
  v_unit_cost_basis_nok bigint;
  v_residual_nok bigint;
  v_sealed_intent public.sealed_intent;
  v_material jsonb;
  v_existing public.purchases;
begin
  if v_user_id is null then
    raise exception 'not authenticated';
  end if;

  -- ── Idempotent replay BEFORE any validation or ledger write ──────────────────────────────────
  v_material := jsonb_build_object(
    'purchased_on', p_purchased_on,
    'currency', p_currency,
    'retailer_id', p_retailer_id,
    'shipping_minor', coalesce(p_shipping_minor, 0),
    'customs_minor', coalesce(p_customs_minor, 0),
    'discount_minor', coalesce(p_discount_minor, 0),
    'fx_rate_to_nok', p_fx_rate_to_nok,
    'fx_rate_date', p_fx_rate_date,
    'fx_source', p_fx_source,
    'lines', (
      select jsonb_agg((elem - 'lot_notes') order by ord)
      from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) with ordinality as t(elem, ord)
    )
  );

  if p_idempotency_key is not null then
    select * into v_existing from public.purchases
      where user_id = v_user_id and idempotency_key = p_idempotency_key;
    if v_existing.id is not null then
      if v_existing.idempotency_request is distinct from v_material then
        raise exception
          'idempotency-key-reuse: key % already belongs to a different purchase request',
          p_idempotency_key;
      end if;
      -- P111/D-122: notes are user-visible content, not operational metadata — a legitimate
      -- replay must not silently discard an edit the caller made to notes before retrying.
      if v_existing.notes is distinct from p_notes then
        update public.purchases set notes = p_notes where id = v_existing.id
          returning * into v_existing;
      end if;
      return v_existing;
    end if;
  end if;

  if p_purchased_on is null then
    raise exception 'p_purchased_on is required';
  end if;
  if p_currency is null or p_currency !~ '^[A-Z]{3}$' then
    raise exception 'p_currency must be a 3-letter uppercase ISO 4217 code';
  end if;
  if coalesce(p_shipping_minor, 0) < 0 or coalesce(p_customs_minor, 0) < 0
     or coalesce(p_discount_minor, 0) < 0 then
    raise exception 'shipping, customs and discount must be non-negative';
  end if;

  if p_currency = 'NOK' then
    v_fx_rate := 1;
  else
    if p_fx_rate_to_nok is null or p_fx_rate_to_nok <= 0 then
      raise exception 'a positive p_fx_rate_to_nok is required for a non-NOK purchase';
    end if;
    if p_fx_rate_date is null then
      raise exception 'p_fx_rate_date is required for a non-NOK purchase';
    end if;
    if p_fx_source is null then
      raise exception 'p_fx_source is required for a non-NOK purchase';
    end if;
    v_fx_rate := p_fx_rate_to_nok;
  end if;

  v_line_count := coalesce(jsonb_array_length(p_lines), 0);
  if v_line_count = 0 then
    raise exception 'a purchase requires at least one line';
  end if;

  -- ── Pass 1: validate lines, compute totals, resolve directly-derived spend classes ───────────
  for v_idx in 0 .. v_line_count - 1 loop
    v_line := p_lines -> v_idx;

    v_line_type := (v_line ->> 'line_type')::public.line_type;
    v_quantity := (v_line ->> 'quantity')::int;
    v_unit_price := (v_line ->> 'unit_price_minor')::bigint;

    if v_line_type is null then
      raise exception 'line %: line_type is required', v_idx;
    end if;
    if v_quantity is null or v_quantity <= 0 then
      raise exception 'line %: quantity must be a positive integer', v_idx;
    end if;
    if v_unit_price is null or v_unit_price < 0 then
      raise exception 'line %: unit_price_minor must be a non-negative amount', v_idx;
    end if;

    v_line_total := v_unit_price * v_quantity;
    v_line_totals := v_line_totals || v_line_total;
    v_line_types := v_line_types || v_line_type;
    v_subtotal := v_subtotal + v_line_total;

    v_spend_class_override := v_line ->> 'spend_class';
    if v_spend_class_override is not null then
      v_spend_class := v_spend_class_override::public.spend_class;
    else
      v_spend_class := case v_line_type
        when 'card' then 'collectible'
        when 'sealed' then 'collectible'
        when 'grading_fee' then 'collectible'
        when 'grading_shipping' then 'collectible'
        when 'bulk_lot' then 'collectible'
        when 'accessory' then 'hobby'
        else null
      end;
    end if;
    v_spend_classes := v_spend_classes || v_spend_class;

    if v_spend_class = 'collectible' then
      v_collectible_total := v_collectible_total + v_line_total;
    elsif v_spend_class = 'hobby' then
      v_hobby_total := v_hobby_total + v_line_total;
    end if;

    if v_line_type in ('card', 'sealed') then
      if v_line_type = 'card' then
        v_card_variant_id := nullif(v_line ->> 'card_variant_id', '')::uuid;
        v_manual_card_id := nullif(v_line ->> 'manual_card_id', '')::uuid;
        if (v_card_variant_id is not null) = (v_manual_card_id is not null) then
          raise exception 'line %: exactly one of card_variant_id / manual_card_id is required for a card line', v_idx;
        end if;
      else
        if nullif(v_line ->> 'sealed_product_id', '') is null then
          raise exception 'line %: sealed_product_id is required for a sealed line', v_idx;
        end if;
        if not exists (
          select 1 from public.sealed_products
          where id = (v_line ->> 'sealed_product_id')::uuid
        ) then
          raise exception 'line %: sealed product not found or not accessible', v_idx;
        end if;
      end if;
    else
      if nullif(trim(both from coalesce(v_line ->> 'description', '')), '') is null then
        raise exception 'line %: description is required for a % line', v_idx, v_line_type;
      end if;
    end if;
  end loop;

  -- ── Pass 2: resolve inherited spend classes (dominant class among already-classified lines) ──
  for v_idx in 1 .. v_line_count loop
    if v_spend_classes[v_idx] is null then
      v_spend_classes[v_idx] :=
        case when v_hobby_total > v_collectible_total then 'hobby' else 'collectible' end;
    end if;
  end loop;

  v_total := v_subtotal + coalesce(p_shipping_minor, 0) + coalesce(p_customs_minor, 0)
             - coalesce(p_discount_minor, 0);
  if v_total < 0 then
    raise exception 'discount cannot exceed the purchase subtotal plus shipping and customs';
  end if;
  v_total_nok := public.money_minor_to_nok_minor(v_total, p_currency, v_fx_rate);

  v_alloc_ship := public.allocate_largest_remainder(coalesce(p_shipping_minor, 0), v_line_totals);
  v_alloc_customs := public.allocate_largest_remainder(coalesce(p_customs_minor, 0), v_line_totals);
  -- P144/D-135: the discount is allocated by allocate_purchase_discount (goods first, then the part of
  -- the discount that exceeds the goods against the allocated shipping + customs), not by goods weight
  -- alone, so no line's attributable cost can go negative for a receipt the total check above accepts.
  v_alloc_discount := public.allocate_purchase_discount(
    coalesce(p_discount_minor, 0), v_line_totals, v_alloc_ship, v_alloc_customs
  );

  for v_idx in 1 .. v_line_count loop
    v_attributable := v_attributable ||
      (v_line_totals[v_idx] + v_alloc_ship[v_idx] + v_alloc_customs[v_idx] - v_alloc_discount[v_idx]);
  end loop;

  v_attributable_nok := public.allocate_largest_remainder(v_total_nok, v_attributable);

  -- ── All mutations inside one outer BEGIN/EXCEPTION block ──────────────────────────────────────
  begin
  insert into public.purchases (
    user_id, origin, purchased_on, retailer_id, currency,
    subtotal_minor, shipping_minor, customs_minor, discount_minor, total_minor,
    fx_rate_to_nok, fx_rate_date, fx_source, total_nok_minor, notes,
    idempotency_key, idempotency_request
  ) values (
    v_user_id, 'manual', p_purchased_on, p_retailer_id, p_currency,
    v_subtotal, coalesce(p_shipping_minor, 0), coalesce(p_customs_minor, 0),
    coalesce(p_discount_minor, 0), v_total,
    v_fx_rate, coalesce(p_fx_rate_date, p_purchased_on),
    coalesce(p_fx_source, 'manual'), v_total_nok, p_notes,
    p_idempotency_key, case when p_idempotency_key is not null then v_material end
  )
  returning * into v_purchase;

  -- ── Pass 3: write each line, and — for card/sealed lines — the holding and lot it produces ───
  for v_idx in 0 .. v_line_count - 1 loop
    v_line := p_lines -> v_idx;
    v_line_type := v_line_types[v_idx + 1];
    v_quantity := (v_line ->> 'quantity')::int;
    v_unit_price := (v_line ->> 'unit_price_minor')::bigint;
    v_line_total := v_line_totals[v_idx + 1];
    v_spend_class := v_spend_classes[v_idx + 1];
    v_description := v_line ->> 'description';
    v_condition := nullif(v_line ->> 'condition', '')::public.card_condition;
    v_grading_state := coalesce(nullif(v_line ->> 'grading_state', '')::public.grading_state, 'raw');
    v_grader := nullif(v_line ->> 'grader', '')::public.grader;
    v_grade := nullif(v_line ->> 'grade', '')::numeric(3, 1);
    v_cert_number := v_line ->> 'cert_number';
    v_storage_location_id := nullif(v_line ->> 'storage_location_id', '')::uuid;
    v_is_favorite := coalesce((v_line ->> 'is_favorite')::boolean, false);
    v_lot_notes := v_line ->> 'lot_notes';
    v_manual_value_minor := nullif(v_line ->> 'manual_value_minor', '')::bigint;
    v_card_variant_id := nullif(v_line ->> 'card_variant_id', '')::uuid;
    v_manual_card_id := nullif(v_line ->> 'manual_card_id', '')::uuid;
    v_sealed_product_id := nullif(v_line ->> 'sealed_product_id', '')::uuid;
    v_sealed_intent := coalesce(nullif(v_line ->> 'sealed_intent', '')::public.sealed_intent, 'undecided');

    if v_line_type = 'card' and v_manual_card_id is not null and v_description is null then
      select name into v_manual_name from public.manual_card_definitions where id = v_manual_card_id;
      v_description := v_manual_name;
    end if;

    insert into public.purchase_lines (
      purchase_id, user_id, line_type, spend_class, description,
      card_variant_id, sealed_product_id, condition, quantity, unit_price_minor, line_total_minor,
      allocated_shipping_minor, allocated_customs_minor, allocated_discount_minor,
      attributable_cost_minor, attributable_cost_nok_minor
    ) values (
      v_purchase.id, v_user_id, v_line_type, v_spend_class, v_description,
      case when v_line_type = 'card' then v_card_variant_id end,
      case when v_line_type = 'sealed' then v_sealed_product_id end,
      case when v_line_type = 'card' and v_grading_state = 'raw' then v_condition end,
      v_quantity, v_unit_price, v_line_total,
      v_alloc_ship[v_idx + 1], v_alloc_customs[v_idx + 1], v_alloc_discount[v_idx + 1],
      v_attributable[v_idx + 1], v_attributable_nok[v_idx + 1]
    )
    returning id into v_line_id;

    if v_line_type in ('card', 'sealed') then
      if v_line_type = 'card' then
        v_holding_kind := case v_grading_state when 'graded' then 'graded_card' else 'raw_card' end;
        if v_holding_kind = 'raw_card' and v_condition is null then
          raise exception 'line %: condition is required for a raw card', v_idx;
        end if;
        if v_holding_kind = 'graded_card' and (v_grader is null or v_grade is null) then
          raise exception 'line %: grader and grade are required for a graded card', v_idx;
        end if;
        if v_holding_kind = 'graded_card' then
          v_condition := null;
        end if;
      else
        v_holding_kind := 'sealed';
        v_condition := null;
        v_grading_state := 'raw';
        v_grader := null;
        v_grade := null;
      end if;

      begin
        insert into public.holdings (
          user_id, holding_kind, card_variant_id, manual_card_id, sealed_product_id,
          condition, grading_state, grader, grade, cert_number, is_favorite
        ) values (
          v_user_id, v_holding_kind,
          case when v_line_type = 'card' then v_card_variant_id end,
          case when v_line_type = 'card' then v_manual_card_id end,
          case when v_line_type = 'sealed' then v_sealed_product_id end,
          v_condition, v_grading_state, v_grader, v_grade, v_cert_number,
          v_is_favorite
        )
        returning id into v_holding_id;
      exception when unique_violation then
        select id into v_holding_id
          from public.holdings
          where user_id = v_user_id
            and holding_kind = v_holding_kind
            and coalesce(card_variant_id, sealed_product_id, manual_card_id)
                = coalesce(v_card_variant_id, v_sealed_product_id, v_manual_card_id)
            and coalesce(public.card_condition_to_text(condition), '')
                = coalesce(public.card_condition_to_text(v_condition), '')
            and grading_state = v_grading_state
            and coalesce(public.grader_to_text(grader), '') = coalesce(public.grader_to_text(v_grader), '')
            and coalesce(grade, -1) = coalesce(v_grade, -1)
            and deleted_at is null;
        if v_holding_id is null then
          raise;
        end if;
      end;

      v_unit_cost_basis := v_attributable[v_idx + 1] / v_quantity;
      v_residual := (v_attributable[v_idx + 1] - v_unit_cost_basis * v_quantity)::int;
      v_unit_cost_basis_nok := v_attributable_nok[v_idx + 1] / v_quantity;
      v_residual_nok := v_attributable_nok[v_idx + 1] - v_unit_cost_basis_nok * v_quantity;

      insert into public.acquisition_lots (
        holding_id, user_id, origin, cost_basis_state, purchase_line_id, acquired_on,
        quantity, quantity_remaining, unit_cost_basis_minor, cost_basis_currency,
        unit_cost_basis_nok_minor, residual_minor, residual_nok_minor, storage_location_id, notes,
        sealed_intent
      ) values (
        v_holding_id, v_user_id, 'purchase', 'known', v_line_id, p_purchased_on,
        v_quantity, v_quantity, v_unit_cost_basis, p_currency,
        v_unit_cost_basis_nok, v_residual, v_residual_nok, v_storage_location_id, v_lot_notes,
        case when v_holding_kind = 'sealed' then v_sealed_intent end
      )
      returning id into v_lot_id;

      if v_manual_value_minor is not null then
        if v_holding_kind not in ('graded_card', 'sealed') then
          raise exception 'line %: manual_value_minor is only meaningful for a graded or sealed holding', v_idx;
        end if;
        insert into public.manual_valuations (
          user_id, holding_id, value_minor, currency, value_nok_minor, effective_from
        ) values (
          v_user_id, v_holding_id, v_manual_value_minor, 'NOK', v_manual_value_minor, p_purchased_on
        );
      end if;
    end if;
  end loop;
  exception when unique_violation then
    if p_idempotency_key is null then
      raise;
    end if;
    select * into v_existing from public.purchases
      where user_id = v_user_id and idempotency_key = p_idempotency_key;
    if v_existing.id is null then
      raise;
    end if;
    if v_existing.idempotency_request is distinct from v_material then
      raise exception
        'idempotency-key-reuse: key % already belongs to a different purchase request',
        p_idempotency_key;
    end if;
    -- P111/D-122: same notes-preservation fix as the early-replay branch above, for the
    -- concurrent-race path (loser rolls back, then discovers the winner already committed).
    if v_existing.notes is distinct from p_notes then
      update public.purchases set notes = p_notes where id = v_existing.id
        returning * into v_existing;
    end if;
    v_purchase := v_existing;
  end;

  return v_purchase;
end;
$$;

comment on function public.create_purchase(
  date, text, jsonb, uuid, bigint, bigint, bigint, numeric, date, public.fx_source, text, uuid
) is
  'Atomic multi-line purchase write: one purchase, its lines, allocated shipping/customs/discount, and (for card/sealed lines) the holdings and acquisition lots they produce. Optional p_idempotency_key: a replay with the same (user, key) and the same material request returns the original purchase, updating only p_notes if it differs (D-122) — the financial rows never change on replay. A same-key replay with a materially different request (anything but notes) is refused. M11 (20260829120060) sets sealed_intent on the lot it creates (moved off holdings, 20260829120000) and allows manual_value_minor for a sealed line too. P133 (20260915120000) made the NOK conversion exponent-aware (P130-02). P144 (20260918120000) allocates the discount through allocate_purchase_discount so a discount that also consumes shipping/customs never yields a negative line (P130-16). See FINANCIAL_MODEL.md §4, DATA_MODEL.md §5.3-5.5.';

create or replace function public.update_purchase(
  p_purchase_id uuid,
  p_purchased_on date,
  p_currency text,
  p_lines jsonb,
  p_retailer_id uuid default null,
  p_shipping_minor bigint default 0,
  p_customs_minor bigint default 0,
  p_discount_minor bigint default 0,
  p_fx_rate_to_nok numeric(18, 8) default null,
  p_fx_rate_date date default null,
  p_fx_source public.fx_source default null,
  p_notes text default null
)
returns public.purchases
language plpgsql
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_existing public.purchases;
  v_blocker record;
  v_line jsonb;
  v_line_count int;
  v_idx int;
  v_line_id uuid;
  v_expected_ids uuid[];
  v_given_ids uuid[] := '{}';
  v_line_totals bigint[] := '{}';
  v_subtotal bigint := 0;
  v_total bigint;
  v_total_nok bigint;
  v_fx_rate numeric(18, 8);
  v_alloc_ship bigint[];
  v_alloc_customs bigint[];
  v_alloc_discount bigint[];
  v_attributable bigint[] := '{}';
  v_attributable_nok bigint[];
  v_quantity int;
  v_unit_price bigint;
  v_line_total bigint;
  v_spend_class public.spend_class;
  -- P132-A additions below: lock bookkeeping and per-line sibling-lot handling.
  v_lock_lot_ids uuid[];
  v_lock_lot_id uuid;
  v_sib_ids uuid[];
  v_sib_count int;
  v_sib_qty_sum bigint;
  v_sib_lot public.acquisition_lots;
  v_shares bigint[];
  v_shares_nok bigint[];
  v_share bigint;
  v_share_nok bigint;
  v_unit_cost_basis bigint;
  v_residual int;
  v_unit_cost_basis_nok bigint;
  v_residual_nok bigint;
  v_j int;
  -- P132 integration additions: removed-sibling accounting (D-130).
  v_removed_qty bigint;
  v_current_line_qty int;
  v_all_ids uuid[];
  v_all_qty bigint[];
  v_all_live boolean[];
begin
  if v_user_id is null then
    raise exception 'not authenticated';
  end if;

  select * into v_existing from public.purchases where id = p_purchase_id and user_id = v_user_id;
  if v_existing.id is null then
    raise exception 'purchase % not found', p_purchase_id;
  end if;
  if v_existing.voided_at is not null then
    raise exception 'purchase % is voided and cannot be edited', p_purchase_id;
  end if;

  select array_agg(id order by id) into v_expected_ids
    from public.purchase_lines where purchase_id = p_purchase_id;

  -- LOCK_RULE: every live lot on this purchase, ascending id order, before any validation that
  -- reads lot state and before any write. See migration header.
  select coalesce(array_agg(id order by id), '{}') into v_lock_lot_ids
    from public.acquisition_lots
    where purchase_line_id = any(v_expected_ids) and voided_at is null;

  foreach v_lock_lot_id in array v_lock_lot_ids loop
    perform 1 from public.acquisition_lots where id = v_lock_lot_id for update;
  end loop;

  -- MEMBERSHIP_RULE (P132 integration): the set above was read before any lock was held. A
  -- concurrent void_purchase that committed while this call waited has voided the purchase; a
  -- concurrent set_sealed_lot_intent that committed while this call waited may have added a live
  -- sibling lot that is not locked here. Re-read both now. A lot that has since been voided is
  -- harmless (every later statement sees it voided); a new, unlocked live lot is not, so the call
  -- refuses with a retryable serialization failure instead of editing unlocked inventory.
  if exists (select 1 from public.purchases where id = p_purchase_id and voided_at is not null) then
    raise exception 'purchase % is voided and cannot be edited', p_purchase_id;
  end if;
  if exists (
    select 1 from public.acquisition_lots
    where purchase_line_id = any(v_expected_ids) and voided_at is null
      and id <> all(v_lock_lot_ids)
  ) then
    raise exception using
      errcode = '40001',
      message = format('concurrent-inventory-change: purchase %s gained a lot while this edit was waiting; retry the edit', p_purchase_id);
  end if;

  -- Disposal blocker, re-checked now that every live lot on this purchase is locked (P130-03):
  -- a concurrent create_sale either committed before this point (and is now visible) or is
  -- blocked behind this function's own locks (and will see THIS transaction's outcome once it
  -- proceeds) -- either way this read is no longer racing anything.
  select pl.description, pl.line_type, al.quantity, al.quantity_remaining
    into v_blocker
    from public.purchase_lines pl
    join public.acquisition_lots al on al.purchase_line_id = pl.id
    where pl.purchase_id = p_purchase_id
      and al.voided_at is null
      and al.quantity_remaining <> al.quantity
    limit 1;
  if v_blocker.line_type is not null then
    raise exception 'this purchase cannot be edited: % (%) has already been partially disposed (% of % remaining)',
      coalesce(v_blocker.description, v_blocker.line_type::text), v_blocker.line_type,
      v_blocker.quantity_remaining, v_blocker.quantity;
  end if;

  if p_currency is null or p_currency !~ '^[A-Z]{3}$' then
    raise exception 'p_currency must be a 3-letter uppercase ISO 4217 code';
  end if;
  if coalesce(p_shipping_minor, 0) < 0 or coalesce(p_customs_minor, 0) < 0
     or coalesce(p_discount_minor, 0) < 0 then
    raise exception 'shipping, customs and discount must be non-negative';
  end if;
  if p_currency = 'NOK' then
    v_fx_rate := 1;
  else
    if p_fx_rate_to_nok is null or p_fx_rate_to_nok <= 0 then
      raise exception 'a positive p_fx_rate_to_nok is required for a non-NOK purchase';
    end if;
    if p_fx_rate_date is null or p_fx_source is null then
      raise exception 'p_fx_rate_date and p_fx_source are required for a non-NOK purchase';
    end if;
    v_fx_rate := p_fx_rate_to_nok;
  end if;

  v_line_count := coalesce(jsonb_array_length(p_lines), 0);
  if v_line_count = 0 then
    raise exception 'a purchase requires at least one line';
  end if;

  for v_idx in 0 .. v_line_count - 1 loop
    v_line := p_lines -> v_idx;
    v_line_id := nullif(v_line ->> 'line_id', '')::uuid;
    if v_line_id is null then
      raise exception 'line %: line_id is required for an edit — lines cannot be added via update_purchase', v_idx;
    end if;
    v_given_ids := v_given_ids || v_line_id;

    v_quantity := (v_line ->> 'quantity')::int;
    v_unit_price := (v_line ->> 'unit_price_minor')::bigint;
    if v_quantity is null or v_quantity <= 0 then
      raise exception 'line %: quantity must be a positive integer', v_idx;
    end if;
    if v_unit_price is null or v_unit_price < 0 then
      raise exception 'line %: unit_price_minor must be a non-negative amount', v_idx;
    end if;

    v_line_total := v_unit_price * v_quantity;
    v_line_totals := v_line_totals || v_line_total;
    v_subtotal := v_subtotal + v_line_total;
  end loop;

  if v_expected_ids is null or array_length(v_expected_ids, 1) <> v_line_count
     or (select array_agg(x order by x) from unnest(v_given_ids) x) <> v_expected_ids then
    raise exception 'update_purchase cannot add or remove lines — void this purchase and create a new one instead';
  end if;

  -- QUANTITY_CHANGE_RULE: validate every line's sibling-lot quantity change BEFORE any write
  -- (same validate-then-write discipline as reduce_holding_quantity, P28's pass 3/4). See
  -- migration header for the full rule.
  for v_idx in 0 .. v_line_count - 1 loop
    v_line := p_lines -> v_idx;
    v_line_id := (v_line ->> 'line_id')::uuid;
    v_quantity := (v_line ->> 'quantity')::int;

    select count(*) filter (where voided_at is null),
           coalesce(sum(quantity) filter (where voided_at is null), 0),
           coalesce(sum(quantity) filter (where voided_at is not null), 0)
      into v_sib_count, v_sib_qty_sum, v_removed_qty
      from public.acquisition_lots
      where purchase_line_id = v_line_id;
    select quantity into v_current_line_qty from public.purchase_lines where id = v_line_id;

    if v_sib_count = 0 then
      -- ZERO_LIVE_LOT_RULE (D-130, P132 X-4): every lot of this line was removed from inventory.
      -- Changing the line's quantity now would record units that are neither inventory nor a
      -- recorded removal; nothing can be resurrected or fabricated to back them.
      if v_quantity <> v_current_line_qty then
        raise exception 'purchase-line-quantity-without-inventory: purchase line % has no live lot (all % unit(s) were removed from inventory); its quantity cannot be changed to %. Leave the quantity at % while editing other fields, or void this purchase and record a new one.',
          v_line_id, v_current_line_qty, v_quantity, v_current_line_qty;
      end if;
    elsif v_sib_count > 1 or v_removed_qty > 0 then
      -- QUANTITY_CHANGE_RULE (D-129), extended by D-130 to a line that still has live lots but
      -- also has removed (voided) sibling lots: the line quantity is the live units plus the
      -- removed units, and nothing in the request says which pile a change belongs to.
      if v_quantity <> v_sib_qty_sum + v_removed_qty then
        raise exception 'multi-lot-quantity-ambiguous: purchase line % has % live lot(s) totalling % units and % removed unit(s); changing its quantity to % is refused because it is ambiguous which lot would gain or lose units. Void this purchase and record a new one instead, or leave this line''s quantity at % while editing other fields.',
          v_line_id, v_sib_count, v_sib_qty_sum, v_removed_qty, v_quantity, v_sib_qty_sum + v_removed_qty;
      end if;
    end if;
  end loop;

  v_total := v_subtotal + coalesce(p_shipping_minor, 0) + coalesce(p_customs_minor, 0)
             - coalesce(p_discount_minor, 0);
  if v_total < 0 then
    raise exception 'discount cannot exceed the purchase subtotal plus shipping and customs';
  end if;
  v_total_nok := public.money_minor_to_nok_minor(v_total, p_currency, v_fx_rate);

  v_alloc_ship := public.allocate_largest_remainder(coalesce(p_shipping_minor, 0), v_line_totals);
  v_alloc_customs := public.allocate_largest_remainder(coalesce(p_customs_minor, 0), v_line_totals);
  -- P144/D-135: the discount is allocated by allocate_purchase_discount (goods first, then the part of
  -- the discount that exceeds the goods against the allocated shipping + customs), not by goods weight
  -- alone, so no line's attributable cost can go negative for a receipt the total check above accepts.
  v_alloc_discount := public.allocate_purchase_discount(
    coalesce(p_discount_minor, 0), v_line_totals, v_alloc_ship, v_alloc_customs
  );
  for v_idx in 1 .. v_line_count loop
    v_attributable := v_attributable ||
      (v_line_totals[v_idx] + v_alloc_ship[v_idx] + v_alloc_customs[v_idx] - v_alloc_discount[v_idx]);
  end loop;
  v_attributable_nok := public.allocate_largest_remainder(v_total_nok, v_attributable);

  update public.purchases set
    purchased_on = p_purchased_on,
    retailer_id = p_retailer_id,
    currency = p_currency,
    subtotal_minor = v_subtotal,
    shipping_minor = coalesce(p_shipping_minor, 0),
    customs_minor = coalesce(p_customs_minor, 0),
    discount_minor = coalesce(p_discount_minor, 0),
    total_minor = v_total,
    fx_rate_to_nok = v_fx_rate,
    fx_rate_date = coalesce(p_fx_rate_date, p_purchased_on),
    fx_source = coalesce(p_fx_source, 'manual'),
    total_nok_minor = v_total_nok,
    notes = p_notes
  where id = p_purchase_id;

  for v_idx in 0 .. v_line_count - 1 loop
    v_line := p_lines -> v_idx;
    v_line_id := (v_line ->> 'line_id')::uuid;
    v_quantity := (v_line ->> 'quantity')::int;
    v_unit_price := (v_line ->> 'unit_price_minor')::bigint;
    v_spend_class := nullif(v_line ->> 'spend_class', '')::public.spend_class;

    update public.purchase_lines set
      quantity = v_quantity,
      unit_price_minor = v_unit_price,
      line_total_minor = v_line_totals[v_idx + 1],
      spend_class = coalesce(v_spend_class, spend_class),
      description = coalesce(v_line ->> 'description', description),
      allocated_shipping_minor = v_alloc_ship[v_idx + 1],
      allocated_customs_minor = v_alloc_customs[v_idx + 1],
      allocated_discount_minor = v_alloc_discount[v_idx + 1],
      attributable_cost_minor = v_attributable[v_idx + 1],
      attributable_cost_nok_minor = v_attributable_nok[v_idx + 1]
    where id = v_line_id;

    -- MULTILOT_RULE: handle every live sibling lot of this line, not one arbitrary row (P130-01).
    -- Every per-line array is read HERE, for THIS line: nothing computed for another line in an
    -- earlier loop is reused (an integration-time defect reused the validation loop's last
    -- sibling-quantity array and mis-allocated any split line that was not the last line).
    select coalesce(array_agg(id order by id), '{}'),
           coalesce(array_agg(quantity::bigint order by id), '{}'),
           coalesce(array_agg(voided_at is null order by id), '{}')
      into v_all_ids, v_all_qty, v_all_live
      from public.acquisition_lots
      where purchase_line_id = v_line_id;
    select coalesce(array_agg(id order by id), '{}') into v_sib_ids
      from public.acquisition_lots
      where purchase_line_id = v_line_id and voided_at is null;
    v_sib_count := coalesce(array_length(v_sib_ids, 1), 0);
    v_removed_qty := 0;
    for v_j in 1 .. coalesce(array_length(v_all_ids, 1), 0) loop
      if not v_all_live[v_j] then
        v_removed_qty := v_removed_qty + v_all_qty[v_j];
      end if;
    end loop;

    if v_sib_count = 1 and v_removed_qty = 0 then
      -- The common case, unchanged in shape from the pre-P132-A code: one lot, the whole line's
      -- attributable cost, quantity free to change (already proven unambiguous above — a single
      -- lot has no sibling to conflict with).
      select * into v_sib_lot from public.acquisition_lots where id = v_sib_ids[1];
      if v_sib_lot.cost_basis_state = 'known' then
        v_unit_cost_basis := v_attributable[v_idx + 1] / v_quantity;
        v_residual := (v_attributable[v_idx + 1] - v_unit_cost_basis * v_quantity)::int;
        v_unit_cost_basis_nok := v_attributable_nok[v_idx + 1] / v_quantity;
        v_residual_nok := v_attributable_nok[v_idx + 1] - v_unit_cost_basis_nok * v_quantity;
        update public.acquisition_lots set
          acquired_on = p_purchased_on,
          quantity = v_quantity,
          quantity_remaining = v_quantity,
          unit_cost_basis_minor = v_unit_cost_basis,
          cost_basis_currency = p_currency,
          unit_cost_basis_nok_minor = v_unit_cost_basis_nok,
          residual_minor = v_residual,
          residual_nok_minor = v_residual_nok
        where id = v_sib_lot.id;
      else
        -- Never fabricate a number where there isn't a known one (FINANCIAL_MODEL.md §1.1): only
        -- what this edit can honestly know about the lot (its date, quantity) moves.
        update public.acquisition_lots set
          acquired_on = p_purchased_on,
          quantity = v_quantity,
          quantity_remaining = v_quantity
        where id = v_sib_lot.id;
      end if;

    elsif v_sib_count >= 1 then
      -- Split siblings and/or removed siblings. QUANTITY_CHANGE_RULE already proved v_quantity
      -- equals live units + removed units, so every live sibling's own quantity/quantity_remaining
      -- stays exactly as it is (D1 untouched, sealed_intent untouched, purchase_line_id untouched,
      -- removed units never resurrected -- D-130) -- only the line's attributable cost is
      -- redistributed. The allocation is weighted over EVERY lot of the line, live and removed,
      -- so each unit of the receipt line carries the same cost; only live lots are written. With
      -- no removed lot this is exactly D-129's live-sibling allocation.
      if exists (
        select 1 from public.acquisition_lots where id = any(v_sib_ids) and cost_basis_state <> 'known'
      ) then
        if exists (
          select 1 from public.acquisition_lots where id = any(v_sib_ids) and cost_basis_state = 'known'
        ) then
          -- Unreachable through any code path in this product today (see migration header) —
          -- asserted so a future change that breaks the invariant fails loudly here.
          raise exception 'purchase line %: split lots disagree on cost_basis_state, which should never happen for a purchase-linked lot', v_line_id;
        end if;
        update public.acquisition_lots set acquired_on = p_purchased_on where id = any(v_sib_ids);
      else
        v_shares := public.allocate_largest_remainder(v_attributable[v_idx + 1], v_all_qty);
        v_shares_nok := public.allocate_largest_remainder(v_attributable_nok[v_idx + 1], v_all_qty);

        for v_j in 1 .. array_length(v_all_ids, 1) loop
          continue when not v_all_live[v_j];
          v_share := v_shares[v_j];
          v_share_nok := v_shares_nok[v_j];
          v_unit_cost_basis := v_share / v_all_qty[v_j];
          v_residual := (v_share - v_unit_cost_basis * v_all_qty[v_j])::int;
          v_unit_cost_basis_nok := v_share_nok / v_all_qty[v_j];
          v_residual_nok := v_share_nok - v_unit_cost_basis_nok * v_all_qty[v_j];
          update public.acquisition_lots set
            acquired_on = p_purchased_on,
            unit_cost_basis_minor = v_unit_cost_basis,
            cost_basis_currency = p_currency,
            unit_cost_basis_nok_minor = v_unit_cost_basis_nok,
            residual_minor = v_residual,
            residual_nok_minor = v_residual_nok
          where id = v_all_ids[v_j];
        end loop;
      end if;
    end if;
    -- v_sib_count = 0: no live lot for this line (every lot was removed while another,
    -- unaccounted-for line kept the purchase itself live — D-051); nothing to update on any lot.
    -- ZERO_LIVE_LOT_RULE above has already refused a quantity change for such a line (D-130).
  end loop;

  select * into v_existing from public.purchases where id = p_purchase_id;
  return v_existing;
end;
$$;

comment on function public.update_purchase(
  uuid, date, text, jsonb, uuid, bigint, bigint, bigint, numeric, date, public.fx_source, text
) is
  'Recomputes a purchase''s allocations and every existing line''s attributable cost/cost basis atomically. Cannot add or remove lines. Locks every live lot on the purchase (ascending id order) before validating or writing, refuses if any is partially disposed elsewhere. A line with more than one live sibling lot (a sealed-intent split) preserves each sibling''s quantity and redistributes the line''s attributable cost across them exactly; changing such a line''s quantity is refused as ambiguous, as is changing the quantity of a line with removed sibling lots or with no live lot at all (removed units are never resurrected, D-130). P132 (20260914120000) fixed P130-01 (multi-lot fabrication) and this function''s P130-03 slice (unlocked disposal check) together; P133 (20260915120000) made the NOK conversion exponent-aware (P130-02); P144 (20260918120000) allocates the discount through allocate_purchase_discount (P130-16).';


-- ── 2. P130-17 — net proceeds sign never decides whether a sale is representable ─────────────────
-- THE BUG. sales.proceeds_from_uncosted_nok_minor (PUD, FINANCIAL_MODEL.md §2.6) is the sum of
-- net_proceeds_nok_minor over the sale's lines whose lot has NO known cost basis. Net proceeds are
-- a cash flow and are deliberately not clamped at zero (FINANCIAL_MODEL.md §2.2, and the
-- sales_net_proceeds_formula/sale_lines columns carry no sign check): fees and outbound shipping
-- can exceed the gross. But sales_amounts_non_negative also constrained PUD >= 0, so a sale whose
-- uncosted lines net to a NEGATIVE amount (gross 50, fees + shipping 80 -> -30) failed with a raw
-- 23514 check violation, while the identical sale on a lot with a KNOWN basis (PUD = 0, realized
-- result = net - basis) was accepted. Whether a real transaction could be recorded depended on
-- whether an unrelated fact, the cost basis, was known. Reproduced on the pre-P144 schema.
--
-- THE FIX. Drop the PUD >= 0 clause; keep the four component amounts non-negative (gross, fees,
-- shipping cost, shipping charged are individually non-negative — that part of the contract is
-- untouched). PUD is a signed net cash flow. Nothing else changes: create_sale/update_sale already
-- compute v_uncosted_sum as a plain signed sum, sale_lines.net_proceeds_nok_minor has never had a
-- sign check, an unknown basis still freezes cost_basis_at_sale/realized_result as NULL (never a
-- fabricated 0 — sale_lines_realized_result_consistency is untouched), and invariant F5 (RRC + PUD =
-- NSP - sum(cost basis)) holds for a negative PUD exactly as for a positive one. sales_summary
-- already sums line values without a sign assumption.
alter table public.sales
  drop constraint sales_amounts_non_negative,
  add constraint sales_amounts_non_negative check (
    gross_minor >= 0 and fees_minor >= 0 and shipping_cost_minor >= 0 and shipping_charged_minor >= 0
  );

comment on constraint sales_amounts_non_negative on public.sales is
  'gross/fees/shipping_cost/shipping_charged are individually non-negative. proceeds_from_uncosted_nok_minor (PUD) is deliberately NOT constrained: it is a signed net cash flow that is negative when fees and shipping on an uncosted line exceed its gross (P130-17/P144, D-135).';

-- ── 3. P130-18 (date dimension) — completed-event date contract ──────────────────────────────────
-- THE BUG. No table or RPC checked any user-supplied event date beyond NOT NULL: 0001-01-01,
-- 9999-12-31 and 2099-01-01 were accepted for a purchase, sale or acquisition (P130 T8). The
-- ownership timeline (FINANCIAL_MODEL.md §3) and every dated history chart read these columns, so
-- a sentinel date silently corrupts "what did the user own on day D" and the dashboard history.
--
-- THE CONTRACT (completed-event dates only):
--   lower bound  1996-10-20 — the release date of the first Pokemon Trading Card Game product
--                (Base Set, Japan). No purchase, sale, acquisition, opening or cost adjustment of a
--                Pokemon card, sealed product or accessory can predate the product; this is the
--                domain's own earliest possible date, not an arbitrary round number. PRODUCT_SPEC.md
--                §4.5 / UX_FLOWS.md ("dates allow any past date") keep their meaning: every real
--                past date remains valid, including backdated and pre-tracking acquisitions.
--   upper bound  (current UTC date) + 1 day — the latest calendar date that exists anywhere on
--                Earth right now (UTC+14). The server does not know the user's timezone, so it
--                accepts "today" in every timezone and refuses only dates no person could be
--                living in yet. The released forms are stricter (max = the user's local today) and
--                keep their own, tighter check; this is the authoritative floor beneath them.
--   date-only    the check compares calendar dates. It never converts through a timestamp, so no
--                UTC-midnight shift can move a date across a day boundary.
--   NULL         never fabricated as a placeholder date; these columns stay NOT NULL.
--
-- WHICH DATES. Only the user-supplied dates of completed ledger events: purchases.purchased_on,
-- sales.sold_on, acquisition_lots.acquired_on, lot_disposals.disposed_on, openings.opened_on and
-- lot_cost_adjustments.occurred_on. NOT covered, by design: created_at/updated_at/voided_at (system
-- audit timestamps), fx_rate_date on purchases/sales and fx_rates.rate_date (the observation date of
-- a rate, which legitimately precedes the event), price_snapshots.snapshot_date and
-- portfolio_snapshots.snapshot_date (provider/system observation dates), card_sets.released_on
-- (catalog data) and manual_valuations.effective_from (a valuation observation, not a completed
-- ledger event; a future effective date is simply not effective yet).
--
-- HOW. One BEFORE trigger function shared by six tables (not CHECK constraints), for three reasons:
-- the error is a named domain error ("invalid-event-date: ...", SQLSTATE 22008), never a raw
-- 23514 constraint name; it covers every writer at once — the RPCs, the released client's direct
-- column update of acquisition_lots.acquired_on (updateLotAcquiredOn) and service-role writes —
-- without restating a dozen RPC bodies; and it validates only when the date column is inserted or
-- actually CHANGED, so an existing row that predates the contract (there are none on the hosted
-- database, checked read-only before this migration) is never made un-updatable by an unrelated edit.
create or replace function public.enforce_completed_event_date()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_column text := tg_argv[0];
  v_min constant date := date '1996-10-20';
  v_max date := (now() at time zone 'UTC')::date + 1;
  v_new date := (to_jsonb(new) ->> v_column)::date;
  v_old date;
begin
  if tg_op = 'UPDATE' then
    v_old := (to_jsonb(old) ->> v_column)::date;
    if v_new is not distinct from v_old then
      return new;
    end if;
  end if;
  if v_new < v_min or v_new > v_max then
    raise exception using
      errcode = '22008',
      message = format(
        'invalid-event-date: %s.%s %s is outside the supported range %s to %s',
        tg_table_name, v_column, v_new, v_min, v_max
      ),
      hint = 'A completed purchase, sale, acquisition or opening must be dated between the first Pokemon TCG release (1996-10-20) and tomorrow (UTC).';
  end if;
  return new;
end;
$$;

revoke execute on function public.enforce_completed_event_date() from public, anon, authenticated;

comment on function public.enforce_completed_event_date() is
  'Completed-event date contract (P130-18/P144, D-135): 1996-10-20 <= date <= (UTC today) + 1. Trigger function; argument 0 names the date column. Validates on INSERT and on UPDATE only when the column value changes.';

create trigger purchases_event_date_contract
  before insert or update of purchased_on on public.purchases
  for each row execute function public.enforce_completed_event_date('purchased_on');

create trigger sales_event_date_contract
  before insert or update of sold_on on public.sales
  for each row execute function public.enforce_completed_event_date('sold_on');

create trigger acquisition_lots_event_date_contract
  before insert or update of acquired_on on public.acquisition_lots
  for each row execute function public.enforce_completed_event_date('acquired_on');

create trigger lot_disposals_event_date_contract
  before insert or update of disposed_on on public.lot_disposals
  for each row execute function public.enforce_completed_event_date('disposed_on');

create trigger openings_event_date_contract
  before insert or update of opened_on on public.openings
  for each row execute function public.enforce_completed_event_date('opened_on');

create trigger lot_cost_adjustments_event_date_contract
  before insert or update of occurred_on on public.lot_cost_adjustments
  for each row execute function public.enforce_completed_event_date('occurred_on');
