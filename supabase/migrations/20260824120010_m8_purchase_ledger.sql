-- M8: the multi-line purchase ledger (DATA_MODEL.md §5.3, FINANCIAL_MODEL.md §1-4/§7).
--
-- Extends the existing purchases/purchase_lines tables M3 created and M6's single-line
-- add_card_acquisition already writes into — this migration does not introduce a second kind of
-- purchase. It adds: two CHECK constraints stating invariants the RPC layer already had to keep
-- (so a future write path cannot silently violate them), a SQL port of the M2 TypeScript
-- largest-remainder allocator (src/domain/allocation.ts) so persisted allocations are provably
-- driven by the same algorithm as the client-side live preview, the three purchase-ledger RPCs
-- (create_purchase / update_purchase / void_purchase), a cheap spending-summary aggregate RPC, and
-- a correction to void_acquisition_lot's auto-void-parent-purchase logic (see §3 below).

-- ── 1. Two invariants the RPC layer must keep, now asserted at the database boundary too ───────
-- Both already held for every row M6's add_card_acquisition ever wrote (a single line, no
-- shipping/customs/discount, so both sides of each equation were trivially equal) — these
-- constraints therefore validate cleanly against any existing data, including real purchases on
-- the deployed project.

alter table public.purchases
  add constraint purchases_total_nok_matches_rate check (
    total_nok_minor = round(total_minor::numeric * fx_rate_to_nok)::bigint
  );

alter table public.purchase_lines
  add constraint purchase_lines_attributable_cost_matches_allocation check (
    attributable_cost_minor
      = line_total_minor + allocated_shipping_minor + allocated_customs_minor - allocated_discount_minor
  );

