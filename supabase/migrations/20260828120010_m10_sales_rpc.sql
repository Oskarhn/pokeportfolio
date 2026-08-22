-- M10: Sales and History — the transactional write surface (FINANCIAL_MODEL.md §2.2/§2.6/§4.5,
-- DATA_MODEL.md §5.7/§5.11). Mirrors M8's purchase-ledger architecture in every way but one: caller
-- derived from auth.uid() alone (no p_user_id argument to forge), one function call is one
-- transaction, largest-remainder allocation reused/extended from src/domain/allocation.ts's SQL
-- port (20260824120010) — but SECURITY DEFINER, not INVOKER.
--
-- SECURITY DEFINER, deliberately (prompt §105's named exception, triggered by prompt §107).
-- §107 lists frozen basis fields, frozen NOK fields, allocated fields and realized_result as
-- columns "the browser" must never be able to forge — not "the RPC checks them," an actual
-- inability. M8's purchases/acquisition_lots accepted a narrower risk (a SECURITY INVOKER RPC needs
-- authenticated to hold UPDATE on every column it writes, which means a direct PATCH to one's own
-- row can desync purchases.total_nok_minor from its own line items — self-directed forgery of a
-- user's own private ledger, never a cross-tenant issue). §107 asks for something stronger for
-- sales specifically: cost_basis_at_sale_nok_minor, realized_result_nok_minor,
-- proceeds_from_uncosted_nok_minor and every allocated_*/net_proceeds_* column must be
-- *unreachable* by any direct write, not merely policed by a CHECK constraint after the fact.
-- SECURITY DEFINER is what makes that possible: authenticated holds no INSERT/UPDATE grant at all
-- on sales/sale_lines/lot_disposals (20260828120000's RLS/grants section) — every write happens
-- exclusively inside these three functions, which run with the owning role's privileges rather than
-- the caller's. What replaces RLS as the authorization boundary is the same discipline these
-- functions already had to have anyway: every SELECT/UPDATE is explicitly filtered by
-- `user_id = v_user_id` where `v_user_id := auth.uid()`, checked before any statement that touches
-- a caller-supplied id (mirrored in tests/authorization/m10_sales.test.ts). "No p_user_id argument"
-- and "derive the caller from auth.uid()" — the parts of §105 that actually guard against
-- impersonation — are unchanged; only the INVOKER/DEFINER choice moves, and only because §107 names
-- the specific, narrower thing INVOKER cannot provide.
--
-- LOT SELECTION IS EXPLICIT (prompt §10-11). create_sale never chooses a lot on the caller's
-- behalf — every line names the exact lot_id it disposes from. FIFO is a client-side *suggestion*
-- only (src/domain/sales.ts's suggestFifoOrder, added alongside the UI in this milestone); nothing
-- server-side ever substitutes an average, cheapest or FIFO-selected lot for what the caller sent.
--
-- COST BASIS FREEZE AND THE RESIDUAL RULE (prompt §23/§26-27, DECISIONS.md D-060). For a lot with
-- cost_basis_state = 'known', the frozen `cost_basis_at_sale_nok_minor` for a disposal of `q` units
-- is:
--
--   adjustments_total_nok = Σ lot_cost_adjustments.amount_nok_minor for this lot
--   adj_per_unit           = adjustments_total_nok / lot.quantity          (floor)
--   adj_residual            = adjustments_total_nok - adj_per_unit * lot.quantity
--   basis                   = (lot.unit_cost_basis_nok_minor + adj_per_unit) * q
--                             + (lot.residual_nok_minor + adj_residual)      -- only if this
--                                                                             -- disposal exhausts
--                                                                             -- the lot
--
-- "Exhausts" means quantity_remaining - q = 0 for this disposal. Because a lot's quantity_remaining
-- decreases monotonically and can reach zero at most once (a lot cannot be un-disposed except by
-- voiding the disposal that emptied it — which restores quantity_remaining above zero again, so a
-- second exhausting event is a distinct later disposal, not a double-count), summing `basis` over
-- every disposal a lot will ever have reproduces the lot's exact original cost basis:
--   Σ (unit_cost_basis_nok_minor + adj_per_unit) * q_i  =  (unit_cost_basis_nok_minor + adj_per_unit) * quantity
--     (since Σ q_i = quantity across every eventual disposal)
--   + residual_nok_minor + adj_residual, added exactly once, at whichever disposal empties the lot
--   = quantity * unit_cost_basis_nok_minor + residual_nok_minor         (the lot's exact basis)
--     + quantity * adj_per_unit + adj_residual                          (the adjustments' exact total)
-- No minor unit lost, none duplicated, deterministic regardless of how many partial sales happen
-- or in what order — tests/db/m10_sales.test.ts's residual/adjustment-division cases prove this
-- directly against a lot sold across multiple separate sales.
--
-- cost_basis_state <> 'known' (unallocated_opening, not_paid, unknown, trade_in) always freezes
-- cost_basis_at_sale_nok_minor = NULL. The sale is still recorded — proceeds are real regardless of
-- whether the item's cost basis is known — and contributes to PUD, never a fabricated RRC.
--
-- ALLOCATION. Sale-level fees/outbound-shipping/buyer-shipping are allocated across lines pro rata
-- by gross (line_gross_minor), largest remainder, same algorithm and same tie-break as purchases.
-- The NOK conversion of net proceeds is ALSO weighted by gross rather than by each line's own net
-- (which can be negative — a fee-heavy line can genuinely lose money, prompt §109/§110) —
-- allocate_largest_remainder rejects a negative weight outright, and gross is always >= 0 by
-- construction, so weighting by gross sidesteps that while staying deterministic and auditable.
-- allocate_largest_remainder_signed below is what makes a negative sale-level total (an
-- overall-loss sale) allocable at all — the existing unsigned allocator rejects a negative total.

-- ── 0. A signed wrapper around the existing (unsigned) largest-remainder allocator ────────────────
-- Delegates entirely to allocate_largest_remainder: for a negative total T, computes shares for
-- -T against the same weights and negates them. Sum of the negated shares is exactly T — the same
-- exactness guarantee (invariant F6), just extended to a total that can be negative. Weights
-- themselves must still be non-negative (unchanged requirement) — only the total's sign changes.
create or replace function public.allocate_largest_remainder_signed(p_total bigint, p_weights bigint[])
returns bigint[]
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_shares bigint[];
  v_i int;
begin
  if p_total >= 0 then
    return public.allocate_largest_remainder(p_total, p_weights);
  end if;
  v_shares := public.allocate_largest_remainder(-p_total, p_weights);
  for v_i in 1 .. coalesce(array_length(v_shares, 1), 0) loop
    v_shares[v_i] := -v_shares[v_i];
  end loop;
  return v_shares;
end;
$$;

-- ── 1. create_sale ───────────────────────────────────────────────────────────────────────────────
-- p_lines: jsonb array of {lot_id, quantity, unit_gross_minor}. Each lot_id may appear at most once
-- (a repeat is rejected — combine into one line with a larger quantity instead, keeping "one line
-- per lot" an actual invariant rather than a convention).
--
-- CONCURRENCY (prompt §32/§94). Every referenced lot is locked with SELECT ... FOR UPDATE, in
-- ascending lot_id order across the whole call (deadlock avoidance when two concurrent multi-line
-- sales touch an overlapping lot set) — not in the order the caller happened to list them. Once
-- locked, quantity_remaining is re-checked against the live row, not any value the caller might
-- have cached client-side. Two concurrent attempts to sell the same lot's last unit serialize on
-- that lock; the second transaction sees the first's committed disposal (via the D1 trigger,
-- 20260828120000) and fails its own quantity check cleanly.
--
-- IDEMPOTENCY (prompt §49). p_idempotency_key is required — the caller generates one fresh UUID
-- per sale-builder session and resends the same value on any retry. A replay with a key that
-- already produced a sale returns that sale unchanged rather than creating a second one; this check
-- runs before any validation, so a retry of an otherwise-invalid request also replays cleanly once
-- the first attempt has actually succeeded.
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
  v_net_nok := round(v_net::numeric * v_fx_rate)::bigint;

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
  'Atomic multi-line sale write: one sale, its lines (each disposing from exactly one explicitly-chosen lot), the disposal ledger rows, and the frozen cost basis/realized result each line is entitled to. See FINANCIAL_MODEL.md §2.2/§4.5, DATA_MODEL.md §5.7/§5.11.';

-- ── 2. update_sale — the safe-edit path ─────────────────────────────────────────────────────────
-- Scope, deliberate (prompt §50-51's explicit fallback): recomputes sale-level fields and each
-- EXISTING line's unit_gross_minor, and therefore every allocation and proceeds figure downstream
-- of it — but never lot_id, quantity, or cost_basis_at_sale_nok_minor. Changing which lot or how
-- many units were sold needs a real reversal of the disposal ledger, which prompt §51 explicitly
-- allows deferring in favour of "void the incorrect sale, record a corrected one" — the same
-- guidance UX_FLOWS.md already gives for a bigger purchase mistake. This keeps update_sale exactly
-- as safe as update_purchase: no line added or removed, no lot touched, nothing frozen rewritten.
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
  v_net_nok := round(v_net::numeric * v_fx_rate)::bigint;

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
  'Recomputes a sale''s allocations and every existing line''s proceeds atomically from corrected sale-level charges/prices. Cannot add, remove or repoint lines, and never rewrites a frozen cost_basis_at_sale_nok_minor.';

-- ── 3. void_sale ─────────────────────────────────────────────────────────────────────────────────
-- Voids the sale and reverses every disposal it produced, atomically. The D1 trigger
-- (recompute_lot_quantity_remaining, fired by the UPDATE below) restores quantity_remaining on
-- every affected lot in the same transaction — prompt §52-54/§92.
create or replace function public.void_sale(p_sale_id uuid, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_existing public.sales;
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
  'Voids a whole sale and reverses every disposal it produced, atomically. Already-voided is a named error (prompt §93), never a silent no-op that could double-restore quantity.';

-- ── 4. sales_summary — the headline aggregate, one query ────────────────────────────────────────
-- gross/fees/outbound-shipping/buyer-shipping are converted to NOK per row (round(amount * that
-- row's own frozen fx_rate_to_nok)) before summing, the same reasoning purchase_spending_summary
-- already uses for GPO across mixed-currency purchases — these four are presentational NOK
-- equivalents for the summary view, not a separately frozen ledger figure the way
-- net_proceeds_nok_minor is. NSP/RRC/PUD read the already-frozen, already-exact columns directly.
-- Money returned as text — same bigint/PostgREST precision boundary as purchase_spending_summary.
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
    coalesce((select sum(round(s.gross_minor::numeric * s.fx_rate_to_nok))
              from public.sales s where s.user_id = auth.uid() and s.voided_at is null), 0)::text,
    coalesce((select sum(round(s.fees_minor::numeric * s.fx_rate_to_nok))
              from public.sales s where s.user_id = auth.uid() and s.voided_at is null), 0)::text,
    coalesce((select sum(round(s.shipping_cost_minor::numeric * s.fx_rate_to_nok))
              from public.sales s where s.user_id = auth.uid() and s.voided_at is null), 0)::text,
    coalesce((select sum(round(s.shipping_charged_minor::numeric * s.fx_rate_to_nok))
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

-- ── 5. Grants ────────────────────────────────────────────────────────────────────────────────────
revoke execute on function public.allocate_largest_remainder_signed(bigint, bigint[]) from public;
revoke execute on function public.create_sale(
  date, text, jsonb, uuid, text, bigint, bigint, bigint, numeric, date, public.fx_source, text
) from public;
revoke execute on function public.update_sale(
  uuid, date, text, jsonb, text, bigint, bigint, bigint, numeric, date, public.fx_source, text
) from public;
revoke execute on function public.void_sale(uuid, text) from public;
revoke execute on function public.sales_summary() from public;

grant execute on function public.allocate_largest_remainder_signed(bigint, bigint[]) to authenticated;
grant execute on function public.create_sale(
  date, text, jsonb, uuid, text, bigint, bigint, bigint, numeric, date, public.fx_source, text
) to authenticated;
grant execute on function public.update_sale(
  uuid, date, text, jsonb, text, bigint, bigint, bigint, numeric, date, public.fx_source, text
) to authenticated;
grant execute on function public.void_sale(uuid, text) to authenticated;
grant execute on function public.sales_summary() to authenticated;
