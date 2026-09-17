-- P138 (ai_outputs/Claude_outputs/output_130.txt P130-15): create_sale's idempotency replay never
-- compared the replay's payload against the original request at all — unlike create_purchase
-- (P108/P111, D-121/D-122), which has always stored the full request as `idempotency_request` and
-- refused a same-key-different-payload replay with a named `idempotency-key-reuse` error.
-- create_sale's early check was only `select … where idempotency_key = p_idempotency_key; if found
-- return it` — a caller who retried the SAME key with EDITED line prices (a legitimate corrected
-- resubmission after what looked like a failed attempt) silently got the ORIGINAL, unedited sale
-- back with no indication anything was wrong. Reproduced locally (P138 pre-fix repro, isolated
-- stack): create_sale(key K, gross 20000) then create_sale(key K, gross 999900) returned the
-- original 20000 sale both times, no error.
--
-- The SAME gap also meant a genuine concurrent race (two calls with the same key, different
-- payload, both passing the early check before either commits) had no unique_violation exception
-- handler at all: the loser's own INSERT into `sales` hit `sales_user_idempotency_key_idx` and the
-- raw Postgres error ("duplicate key value violates unique constraint …") propagated straight to
-- the caller — reproduced locally 4/6 runs of a real two-session race (two different lots, so
-- neither call blocks on the other's lot lock; only the `sales` INSERT itself races).
-- create_purchase already handles exactly this shape (P108's nested BEGIN/EXCEPTION block); this
-- migration brings create_sale in line with it, not diverging from it (prompt §10).
--
-- THE FIX. Two additions, both copied from create_purchase's already-proven shape:
--   1. A new `idempotency_request jsonb` column on `sales` (additive — old rows read back NULL,
--      never treated as a match for a NEW request's key since keys are UUIDs and never reused
--      across requests). The early replay check now compares it via `IS DISTINCT FROM` and raises
--      `idempotency-key-reuse` on a material mismatch, exactly like create_purchase.
--   2. The insert-and-line-write block is wrapped in its own BEGIN/EXCEPTION so a `unique_violation`
--      on the `sales` INSERT (the concurrent-loser case) re-reads the winner's committed row instead
--      of leaking the raw constraint error — same payload -> the winner's result (or the same-shape
--      idempotency-key-reuse refusal on a genuine payload mismatch); no matching row at all (some
--      other, unrelated unique_violation) -> re-raised unchanged, never mistaken for this race
--      (P111 prompt §10's own "an unrelated unique_violation is re-raised" discipline).
--
-- Material equivalence excludes `notes` (D-122: notes are user-visible content the caller may
-- legitimately edit before retrying, not operational metadata) and includes every other financially
-- meaningful field: sold_on, currency, marketplace, fees/shipping-cost/shipping-charged, the FX
-- triple, and every line (lot_id, quantity, unit_gross_minor) in submitted order. Sale lines carry
-- no per-line notes field (unlike a purchase line's `lot_notes`), so no field is excluded from the
-- per-line jsonb the way create_purchase strips `lot_notes`.
--
-- FUNCTION_SIGNATURES_CHANGED=no: create_sale keeps its exact parameter list, defaults and return
-- type. CREATE OR REPLACE, no re-grant needed. OLD_CLIENT_COMPATIBILITY: p_idempotency_key was
-- already a required parameter before this migration (unlike purchase's optional key) — no existing
-- caller changes shape. A pre-P138 client keeps working unchanged; it simply now gets a named
-- refusal instead of a silent wrong answer on the narrow reuse/race path, and the same successful
-- result it always got on a genuine identical retry.

alter table public.sales
  add column idempotency_request jsonb;

comment on column public.sales.idempotency_request is
  'Full material request snapshot (P138/P130-15) captured at insert time, compared via IS DISTINCT FROM on replay to detect a same-key/different-payload reuse — same shape as purchases.idempotency_request (P108/P111). NULL on any row written before this migration; harmless, since a replay only ever matches its own request''s UUID key.';

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
  v_material jsonb;
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

  -- ── Idempotent replay BEFORE any validation or ledger write (mirrors create_purchase) ─────────
  v_material := jsonb_build_object(
    'sold_on', p_sold_on,
    'currency', p_currency,
    'marketplace', p_marketplace,
    'fees_minor', coalesce(p_fees_minor, 0),
    'shipping_cost_minor', coalesce(p_shipping_cost_minor, 0),
    'shipping_charged_minor', coalesce(p_shipping_charged_minor, 0),
    'fx_rate_to_nok', p_fx_rate_to_nok,
    'fx_rate_date', p_fx_rate_date,
    'fx_source', p_fx_source,
    'lines', (
      select jsonb_agg(elem order by ord)
      from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) with ordinality as t(elem, ord)
    )
  );

  select * into v_existing from public.sales
    where user_id = v_user_id and idempotency_key = p_idempotency_key;
  if v_existing.id is not null then
    if v_existing.idempotency_request is distinct from v_material then
      raise exception
        'idempotency-key-reuse: key % already belongs to a different sale request',
        p_idempotency_key;
    end if;
    -- D-122's same notes-preservation rule: notes are user-visible content, not operational
    -- metadata — a legitimate replay must not silently discard an edit made to notes before retry.
    if v_existing.notes is distinct from p_notes then
      update public.sales set notes = p_notes where id = v_existing.id returning * into v_existing;
    end if;
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

  -- ── All mutations inside one outer BEGIN/EXCEPTION block (mirrors create_purchase) ────────────
  -- Race window: two concurrent calls with the SAME idempotency key can both pass the early
  -- replay check above (neither has committed yet), lock DIFFERENT lots (no lot contention) and
  -- both reach this INSERT. The loser hits `sales_user_idempotency_key_idx`. Before this migration
  -- that raw unique_violation propagated to the caller unhandled (P130-15, reproduced locally 4/6
  -- runs of a real two-session race). The handler below re-reads the winner's row: identical
  -- material -> the winner's result, exactly as a sequential replay would see; different material
  -- -> the same named idempotency-key-reuse refusal as the sequential path, never a raw 23505.
  begin
    insert into public.sales (
      user_id, sold_on, marketplace, currency, gross_minor, fees_minor, shipping_cost_minor,
      shipping_charged_minor, net_proceeds_minor, fx_rate_to_nok, fx_rate_date, fx_source,
      net_proceeds_nok_minor, realized_result_nok_minor, proceeds_from_uncosted_nok_minor,
      notes, idempotency_key, idempotency_request
    ) values (
      v_user_id, p_sold_on, p_marketplace, p_currency, v_gross, coalesce(p_fees_minor, 0),
      coalesce(p_shipping_cost_minor, 0), coalesce(p_shipping_charged_minor, 0), v_net, v_fx_rate,
      coalesce(p_fx_rate_date, p_sold_on), coalesce(p_fx_source, 'manual'), v_net_nok,
      case when v_has_known then v_realized_sum else null end, v_uncosted_sum, p_notes,
      p_idempotency_key, v_material
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
  exception when unique_violation then
    select * into v_existing from public.sales
      where user_id = v_user_id and idempotency_key = p_idempotency_key;
    if v_existing.id is null then
      -- Not the idempotency race — some other unique_violation. Re-raise unchanged (P111 prompt
      -- §10 discipline: never mistake an unrelated constraint failure for this race).
      raise;
    end if;
    if v_existing.idempotency_request is distinct from v_material then
      raise exception
        'idempotency-key-reuse: key % already belongs to a different sale request',
        p_idempotency_key;
    end if;
    if v_existing.notes is distinct from p_notes then
      update public.sales set notes = p_notes where id = v_existing.id returning * into v_existing;
    end if;
    v_sale := v_existing;
  end;

  return v_sale;
end;
$$;

comment on function public.create_sale(
  date, text, jsonb, uuid, text, bigint, bigint, bigint, numeric, date, public.fx_source, text
) is
  'Atomic multi-line sale write: one sale, its lines (each disposing from exactly one explicitly-chosen lot), the disposal ledger rows, and the frozen cost basis/realized result each line is entitled to. p_idempotency_key is required: a replay with the same (user, key) and the same material request returns the original sale, updating only p_notes if it differs (P138/D-122) — the financial rows never change on replay. A same-key replay with a materially different request (anything but notes) is refused with a named idempotency-key-reuse error, sequentially or under a real concurrent race (P138/P130-15) — never a raw unique_violation. P133 (20260915120000) made the NOK conversion exponent-aware (P130-02). See FINANCIAL_MODEL.md §2.2/§4.5, DATA_MODEL.md §5.7/§5.11.';