-- ── 2. The largest-remainder allocator, ported from src/domain/allocation.ts ─────────────────────
-- Same algorithm, same tie-break (highest fractional remainder first, ties broken by lowest
-- array index — deterministic regardless of input order or runtime), same zero-weight edge case
-- (every weight zero → distribute equally, FINANCIAL_MODEL.md §4.1's "shipping-only purchase"
-- case). tests/db/m8_purchase_ledger.test.ts asserts this function and the TypeScript one produce
-- byte-identical output across a shared corpus of cases (§91's "database parity with domain
-- engine" requirement) — two independent implementations of the same rule, not one shared library,
-- because the browser and Postgres cannot literally share code and the whole point of freezing an
-- allocation at write time is that it does not depend on which side computed it.
create or replace function public.allocate_largest_remainder(p_total bigint, p_weights bigint[])
returns bigint[]
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_n int := coalesce(array_length(p_weights, 1), 0);
  v_sum_weights bigint := 0;
  v_effective bigint[];
  v_effective_sum bigint;
  v_floors bigint[] := '{}';
  v_remainders bigint[] := '{}';
  v_sum_floors bigint := 0;
  v_remaining bigint;
  v_shares bigint[];
  v_order int[];
  i int;
begin
  if v_n = 0 then
    raise exception 'allocate_largest_remainder: weights must be non-empty';
  end if;
  if p_total < 0 then
    raise exception 'allocate_largest_remainder: total must be non-negative';
  end if;

  for i in 1..v_n loop
    if p_weights[i] < 0 then
      raise exception 'allocate_largest_remainder: weights must be non-negative';
    end if;
    v_sum_weights := v_sum_weights + p_weights[i];
  end loop;

  if v_sum_weights = 0 then
    select array_agg(1::bigint) into v_effective from generate_series(1, v_n);
    v_effective_sum := v_n;
  else
    v_effective := p_weights;
    v_effective_sum := v_sum_weights;
  end if;

  for i in 1..v_n loop
    v_floors := v_floors || ((p_total * v_effective[i]) / v_effective_sum);
    v_remainders := v_remainders || ((p_total * v_effective[i]) % v_effective_sum);
    v_sum_floors := v_sum_floors + v_floors[i];
  end loop;

  v_remaining := p_total - v_sum_floors;
  v_shares := v_floors;

  -- Indices ordered by remainder desc, ties by index asc — array_agg over a set-returning
  -- subquery preserves the ORDER BY, which is guaranteed for a single, un-nested array_agg.
  select array_agg(idx order by rem desc, idx asc)
    into v_order
    from unnest(v_remainders) with ordinality as t(rem, idx);

  for i in 1..v_remaining loop
    v_shares[v_order[i]] := v_shares[v_order[i]] + 1;
  end loop;

  return v_shares;
end;
$$;

revoke execute on function public.allocate_largest_remainder(bigint, bigint[]) from public;
grant execute on function public.allocate_largest_remainder(bigint, bigint[]) to authenticated;

-- ── 3. Fixing void_acquisition_lot's auto-void-parent-purchase scope ────────────────────────────
-- M6's version only checked for other live lots citing the *same purchase line*, which is correct
-- exactly as long as every purchase has one line — true until this migration. A multi-line M8
-- purchase would otherwise have its ENTIRE receipt voided (including unrelated lines' spend) the
-- moment the last lot from any *one* of its lines was individually voided. The corrected version
-- checks for other live lots anywhere in the whole parent purchase before auto-voiding it, which
-- is a strict generalization: for a single-line purchase (M6's shape) the two checks agree exactly,
-- so this is a correction, not a behaviour change, for every purchase that exists today
-- (SECURITY.md §12 checklist / prompt §62's "do not maintain two functions that can produce
-- different financial states").
create or replace function public.void_acquisition_lot(p_lot_id uuid, p_reason text default null)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_lot public.acquisition_lots;
  v_purchase_id uuid;
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
    select purchase_id into v_purchase_id
      from public.purchase_lines where id = v_lot.purchase_line_id;

    select count(*) into v_other_live_lots
      from public.acquisition_lots al
      join public.purchase_lines pl on pl.id = al.purchase_line_id
      where pl.purchase_id = v_purchase_id
        and al.id <> p_lot_id
        and al.voided_at is null;

    if v_other_live_lots = 0 then
      update public.purchases
        set voided_at = now()
        where id = v_purchase_id and voided_at is null;
    end if;
  end if;
end;
$$;

-- ── 4. create_purchase ───────────────────────────────────────────────────────────────────────
-- SECURITY INVOKER, same reasoning as add_card_acquisition (20260821120050): authenticated already
-- holds INSERT on every table this touches, RLS stays active for every statement exactly as if the
-- caller had issued it directly, and ownership derives from auth.uid() alone — no user id argument
-- exists to forge. One function call is one transaction: a raised exception (invalid line, negative
-- discount, a manual card belonging to someone else) rolls back the purchase, every line and every
-- lot it would otherwise have written, so a purchase can never be observed half-saved.
--
-- p_lines is a JSON array of line objects (see docs/DATA_MODEL.md §5.3 / this file's own field
-- list below). Every allocation (shipping, customs, discount, and the NOK conversion of each
-- line's attributable cost) is computed with allocate_largest_remainder above — never independent
-- per-line rounding, which is what keeps invariant F1 (GPO = CS + HS) exact even for a
-- foreign-currency purchase, where naively rounding each line's NOK amount on its own can drift a
-- few øre from a single rounding of the purchase total.
--
-- Scope cut, deliberate (prompt §11/§54): a purchase line of type 'card' or 'sealed' always
-- creates exactly one holding and one acquisition lot when it has a catalog/manual reference — it
-- does not offer an optional "skip creating inventory" checkbox. A user who genuinely does not want
-- individual inventory yet has 'bulk_lot' for exactly that (§24) rather than a 'card' line in a
-- state that counts as collectible spend with no corresponding holding.
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
  p_notes text default null
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
begin
  if v_user_id is null then
    raise exception 'not authenticated';
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
        else null -- shipping_standalone / customs_standalone / other: resolved in pass 2
      end;
    end if;
    v_spend_classes := v_spend_classes || v_spend_class; -- may append NULL, filled in below

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

  -- The purchase's frozen NOK total, allocated across lines by the same largest-remainder method
  -- (weighted by each line's original-currency attributable cost) rather than rounding each line's
  -- NOK amount independently — see the migration header. Sums to v_total_nok exactly.
  v_attributable_nok := public.allocate_largest_remainder(v_total_nok, v_attributable);

  insert into public.purchases (
    user_id, origin, purchased_on, retailer_id, currency,
    subtotal_minor, shipping_minor, customs_minor, discount_minor, total_minor,
    fx_rate_to_nok, fx_rate_date, fx_source, total_nok_minor, notes
  ) values (
    v_user_id, 'manual', p_purchased_on, p_retailer_id, p_currency,
    v_subtotal, coalesce(p_shipping_minor, 0), coalesce(p_customs_minor, 0),
    coalesce(p_discount_minor, 0), v_total,
    v_fx_rate, coalesce(p_fx_rate_date, p_purchased_on),
    coalesce(p_fx_source, 'manual'), v_total_nok, p_notes
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
          condition, grading_state, grader, grade, cert_number,
          sealed_intent, is_favorite
        ) values (
          v_user_id, v_holding_kind,
          case when v_line_type = 'card' then v_card_variant_id end,
          case when v_line_type = 'card' then v_manual_card_id end,
          case when v_line_type = 'sealed' then v_sealed_product_id end,
          v_condition, v_grading_state, v_grader, v_grade, v_cert_number,
          case when v_holding_kind = 'sealed' then 'undecided'::public.sealed_intent end,
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

      insert into public.acquisition_lots (
        holding_id, user_id, origin, cost_basis_state, purchase_line_id, acquired_on,
        quantity, quantity_remaining, unit_cost_basis_minor, cost_basis_currency,
        unit_cost_basis_nok_minor, residual_minor, storage_location_id, notes
      ) values (
        v_holding_id, v_user_id, 'purchase', 'known', v_line_id, p_purchased_on,
        v_quantity, v_quantity, v_unit_cost_basis, p_currency,
        v_unit_cost_basis_nok, v_residual, v_storage_location_id, v_lot_notes
      )
      returning id into v_lot_id;

      if v_manual_value_minor is not null then
        if v_holding_kind <> 'graded_card' then
          raise exception 'line %: manual_value_minor is only meaningful for a graded card', v_idx;
        end if;
        insert into public.manual_valuations (
          user_id, holding_id, value_minor, currency, value_nok_minor, effective_from
        ) values (
          v_user_id, v_holding_id, v_manual_value_minor, 'NOK', v_manual_value_minor, p_purchased_on
        );
      end if;
    end if;
  end loop;

  return v_purchase;
end;
$$;

comment on function public.create_purchase(
  date, text, jsonb, uuid, bigint, bigint, bigint, numeric, date, public.fx_source, text
) is
  'Atomic multi-line purchase write: one purchase, its lines, allocated shipping/customs/discount, and (for card/sealed lines) the holdings and acquisition lots they produce. See FINANCIAL_MODEL.md §4, DATA_MODEL.md §5.3-5.5.';

-- ── 5. update_purchase — the safe-edit path ─────────────────────────────────────────────────────
-- Scope, deliberate (docs/HANDOVER.md / this milestone's known limitations): an edit can change
-- purchase-level fields (date, retailer, currency, FX, shipping/customs/discount, notes) and the
-- quantity / unit price / spend class / description of an EXISTING line, recomputing every
-- allocation and — for a line with an open lot — that lot's cost basis, atomically. It cannot add
-- or remove a line, because acquisition_lots.purchase_line_id is a real foreign key with no cascade
-- (deleting a line with a lot still attached would either orphan the lot or require deleting real
-- inventory history as a side effect of an amount correction). A purchase entered with the wrong
-- set of lines is corrected by voiding it and creating a new one — the same guidance
-- UX_FLOWS.md's "Purchase entered twice" case already gives for a bigger mistake.
--
-- Blocked (named, structured error) when any lot produced by this purchase has already been
-- partially or fully disposed elsewhere (quantity_remaining <> quantity) — see the migration
-- header for why this is not yet exercisable through any real product flow (no disposal-producing
-- milestone — sales M10, openings M16, grading M17, trades M18 — has shipped) and is still
-- implemented now so those milestones do not have to touch this function later.
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
  v_lot public.acquisition_lots;
  v_unit_cost_basis bigint;
  v_residual int;
  v_unit_cost_basis_nok bigint;
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

  select array_agg(id order by id) into v_expected_ids
    from public.purchase_lines where purchase_id = p_purchase_id;

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

    select * into v_lot from public.acquisition_lots
      where purchase_line_id = v_line_id and voided_at is null;
    if v_lot.id is not null then
      v_unit_cost_basis := v_attributable[v_idx + 1] / v_quantity;
      v_residual := (v_attributable[v_idx + 1] - v_unit_cost_basis * v_quantity)::int;
      v_unit_cost_basis_nok := v_attributable_nok[v_idx + 1] / v_quantity;
      update public.acquisition_lots set
        acquired_on = p_purchased_on,
        quantity = v_quantity,
        quantity_remaining = v_quantity,
        unit_cost_basis_minor = v_unit_cost_basis,
        cost_basis_currency = p_currency,
        unit_cost_basis_nok_minor = v_unit_cost_basis_nok,
        residual_minor = v_residual
      where id = v_lot.id;
    end if;
  end loop;

  select * into v_existing from public.purchases where id = p_purchase_id;
  return v_existing;
end;
$$;

comment on function public.update_purchase(
  uuid, date, text, jsonb, uuid, bigint, bigint, bigint, numeric, date, public.fx_source, text
) is
  'Recomputes a purchase''s allocations and every existing line''s attributable cost/cost basis atomically. Cannot add or remove lines. Blocked if any produced lot has been disposed elsewhere.';

-- ── 6. void_purchase — the whole-receipt void path ──────────────────────────────────────────────
-- Same blocker rule as update_purchase. When clear, voids the purchase and every non-voided lot it
-- produced in one transaction (prompt §60: a voided purchase must not leave owned inventory whose
-- source purchase has been excluded from spend).
create or replace function public.void_purchase(p_purchase_id uuid, p_reason text default null)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_existing public.purchases;
  v_blocker record;
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

  select pl.description, pl.line_type, al.quantity, al.quantity_remaining
    into v_blocker
    from public.purchase_lines pl
    join public.acquisition_lots al on al.purchase_line_id = pl.id
    where pl.purchase_id = p_purchase_id
      and al.voided_at is null
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

  update public.acquisition_lots al
    set voided_at = now()
    from public.purchase_lines pl
    where pl.id = al.purchase_line_id
      and pl.purchase_id = p_purchase_id
      and al.voided_at is null;
end;
$$;

comment on function public.void_purchase(uuid, text) is
  'Voids a whole purchase and every lot it produced, atomically. Blocked if any lot has been disposed elsewhere.';

-- ── 7. purchase_spending_summary — the headline aggregate, one query ────────────────────────────
-- GPO from purchases.total_nok_minor (its own definition, FINANCIAL_MODEL.md §2.1); CS/HS from
-- purchase_lines.attributable_cost_nok_minor grouped by spend_class, joined through purchases to
-- exclude voided ones (purchase_lines carries no voided_at of its own — a purchase's void status is
-- the only thing that excludes its lines). Both are real, independent statements of the same
-- underlying data (F1 in the invariant register), which is exactly why this RPC returns both rather
-- than only the total. Money returned as text — see the bigint/PostgREST precision boundary note in
-- DATA_MODEL.md §14 / src/data/money.ts.
create or replace function public.purchase_spending_summary()
returns table (
  gpo_nok_minor text,
  cs_nok_minor text,
  hs_nok_minor text,
  purchase_count integer
)
language sql
stable
set search_path = ''
as $$
  select
    coalesce((select sum(p.total_nok_minor) from public.purchases p
              where p.user_id = auth.uid() and p.voided_at is null), 0)::text,
    coalesce((select sum(pl.attributable_cost_nok_minor)
              from public.purchase_lines pl
              join public.purchases p on p.id = pl.purchase_id
              where pl.user_id = auth.uid() and p.voided_at is null and pl.spend_class = 'collectible'), 0)::text,
    coalesce((select sum(pl.attributable_cost_nok_minor)
              from public.purchase_lines pl
              join public.purchases p on p.id = pl.purchase_id
              where pl.user_id = auth.uid() and p.voided_at is null and pl.spend_class = 'hobby'), 0)::text,
    (select count(*)::int from public.purchases p
      where p.user_id = auth.uid() and p.voided_at is null);
$$;

-- ── 8. Grants ────────────────────────────────────────────────────────────────────────────────
-- PostgreSQL grants EXECUTE on a newly created function to PUBLIC by default — revoke it
-- explicitly at creation, same as every function-creating migration since M4
-- (20260820120040_m4_explicit_function_revokes.sql).
revoke execute on function public.create_purchase(
  date, text, jsonb, uuid, bigint, bigint, bigint, numeric, date, public.fx_source, text
) from public;
revoke execute on function public.update_purchase(
  uuid, date, text, jsonb, uuid, bigint, bigint, bigint, numeric, date, public.fx_source, text
) from public;
revoke execute on function public.void_purchase(uuid, text) from public;
revoke execute on function public.purchase_spending_summary() from public;
revoke execute on function public.void_acquisition_lot(uuid, text) from public;

grant execute on function public.create_purchase(
  date, text, jsonb, uuid, bigint, bigint, bigint, numeric, date, public.fx_source, text
) to authenticated;
grant execute on function public.update_purchase(
  uuid, date, text, jsonb, uuid, bigint, bigint, bigint, numeric, date, public.fx_source, text
) to authenticated;
grant execute on function public.void_purchase(uuid, text) to authenticated;
grant execute on function public.purchase_spending_summary() to authenticated;
grant execute on function public.void_acquisition_lot(uuid, text) to authenticated;
