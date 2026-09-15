-- P133 (docs/DECISIONS.md D-132, ai_outputs/Claude_outputs/output_130.txt P130-02): every SQL site
-- that converts a foreign-currency amount to NOK assumed the source currency shares NOK's
-- minor-unit exponent (2). FINANCIAL_MODEL.md §1/D-007 already state the opposite rule ("Minor-unit
-- exponent read from a currency table, not assumed to be 2") and src/domain/fx.ts already honours
-- it client-side — only the SQL layer was wrong. For every currency this project has ever accepted
-- except JPY (NOK/EUR/USD/GBP, all exponent 2) the bug is numerically invisible, which is exactly
-- why it survived: `round(amount_minor * rate)` only differs from the correct, exponent-aware
-- formula when the source exponent differs from NOK's.
--
-- THE BUG, concretely (P130-02). JPY has exponent 0 (1 JPY has no fractional minor unit — see
-- src/domain/currency.ts). `fx_rate_to_nok` is, and has always been documented as
-- (FINANCIAL_MODEL.md §7), "NOK per one MAJOR unit of the source currency". The correct conversion
-- is therefore `amount_minor / 10^source_exponent * rate * 10^NOK_exponent`, which collapses to
-- `amount_minor * rate` only when source_exponent = NOK_exponent = 2. For JPY the missing factor is
-- 10^(2-0) = 100: a purchase of 10000 JPY at a manually-entered rate of 0.060375 NOK/JPY produced
-- `total_nok_minor = round(10000 * 0.060375) = 604` (6.04 NOK) instead of the correct
-- `round(10000 * 0.060375 * 100) = 60375` (603.75 NOK) — money short by a factor of ~100. The
-- automatic (Norges Bank) path happened to land on the right NOK figure only because the ingestion
-- parser (supabase/functions/_shared/norges-bank.ts, owned by a separate workstream — see the
-- P134_PROVIDER_CONTRACT note in output_133.txt) independently ignores the SDMX `UNIT_MULT=2`
-- attribute on the JPY series and stores a rate that is itself already 100x too small — two bugs
-- that cancelled for auto-sourced rows and did not cancel for a manually-entered, semantically
-- correct rate. That cancellation is exactly what this migration removes: after this migration, the
-- ingestion layer MUST hand SQL a true per-one-JPY rate (see the contract note below) or the
-- automatic path will start producing 100x-too-large NOK figures instead. This migration only
-- touches SQL; supabase/functions/_shared/norges-bank.ts and ingest-fx are out of scope here.
--
-- HOSTED IMPACT: read-only diagnostics taken repeatedly through P131/P132 (output_131.txt,
-- output_132_i.txt) found zero JPY purchase or sale rows on the hosted database at every check
-- point up to and including the P132 release (JPY_PURCHASE_COUNT=0, JPY_SALE_COUNT=0 both times).
-- No existing row is affected and no data-repair migration accompanies this fix.
--
-- THE FIX. One canonical, exponent-aware SQL conversion (`money_minor_to_nok_minor`, built on a
-- small currency-exponent lookup mirroring src/domain/currency.ts exactly) replaces every inline
-- `round(amount::numeric * rate)::bigint` that converts a transaction amount to NOK: the two
-- purchase RPCs, the two sale RPCs, `sales_summary`'s four per-row NOK aggregates, and the two
-- frozen-rate CHECK constraints (`purchases_total_nok_matches_rate`,
-- `sales_net_proceeds_nok_matches_rate`). For every currency this codebase has ever stored other
-- than JPY the new formula is byte-identical to the old one (the exponent shift is zero), so this
-- is a pure bug fix for JPY, not a behavioural change for NOK/EUR/USD/GBP — proven by the parity
-- property test in tests/db/p133_currency_exponent_fx.test.ts and by the full pre-existing suite
-- passing unchanged. Rounding is unchanged: `round(numeric)`, half-away-from-zero, applied exactly
-- once per conversion, same as every site it replaces (FINANCIAL_MODEL.md §1; the existing negative-
-- amount comment on `sales_net_proceeds_nok_matches_rate` already documents this tie-break and
-- stays correct here).
--
-- SCOPE NOTES (full inventory in output_133.txt CONVERSION_SITE_INVENTORY):
--  * `purchase_spending_summary` and the M9/M12 market-value resolvers (`resolve_variant_market_
--    values`, `list_portfolio`'s live-value CTEs, market movers, dashboard reads) either read
--    already-frozen `*_nok_minor` columns (no fresh conversion, NOT_APPLICABLE) or convert
--    `price_snapshots.source_currency`, which today is always USD or EUR (TCGdex; both exponent 2,
--    same as NOK) — the identical generic bug exists there structurally but is currently
--    unreachable (no JPY-priced snapshot has ever been ingested) and is deliberately left
--    unmodified here to keep this change scoped to P130-02's own affected-files list; flagged as a
--    WARNING in output_133.txt for a future ticket rather than fixed as a side effect of this one.
--  * `reconcile_opening_cost`/`create_opening`'s provisional purchase, `void_sale`, and
--    `set_sealed_lot_intent` perform no fresh FX conversion (openings copy already-frozen NOK
--    figures; voiding reverses without recomputing) — NOT_APPLICABLE, left untouched.
--  * `manual_valuations.value_nok_minor` is currently only ever written with currency hardcoded to
--    'NOK' (no conversion happens) — NOT_APPLICABLE.
--
-- FUNCTION_SIGNATURES_CHANGED=no: every RPC below keeps its exact existing parameter list, defaults
-- and return type — only the body's FX line changes. CREATE OR REPLACE, no re-grant needed for the
-- four RPCs. The two new helper functions ARE granted EXECUTE, to authenticated and service_role
-- only (never anon) — not because either RPC needs the grant to call them (a SECURITY DEFINER
-- function's owner already has implicit EXECUTE on everything it owns, and even the two SECURITY
-- INVOKER RPCs, create_purchase/update_purchase, only reach here as 'authenticated'), but because
-- the two CHECK constraints below evaluate under whichever role performs the write, and
-- tests/db/money-boundary.test.ts proved a direct service-role table write (bypassing every RPC)
-- needs the grant too. anon is never a legitimate writer of purchases/sales and stays excluded.

-- ── 1. Canonical currency-exponent lookup — the SQL-side twin of src/domain/currency.ts ──────────
-- IMMUTABLE (a pure switch on a 3-letter code). Raises for anything outside the five currencies
-- this product supports today rather than silently returning NULL/assuming 2 — "unsupported
-- currencies fail closed" (fixes, as a direct consequence rather than a separate change, the
-- currency half of P130-18's "server accepts currency XXX" for every write path that reaches
-- money_minor_to_nok_minor below; P130-18's date range finding is untouched and remains open).
create or replace function public.currency_minor_unit_exponent(p_currency text)
returns smallint
language plpgsql
immutable
set search_path = ''
as $$
begin
  case p_currency
    when 'NOK' then return 2;
    when 'EUR' then return 2;
    when 'USD' then return 2;
    when 'GBP' then return 2;
    when 'JPY' then return 0;
    else
      raise exception 'unsupported currency code: %', p_currency
        using errcode = '22023';
  end case;
end;
$$;

revoke execute on function public.currency_minor_unit_exponent(text) from public;
grant execute on function public.currency_minor_unit_exponent(text) to authenticated, service_role;

comment on function public.currency_minor_unit_exponent(text) is
  'Minor-unit exponent per ISO 4217 code, mirroring src/domain/currency.ts CURRENCIES exactly (FINANCIAL_MODEL.md §1, D-007). Granted to authenticated (same posture as allocate_largest_remainder: create_purchase/update_purchase run SECURITY INVOKER and call this as the caller''s own role, so function-owner privilege alone is not enough) and to service_role (the CHECK constraints that call this evaluate under whichever role performs the INSERT/UPDATE, including a direct service-role write that bypasses every RPC — tests/db/money-boundary.test.ts is exactly such a write). anon stays excluded. Raises for any code outside the five currencies the product supports today rather than assuming 2 (P130-02/P133: unsupported currencies fail closed).';

-- ── 2. Canonical NOK conversion — replaces every `round(amount_minor::numeric * rate)::bigint` ───
-- `p_fx_rate_to_nok` is always "NOK per one MAJOR unit of the source currency" (FINANCIAL_MODEL.md
-- §7) — the SAME semantic for every currency and every source (Norges Bank or manual); there is no
-- JPY-specific "rate per 100 units" input anywhere in this product (P133 prompt §12). NULL amount,
-- currency or rate returns NULL (M1: NULL never means zero — callers that need "not applicable"
-- already pass NULL through unchanged rather than coercing to 0). Target is always NOK (exponent 2,
-- fixed — this codebase never converts INTO a foreign currency for storage, only for display,
-- which is presentation-only and client-side per D-057). For an exponent-2 source currency the
-- shift is zero and this is byte-identical to the formula it replaces.
create or replace function public.money_minor_to_nok_minor(
  p_amount_minor bigint,
  p_currency text,
  p_fx_rate_to_nok numeric
)
returns bigint
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_source_exponent smallint;
  v_shift smallint;
begin
  if p_amount_minor is null or p_currency is null or p_fx_rate_to_nok is null then
    return null;
  end if;
  v_source_exponent := public.currency_minor_unit_exponent(p_currency);
  v_shift := 2 - v_source_exponent; -- NOK's own exponent is fixed at 2 (D-007)
  if v_shift >= 0 then
    return round(p_amount_minor::numeric * p_fx_rate_to_nok * (10::numeric ^ v_shift))::bigint;
  else
    return round(p_amount_minor::numeric * p_fx_rate_to_nok / (10::numeric ^ (-v_shift)))::bigint;
  end if;
end;
$$;

revoke execute on function public.money_minor_to_nok_minor(bigint, text, numeric) from public;
grant execute on function public.money_minor_to_nok_minor(bigint, text, numeric) to authenticated, service_role;

comment on function public.money_minor_to_nok_minor(bigint, text, numeric) is
  'Canonical, exponent-aware NOK conversion (P130-02/P133): amount_minor / 10^source_exponent * rate * 10^2, rounded half-away-from-zero exactly once via numeric round(). Replaces every inline round(amount * rate) FX site: create_purchase, update_purchase, create_sale, update_sale, sales_summary, and the two frozen-rate CHECK constraints. Granted to authenticated (create_purchase/update_purchase are SECURITY INVOKER and need this directly) and to service_role (the CHECK constraints evaluate under whichever role performs the write, including a direct service-role table write that bypasses every RPC). anon stays excluded.';

-- ── 3. Frozen-rate CHECK constraints — same exponent-naive formula, now exponent-aware ───────────
alter table public.purchases
  drop constraint purchases_total_nok_matches_rate,
  add constraint purchases_total_nok_matches_rate check (
    total_nok_minor = public.money_minor_to_nok_minor(total_minor, currency, fx_rate_to_nok)
  );

alter table public.sales
  drop constraint sales_net_proceeds_nok_matches_rate,
  add constraint sales_net_proceeds_nok_matches_rate check (
    net_proceeds_nok_minor = public.money_minor_to_nok_minor(net_proceeds_minor, currency, fx_rate_to_nok)
  );

-- ── 4. create_purchase — full body restated (CREATE OR REPLACE), one line changed ────────────────
-- The only change from 20260905130000: v_total_nok now calls money_minor_to_nok_minor(v_total,
-- p_currency, v_fx_rate) instead of round(v_total::numeric * v_fx_rate)::bigint. Everything else,
-- including the idempotent-replay handling (D-121/D-122), is copied unchanged.
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
  'Atomic multi-line purchase write: one purchase, its lines, allocated shipping/customs/discount, and (for card/sealed lines) the holdings and acquisition lots they produce. Optional p_idempotency_key: a replay with the same (user, key) and the same material request returns the original purchase, updating only p_notes if it differs (D-122) — the financial rows never change on replay. A same-key replay with a materially different request (anything but notes) is refused. M11 (20260829120060) sets sealed_intent on the lot it creates (moved off holdings, 20260829120000) and allows manual_value_minor for a sealed line too. P133 (20260915120000) made the NOK conversion exponent-aware (P130-02). See FINANCIAL_MODEL.md §4, DATA_MODEL.md §5.3-5.5.';

-- ── 5. update_purchase — full body restated (CREATE OR REPLACE), one line changed ────────────────
-- The only change from 20260914120000: v_total_nok now calls money_minor_to_nok_minor(v_total,
-- p_currency, v_fx_rate) instead of round(v_total::numeric * v_fx_rate)::bigint. The P132 multi-lot
-- integrity and lock-order fix is otherwise copied unchanged.
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
  'Recomputes a purchase''s allocations and every existing line''s attributable cost/cost basis atomically. Cannot add or remove lines. Locks every live lot on the purchase (ascending id order) before validating or writing, refuses if any is partially disposed elsewhere. A line with more than one live sibling lot (a sealed-intent split) preserves each sibling''s quantity and redistributes the line''s attributable cost across them exactly; changing such a line''s quantity is refused as ambiguous, as is changing the quantity of a line with removed sibling lots or with no live lot at all (removed units are never resurrected, D-130). P132 (20260914120000) fixed P130-01 (multi-lot fabrication) and this function''s P130-03 slice (unlocked disposal check) together; P133 (20260915120000) made the NOK conversion exponent-aware (P130-02).';

-- ── 6. create_sale — full body restated (CREATE OR REPLACE), one line changed ─────────────────────
-- The only change from 20260828120010: v_net_nok now calls money_minor_to_nok_minor(v_net,
-- p_currency, v_fx_rate) instead of round(v_net::numeric * v_fx_rate)::bigint.
create or replace function public.create_sale(
  p_sold_on date,
  p_currency text,
  p_lines jsonb,
  p_idempotency_key uuid,
  p_marketplace text default null,
  p_fees_minor bigint default 0,
  p_shipping_cost_minor bigint default 0,
  p_shipping_charged_minor bigint default 0,
  p_fx_rate_to_nok numeric(18, 8) default null,
  p_fx_rate_date date default null,
  p_fx_source public.fx_source default null,
  p_notes text default null
)
returns public.sales
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_existing public.sales;
  v_sale public.sales;
  v_line jsonb;
  v_line_count int;
  v_idx int;
  v_lot_ids uuid[] := '{}';
  v_quantities int[] := '{}';
  v_unit_gross bigint[] := '{}';
  v_line_gross bigint[] := '{}';
  v_gross bigint := 0;
  v_net bigint;
  v_net_nok bigint;
  v_fx_rate numeric(18, 8);
  v_lock_order int[];
  v_bases_nok bigint[];
  v_lot public.acquisition_lots;
  v_adjustments_total_nok bigint;
  v_adj_per_unit bigint;
  v_adj_residual bigint;
  v_exhausts boolean;
  v_basis_component bigint;
  v_alloc_fees bigint[];
  v_alloc_ship bigint[];
  v_alloc_ship_charged bigint[];
  v_line_net bigint[] := '{}';
  v_line_net_nok bigint[];
  v_realized_sum bigint := 0;
  v_has_known boolean := false;
  v_uncosted_sum bigint := 0;
  v_realized bigint;
  v_sale_line_id uuid;
begin
  if v_user_id is null then
    raise exception 'not authenticated';
  end if;
  if p_idempotency_key is null then
    raise exception 'p_idempotency_key is required';
  end if;

  select * into v_existing from public.sales
    where user_id = v_user_id and idempotency_key = p_idempotency_key;
  if v_existing.id is not null then
    return v_existing;
  end if;

  if p_sold_on is null then
    raise exception 'p_sold_on is required';
  end if;
  if p_currency is null or p_currency !~ '^[A-Z]{3}$' then
    raise exception 'p_currency must be a 3-letter uppercase ISO 4217 code';
  end if;
  if coalesce(p_fees_minor, 0) < 0 or coalesce(p_shipping_cost_minor, 0) < 0
     or coalesce(p_shipping_charged_minor, 0) < 0 then
    raise exception 'fees, shipping cost and shipping charged must be non-negative';
  end if;

  if p_currency = 'NOK' then
    v_fx_rate := 1;
  else
    if p_fx_rate_to_nok is null or p_fx_rate_to_nok <= 0 then
      raise exception 'a positive p_fx_rate_to_nok is required for a non-NOK sale';
    end if;
    if p_fx_rate_date is null then
      raise exception 'p_fx_rate_date is required for a non-NOK sale';
    end if;
    if p_fx_source is null then
      raise exception 'p_fx_source is required for a non-NOK sale';
    end if;
    v_fx_rate := p_fx_rate_to_nok;
  end if;

  v_line_count := coalesce(jsonb_array_length(p_lines), 0);
  if v_line_count = 0 then
    raise exception 'a sale requires at least one line';
  end if;

  -- Pass 1: parse & validate every line; compute per-line gross and the sale-level gross total.
  for v_idx in 0 .. v_line_count - 1 loop
    v_line := p_lines -> v_idx;

    if nullif(v_line ->> 'lot_id', '') is null then
      raise exception 'line %: lot_id is required', v_idx;
    end if;
    if (v_line ->> 'lot_id')::uuid = any(v_lot_ids) then
      raise exception 'line %: lot % is referenced more than once — combine into a single line',
        v_idx, (v_line ->> 'lot_id')::uuid;
    end if;
    if (v_line ->> 'quantity')::int is null or (v_line ->> 'quantity')::int <= 0 then
      raise exception 'line %: quantity must be a positive integer', v_idx;
    end if;

    v_lot_ids := v_lot_ids || (v_line ->> 'lot_id')::uuid;
    v_quantities := v_quantities || (v_line ->> 'quantity')::int;
    v_unit_gross := v_unit_gross || nullif(v_line ->> 'unit_gross_minor', '')::bigint;
  end loop;

  for v_idx in 1 .. v_line_count loop
    if v_unit_gross[v_idx] is null or v_unit_gross[v_idx] < 0 then
      raise exception 'line %: unit_gross_minor must be a non-negative amount', v_idx - 1;
    end if;
    v_line_gross := v_line_gross || (v_unit_gross[v_idx] * v_quantities[v_idx]);
    v_gross := v_gross + v_line_gross[v_idx];
  end loop;

  v_net := v_gross - coalesce(p_fees_minor, 0) - coalesce(p_shipping_cost_minor, 0)
           + coalesce(p_shipping_charged_minor, 0);
  v_net_nok := public.money_minor_to_nok_minor(v_net, p_currency, v_fx_rate);

  -- Pass 2: lock every referenced lot in ascending id order, validate it, freeze this line's
  -- cost basis (see the migration header for the residual/adjustment rule).
  select array_agg(ord order by lot_id) into v_lock_order
    from unnest(v_lot_ids) with ordinality as t(lot_id, ord);

  foreach v_idx in array v_lock_order loop
    select * into v_lot from public.acquisition_lots
      where id = v_lot_ids[v_idx] and user_id = v_user_id
      for update;
    -- No existence oracle (prompt §106): a foreign, missing or voided lot all fail identically.
    if v_lot.id is null or v_lot.voided_at is not null then
      raise exception 'one or more selected lots are unavailable';
    end if;
    if v_lot.quantity_remaining < v_quantities[v_idx] then
      raise exception 'only % of the selected lot remain available, but % were requested',
        v_lot.quantity_remaining, v_quantities[v_idx];
    end if;

    if v_lot.cost_basis_state = 'known' then
      select coalesce(sum(amount_nok_minor), 0) into v_adjustments_total_nok
        from public.lot_cost_adjustments where lot_id = v_lot.id;
      v_adj_per_unit := v_adjustments_total_nok / v_lot.quantity;
      v_adj_residual := v_adjustments_total_nok - v_adj_per_unit * v_lot.quantity;
      v_exhausts := (v_lot.quantity_remaining - v_quantities[v_idx]) = 0;
      v_basis_component := (v_lot.unit_cost_basis_nok_minor + v_adj_per_unit) * v_quantities[v_idx];
      if v_exhausts then
        v_basis_component := v_basis_component + v_lot.residual_nok_minor + v_adj_residual;
      end if;
      v_bases_nok[v_idx] := v_basis_component;
    else
      v_bases_nok[v_idx] := null;
    end if;
  end loop;

  -- Pass 3: allocate sale-level charges pro rata by gross, largest remainder.
  v_alloc_fees := public.allocate_largest_remainder(coalesce(p_fees_minor, 0), v_line_gross);
  v_alloc_ship := public.allocate_largest_remainder(coalesce(p_shipping_cost_minor, 0), v_line_gross);
  v_alloc_ship_charged :=
    public.allocate_largest_remainder(coalesce(p_shipping_charged_minor, 0), v_line_gross);

  for v_idx in 1 .. v_line_count loop
    v_line_net := v_line_net ||
      (v_line_gross[v_idx] - v_alloc_fees[v_idx] - v_alloc_ship[v_idx] + v_alloc_ship_charged[v_idx]);
  end loop;

  v_line_net_nok := public.allocate_largest_remainder_signed(v_net_nok, v_line_gross);

  for v_idx in 1 .. v_line_count loop
    if v_bases_nok[v_idx] is not null then
      v_realized_sum := v_realized_sum + (v_line_net_nok[v_idx] - v_bases_nok[v_idx]);
      v_has_known := true;
    else
      v_uncosted_sum := v_uncosted_sum + v_line_net_nok[v_idx];
    end if;
  end loop;

  insert into public.sales (
    user_id, sold_on, marketplace, currency, gross_minor, fees_minor, shipping_cost_minor,
    shipping_charged_minor, net_proceeds_minor, fx_rate_to_nok, fx_rate_date, fx_source,
    net_proceeds_nok_minor, realized_result_nok_minor, proceeds_from_uncosted_nok_minor,
    notes, idempotency_key
  ) values (
    v_user_id, p_sold_on, p_marketplace, p_currency, v_gross, coalesce(p_fees_minor, 0),
    coalesce(p_shipping_cost_minor, 0), coalesce(p_shipping_charged_minor, 0), v_net, v_fx_rate,
    coalesce(p_fx_rate_date, p_sold_on), coalesce(p_fx_source, 'manual'), v_net_nok,
    case when v_has_known then v_realized_sum else null end, v_uncosted_sum, p_notes,
    p_idempotency_key
  )
  returning * into v_sale;

  for v_idx in 1 .. v_line_count loop
    if v_bases_nok[v_idx] is not null then
      v_realized := v_line_net_nok[v_idx] - v_bases_nok[v_idx];
    else
      v_realized := null;
    end if;

    insert into public.sale_lines (
      sale_id, user_id, lot_id, quantity, unit_gross_minor, line_gross_minor,
      allocated_fees_minor, allocated_shipping_minor, allocated_shipping_charged_minor,
      net_proceeds_minor, net_proceeds_nok_minor, cost_basis_at_sale_nok_minor,
      realized_result_nok_minor
    ) values (
      v_sale.id, v_user_id, v_lot_ids[v_idx], v_quantities[v_idx], v_unit_gross[v_idx],
      v_line_gross[v_idx], v_alloc_fees[v_idx], v_alloc_ship[v_idx], v_alloc_ship_charged[v_idx],
      v_line_net[v_idx], v_line_net_nok[v_idx], v_bases_nok[v_idx], v_realized
    )
    returning id into v_sale_line_id;

    insert into public.lot_disposals (lot_id, user_id, kind, quantity, disposed_on, sale_line_id)
    values (v_lot_ids[v_idx], v_user_id, 'sale', v_quantities[v_idx], p_sold_on, v_sale_line_id);
  end loop;

  return v_sale;
end;
$$;

comment on function public.create_sale(
  date, text, jsonb, uuid, text, bigint, bigint, bigint, numeric, date, public.fx_source, text
) is
  'Atomic multi-line sale write: one sale, its lines (each disposing from exactly one explicitly-chosen lot), the disposal ledger rows, and the frozen cost basis/realized result each line is entitled to. P133 (20260915120000) made the NOK conversion exponent-aware (P130-02). See FINANCIAL_MODEL.md §2.2/§4.5, DATA_MODEL.md §5.7/§5.11.';

-- ── 7. update_sale — full body restated (CREATE OR REPLACE), one line changed ────────────────────
-- The only change from 20260828120010: v_net_nok now calls money_minor_to_nok_minor(v_net,
-- p_currency, v_fx_rate) instead of round(v_net::numeric * v_fx_rate)::bigint.
create or replace function public.update_sale(
  p_sale_id uuid,
  p_sold_on date,
  p_currency text,
  p_lines jsonb,
  p_marketplace text default null,
  p_fees_minor bigint default 0,
  p_shipping_cost_minor bigint default 0,
  p_shipping_charged_minor bigint default 0,
  p_fx_rate_to_nok numeric(18, 8) default null,
  p_fx_rate_date date default null,
  p_fx_source public.fx_source default null,
  p_notes text default null
)
returns public.sales
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_existing public.sales;
  v_line jsonb;
  v_line_count int;
  v_idx int;
  v_line_id uuid;
  v_expected_ids uuid[];
  v_given_ids uuid[] := '{}';
  v_line_ids_ordered uuid[] := '{}';
  v_quantities int[] := '{}';
  v_unit_gross bigint[] := '{}';
  v_line_gross bigint[] := '{}';
  v_bases_nok bigint[] := '{}';
  v_gross bigint := 0;
  v_net bigint;
  v_net_nok bigint;
  v_fx_rate numeric(18, 8);
  v_alloc_fees bigint[];
  v_alloc_ship bigint[];
  v_alloc_ship_charged bigint[];
  v_line_net bigint[] := '{}';
  v_line_net_nok bigint[];
  v_realized_sum bigint := 0;
  v_has_known boolean := false;
  v_uncosted_sum bigint := 0;
  v_realized bigint;
  v_line_row record;
begin
  if v_user_id is null then
    raise exception 'not authenticated';
  end if;
  if p_sold_on is null then
    raise exception 'p_sold_on is required';
  end if;

  select * into v_existing from public.sales where id = p_sale_id and user_id = v_user_id;
  if v_existing.id is null then
    raise exception 'sale % not found', p_sale_id;
  end if;
  if v_existing.voided_at is not null then
    raise exception 'sale % is voided and cannot be edited', p_sale_id;
  end if;

  select array_agg(id order by id) into v_expected_ids
    from public.sale_lines where sale_id = p_sale_id;

  if p_currency is null or p_currency !~ '^[A-Z]{3}$' then
    raise exception 'p_currency must be a 3-letter uppercase ISO 4217 code';
  end if;
  if coalesce(p_fees_minor, 0) < 0 or coalesce(p_shipping_cost_minor, 0) < 0
     or coalesce(p_shipping_charged_minor, 0) < 0 then
    raise exception 'fees, shipping cost and shipping charged must be non-negative';
  end if;
  if p_currency = 'NOK' then
    v_fx_rate := 1;
  else
    if p_fx_rate_to_nok is null or p_fx_rate_to_nok <= 0 then
      raise exception 'a positive p_fx_rate_to_nok is required for a non-NOK sale';
    end if;
    if p_fx_rate_date is null or p_fx_source is null then
      raise exception 'p_fx_rate_date and p_fx_source are required for a non-NOK sale';
    end if;
    v_fx_rate := p_fx_rate_to_nok;
  end if;

  v_line_count := coalesce(jsonb_array_length(p_lines), 0);
  if v_line_count = 0 then
    raise exception 'a sale requires at least one line';
  end if;

  for v_idx in 0 .. v_line_count - 1 loop
    v_line := p_lines -> v_idx;
    v_line_id := nullif(v_line ->> 'line_id', '')::uuid;
    if v_line_id is null then
      raise exception
        'line %: line_id is required for an edit — lots and quantities cannot change here; void this sale and record a corrected one instead',
        v_idx;
    end if;
    v_given_ids := v_given_ids || v_line_id;
    v_line_ids_ordered := v_line_ids_ordered || v_line_id;
  end loop;

  if v_expected_ids is null or array_length(v_expected_ids, 1) <> v_line_count
     or (select array_agg(x order by x) from unnest(v_given_ids) x) <> v_expected_ids then
    raise exception
      'update_sale cannot add, remove or repoint lines — void this sale and record a corrected one instead';
  end if;

  for v_idx in 0 .. v_line_count - 1 loop
    v_line := p_lines -> v_idx;
    select quantity, cost_basis_at_sale_nok_minor into v_line_row
      from public.sale_lines where id = v_line_ids_ordered[v_idx + 1];
    v_quantities := v_quantities || v_line_row.quantity;
    v_bases_nok := v_bases_nok || v_line_row.cost_basis_at_sale_nok_minor;
    v_unit_gross := v_unit_gross || nullif(v_line ->> 'unit_gross_minor', '')::bigint;
  end loop;

  for v_idx in 1 .. v_line_count loop
    if v_unit_gross[v_idx] is null or v_unit_gross[v_idx] < 0 then
      raise exception 'line %: unit_gross_minor must be a non-negative amount', v_idx - 1;
    end if;
    v_line_gross := v_line_gross || (v_unit_gross[v_idx] * v_quantities[v_idx]);
    v_gross := v_gross + v_line_gross[v_idx];
  end loop;

  v_net := v_gross - coalesce(p_fees_minor, 0) - coalesce(p_shipping_cost_minor, 0)
           + coalesce(p_shipping_charged_minor, 0);
  v_net_nok := public.money_minor_to_nok_minor(v_net, p_currency, v_fx_rate);

  v_alloc_fees := public.allocate_largest_remainder(coalesce(p_fees_minor, 0), v_line_gross);
  v_alloc_ship := public.allocate_largest_remainder(coalesce(p_shipping_cost_minor, 0), v_line_gross);
  v_alloc_ship_charged :=
    public.allocate_largest_remainder(coalesce(p_shipping_charged_minor, 0), v_line_gross);

  for v_idx in 1 .. v_line_count loop
    v_line_net := v_line_net ||
      (v_line_gross[v_idx] - v_alloc_fees[v_idx] - v_alloc_ship[v_idx] + v_alloc_ship_charged[v_idx]);
  end loop;

  v_line_net_nok := public.allocate_largest_remainder_signed(v_net_nok, v_line_gross);

  for v_idx in 1 .. v_line_count loop
    if v_bases_nok[v_idx] is not null then
      v_realized_sum := v_realized_sum + (v_line_net_nok[v_idx] - v_bases_nok[v_idx]);
      v_has_known := true;
    else
      v_uncosted_sum := v_uncosted_sum + v_line_net_nok[v_idx];
    end if;
  end loop;

  update public.sales set
    sold_on = p_sold_on,
    marketplace = p_marketplace,
    currency = p_currency,
    gross_minor = v_gross,
    fees_minor = coalesce(p_fees_minor, 0),
    shipping_cost_minor = coalesce(p_shipping_cost_minor, 0),
    shipping_charged_minor = coalesce(p_shipping_charged_minor, 0),
    net_proceeds_minor = v_net,
    fx_rate_to_nok = v_fx_rate,
    fx_rate_date = coalesce(p_fx_rate_date, p_sold_on),
    fx_source = coalesce(p_fx_source, 'manual'),
    net_proceeds_nok_minor = v_net_nok,
    realized_result_nok_minor = case when v_has_known then v_realized_sum else null end,
    proceeds_from_uncosted_nok_minor = v_uncosted_sum,
    notes = p_notes
  where id = p_sale_id;

  for v_idx in 1 .. v_line_count loop
    if v_bases_nok[v_idx] is not null then
      v_realized := v_line_net_nok[v_idx] - v_bases_nok[v_idx];
    else
      v_realized := null;
    end if;

    update public.sale_lines set
      unit_gross_minor = v_unit_gross[v_idx],
      line_gross_minor = v_line_gross[v_idx],
      allocated_fees_minor = v_alloc_fees[v_idx],
      allocated_shipping_minor = v_alloc_ship[v_idx],
      allocated_shipping_charged_minor = v_alloc_ship_charged[v_idx],
      net_proceeds_minor = v_line_net[v_idx],
      net_proceeds_nok_minor = v_line_net_nok[v_idx],
      realized_result_nok_minor = v_realized
      -- cost_basis_at_sale_nok_minor: never written here. Frozen forever (prompt §28).
    where id = v_line_ids_ordered[v_idx];
  end loop;

  select * into v_existing from public.sales where id = p_sale_id;
  return v_existing;
end;
$$;

comment on function public.update_sale(
  uuid, date, text, jsonb, text, bigint, bigint, bigint, numeric, date, public.fx_source, text
) is
  'Recomputes a sale''s allocations and every existing line''s proceeds atomically from corrected sale-level charges/prices. Cannot add, remove or repoint lines, and never rewrites a frozen cost_basis_at_sale_nok_minor. P133 (20260915120000) made the NOK conversion exponent-aware (P130-02).';

-- ── 8. sales_summary — full body restated (CREATE OR REPLACE), four conversions changed ──────────
-- The only change from 20260828120010: each `round(s.xxx_minor::numeric * s.fx_rate_to_nok)`
-- becomes `public.money_minor_to_nok_minor(s.xxx_minor, s.currency, s.fx_rate_to_nok)`.
create or replace function public.sales_summary()
returns table (
  sale_count integer,
  gross_nok_minor text,
  fees_nok_minor text,
  outbound_shipping_nok_minor text,
  buyer_shipping_nok_minor text,
  nsp_nok_minor text,
  rrc_nok_minor text,
  pud_nok_minor text
)
language sql
stable
set search_path = ''
as $$
  select
    (select count(*)::int from public.sales s
      where s.user_id = auth.uid() and s.voided_at is null),
    coalesce((select sum(public.money_minor_to_nok_minor(s.gross_minor, s.currency, s.fx_rate_to_nok))
              from public.sales s where s.user_id = auth.uid() and s.voided_at is null), 0)::text,
    coalesce((select sum(public.money_minor_to_nok_minor(s.fees_minor, s.currency, s.fx_rate_to_nok))
              from public.sales s where s.user_id = auth.uid() and s.voided_at is null), 0)::text,
    coalesce((select sum(public.money_minor_to_nok_minor(s.shipping_cost_minor, s.currency, s.fx_rate_to_nok))
              from public.sales s where s.user_id = auth.uid() and s.voided_at is null), 0)::text,
    coalesce((select sum(public.money_minor_to_nok_minor(s.shipping_charged_minor, s.currency, s.fx_rate_to_nok))
              from public.sales s where s.user_id = auth.uid() and s.voided_at is null), 0)::text,
    coalesce((select sum(s.net_proceeds_nok_minor)
              from public.sales s where s.user_id = auth.uid() and s.voided_at is null), 0)::text,
    coalesce((select sum(sl.realized_result_nok_minor)
              from public.sale_lines sl join public.sales s on s.id = sl.sale_id
              where s.user_id = auth.uid() and s.voided_at is null
                and sl.cost_basis_at_sale_nok_minor is not null), 0)::text,
    coalesce((select sum(sl.net_proceeds_nok_minor)
              from public.sale_lines sl join public.sales s on s.id = sl.sale_id
              where s.user_id = auth.uid() and s.voided_at is null
                and sl.cost_basis_at_sale_nok_minor is null), 0)::text;
$$;

comment on function public.sales_summary() is
  'Headline sales aggregate, one query. gross/fees/outbound-shipping/buyer-shipping are converted to NOK per row via the canonical money_minor_to_nok_minor (P133/P130-02 — previously an exponent-naive round(amount * rate)) before summing, the same reasoning purchase_spending_summary already uses for GPO across mixed-currency purchases. NSP/RRC/PUD read the already-frozen, already-exact columns directly.';
