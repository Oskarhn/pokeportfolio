-- P111 (docs/DECISIONS.md D-122): corrects create_purchase's idempotent-replay handling of
-- p_notes. P108's original design (20260905120010, docs/DECISIONS.md D-121) excluded p_notes from
-- the idempotency material-equivalence check and called it "cosmetic annotation" / "operational
-- metadata" — but notes are USER-VISIBLE content the caller typed, not operational plumbing like
-- the idempotency key itself. Under P108's original body, a legitimate replay (dropped response,
-- user edits the notes field, then resubmits with the SAME idempotency key because the key is
-- never regenerated merely because an error was shown) would return the ORIGINAL row untouched —
-- silently discarding the user's edited notes with no error and no indication anything was lost.
-- That is a real violation of CLAUDE.md's "Honesty in the product" bar (no silent loss of what the
-- user entered), not merely a missing nice-to-have.
--
-- FIX (this migration): notes remain excluded from the material-equivalence comparison (a
-- notes-only edit still counts as the same logical purchase attempt and must still replay, not be
-- refused as `idempotency-key-reuse`), but a legitimate replay now writes the CALLER'S latest
-- p_notes onto the existing row before returning it, whenever it differs from what is stored.
-- Notes are treated as separately mutable metadata attached to an idempotent financial write, not
-- as immutable history — the financial rows (purchase totals, lines, holdings, lots) are still
-- returned completely unchanged by a replay; only the free-text annotation can move.
--
-- SCOPE: this migration corrects `p_notes` (purchase-level) only. Each line's `lot_notes` remains
-- excluded from BOTH the equivalence check and the update-on-replay behaviour — matching a
-- specific line's lot_notes back to its already-written acquisition_lot on a replay path that
-- never re-runs the per-line insert loop would need a stable line-ordering guarantee this schema
-- does not currently provide (purchase_lines carries no explicit sequence column), and building
-- one is out of scope for this specific correction (CLAUDE.md: smallest complete solution). Any
-- report of a real product need to edit lot_notes across a purchase retry belongs in
-- docs/BACKLOG.md, not solved speculatively here.
--
-- Same 12-parameter signature as 20260905120010 — CREATE OR REPLACE is valid (function identity is
-- unchanged, only the body's two replay branches gain one conditional UPDATE each).

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
  v_total_nok := round(v_total::numeric * v_fx_rate)::bigint;

  v_alloc_ship := public.allocate_largest_remainder(coalesce(p_shipping_minor, 0), v_line_totals);
  v_alloc_customs := public.allocate_largest_remainder(coalesce(p_customs_minor, 0), v_line_totals);
  v_alloc_discount := public.allocate_largest_remainder(coalesce(p_discount_minor, 0), v_line_totals);

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
  'Atomic multi-line purchase write: one purchase, its lines, allocated shipping/customs/discount, and (for card/sealed lines) the holdings and acquisition lots they produce. Optional p_idempotency_key: a replay with the same (user, key) and the same material request returns the original purchase, updating only p_notes if it differs (D-122) — the financial rows never change on replay. A same-key replay with a materially different request (anything but notes) is refused. M11 (20260829120060) sets sealed_intent on the lot it creates (moved off holdings, 20260829120000) and allows manual_value_minor for a sealed line too. See FINANCIAL_MODEL.md §4, DATA_MODEL.md §5.3-5.5.';
