-- P209 / D-209: cost is conserved for arbitrary sale and opening void sequences.
--
-- THE DEFECT (found by the P199 reconciliation oracle, pinned there as a known limitation). D-060
-- hands a lot's residual (R = C - q * floor(C / q), plus the adjustment remainder) to the disposal
-- that exhausts the lot, decided and FROZEN at creation time. Nothing ever re-asked the question
-- when a disposal was voided. After an out-of-order void the same R sat in two places:
--
--   lot 5 x 100 + 1 (C = 501): sell 4 (frozen 400), sell 1 (exhausts, frozen 101), void the first.
--   The lot shows 4 units and the snapshot said 4 x 100 + R = 401; the live sale already holds the
--   R inside its 101. 401 + 101 = 502 against a purchase cost of 501.
--
-- and, in the other direction, a second exhausting disposal froze R again (sell 3, sell 2 [201],
-- void the 3, sell 3 [301]: 502). A backdated exhausting sale had the same effect on the days before
-- it. The error is bounded by R (< the lot's quantity in minor units); no money is created, but the
-- remaining cost, Home's cost of inventory and unrealized result, and the realized result of the
-- second exhausting disposal were off by it.
--
-- THE FIX (smallest that restores F17, FINANCIAL_MODEL.md section 4.3): record on the disposal
-- whether it froze the residual (lot_disposals.consumed_lot_residual). A disposal that exhausts the
-- lot takes the residual only if no live disposal of the lot already carries it. The residual is
-- therefore on exactly one of: the lot, or one live disposal. Voiding the carrying disposal puts it
-- back on the lot automatically (the flag lives on the voided row). No frozen value of an existing
-- sale or opening is rewritten, and a sequence that never voids out of order produces byte-identical
-- results to before.
--
-- Changed (CREATE OR REPLACE, signatures, ACLs and comments unchanged unless stated):
--   create_sale, create_opening, reconcile_opening_cost  decide and record the flag
--   rebuild_portfolio_snapshots                           the snapshot lot cost drops R from the day
--                                                         a live carrier's disposed_on is reached
--   list_opening_sources                                  the preview exhaustion residual is 0 when
--                                                         carried; ALSO fixed: the effective unit
--                                                         basis and exhaustion residual were
--                                                         NUMERIC text (e.g. '1.00000000000000000000')
--                                                         because sum(bigint) is numeric, which the
--                                                         client's canonical-integer parser refuses
--
-- BACKFILL. Existing live disposals are flagged when their frozen basis equals exactly what a
-- carrying disposal would have frozen: (unit + floor(adj / q)) * disposal quantity + residual +
-- adjustment remainder, with residual + remainder > 0. Lots with no residual are untouched.
-- Lots where two live disposals both carry R (the second direction above) are flagged on both; their
-- frozen bases cannot be corrected without rewriting realized results, which is a product decision
-- (D-209 lists it), so scripts/lot-cost-conservation.sql reports them read-only.
--
-- portfolio_snapshots is a rebuildable cache (D-070): every user whose snapshots differ from the
-- P199 rule is queued for a rebuild at the end of this file.

alter table public.lot_disposals
  add column consumed_lot_residual boolean not null default false;

comment on column public.lot_disposals.consumed_lot_residual is
  'D-209: true when this disposal froze the lot''s exhaustion residual (residual_nok_minor + adjustment remainder) into its cost basis. At most one live disposal per lot carries it unless legacy data says otherwise; voiding that disposal returns the residual to the lot.';

update public.lot_disposals ld
   set consumed_lot_residual = true
  from public.acquisition_lots l
 where l.id = ld.lot_id
   and ld.voided_at is null
   and l.cost_basis_state = 'known'
   and l.unit_cost_basis_nok_minor is not null
   and l.quantity > 0
   and coalesce(
         (select sl.cost_basis_at_sale_nok_minor from public.sale_lines sl where sl.id = ld.sale_line_id),
         ld.cost_basis_at_disposal_nok_minor
       ) = (
         l.unit_cost_basis_nok_minor
         + coalesce((select sum(a.amount_nok_minor) from public.lot_cost_adjustments a where a.lot_id = l.id), 0)::bigint / l.quantity
       ) * ld.quantity
       + l.residual_nok_minor
       + (coalesce((select sum(a.amount_nok_minor) from public.lot_cost_adjustments a where a.lot_id = l.id), 0)::bigint
          - (coalesce((select sum(a.amount_nok_minor) from public.lot_cost_adjustments a where a.lot_id = l.id), 0)::bigint / l.quantity) * l.quantity)
   and l.residual_nok_minor
       + (coalesce((select sum(a.amount_nok_minor) from public.lot_cost_adjustments a where a.lot_id = l.id), 0)::bigint
          - (coalesce((select sum(a.amount_nok_minor) from public.lot_cost_adjustments a where a.lot_id = l.id), 0)::bigint / l.quantity) * l.quantity) > 0;


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
  v_residual_taken boolean;
  v_carries boolean[] := '{}';
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
      -- D-209: the residual rides on the first LIVE disposal that exhausts the lot. If a live
      -- disposal already carries it (an earlier sale was voided out of order, so the units came
      -- back while the exhausting sale stayed), this disposal must not freeze it a second time.
      -- The lot row is locked above, so this read cannot race another disposal of the same lot.
      select exists (
        select 1 from public.lot_disposals ld
        where ld.lot_id = v_lot.id and ld.voided_at is null and ld.consumed_lot_residual
      ) into v_residual_taken;
      v_exhausts := (v_lot.quantity_remaining - v_quantities[v_idx]) = 0 and not v_residual_taken;
      v_carries[v_idx] := v_exhausts;
      v_basis_component := (v_lot.unit_cost_basis_nok_minor + v_adj_per_unit) * v_quantities[v_idx];
      if v_exhausts then
        v_basis_component := v_basis_component + v_lot.residual_nok_minor + v_adj_residual;
      end if;
      v_bases_nok[v_idx] := v_basis_component;
    else
      v_bases_nok[v_idx] := null;
      v_carries[v_idx] := false;
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

      insert into public.lot_disposals (
        lot_id, user_id, kind, quantity, disposed_on, sale_line_id, consumed_lot_residual
      )
      values (
        v_lot_ids[v_idx], v_user_id, 'sale', v_quantities[v_idx], p_sold_on, v_sale_line_id,
        coalesce(v_carries[v_idx], false)
      );
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



create or replace function public.create_opening(
  p_source_lot_id uuid,
  p_quantity int,
  p_opened_on date default current_date,
  p_tracking_completeness public.opening_tracking default 'all_cards',
  p_pulls jsonb default null,
  p_bulk_remainder_estimate_nok_minor bigint default null,
  p_bulk_remainder_count int default null,
  p_notes text default null,
  -- Client-generated submission identity (P53 §5). Same key + same material request ⇒ the SAME
  -- committed opening comes back; same key + different material ⇒ named reuse error.
  p_idempotency_key uuid default null,
  -- Set only by create_opening_from_provisional (validated there AND re-validated here):
  -- the just-created provisional purchase whose lot is exactly p_source_lot_id.
  p_provisional_purchase_id uuid default null
)
returns public.openings
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_opening public.openings;
  v_replay public.openings;
  v_lot record;
  v_adjustments_total_nok bigint;
  v_adj_per_unit bigint;
  v_adj_residual bigint;
  v_exhausts boolean;
  v_residual_taken boolean;
  v_basis bigint;
  v_pull jsonb;
  v_pull_count int;
  v_idx int;
  v_card_variant_id uuid;
  v_manual_card_id uuid;
  v_identity_count int;
  v_quantity int;
  v_condition public.card_condition;
  v_storage_location_id uuid;
  v_holding_id uuid;
begin
  if v_user_id is null then
    raise exception 'not authenticated';
  end if;
  if p_source_lot_id is null then
    raise exception 'p_source_lot_id is required';
  end if;
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'p_quantity must be a positive integer';
  end if;
  if p_opened_on is null then
    raise exception 'p_opened_on is required';
  end if;
  if p_tracking_completeness is null then
    raise exception 'p_tracking_completeness is required';
  end if;

  -- ── Idempotent replay (P53 §5/§6) ──────────────────────────────────────────────────────────
  -- A committed-but-unanswered request must return the SAME opening on retry, never a second
  -- one. The key is only honored when the MATERIAL request matches (lot, quantity, business
  -- date) — the fields a duplicate submission could not legitimately change. Anything else
  -- reusing the key is refused loudly instead of silently returning an unrelated operation.
  if p_idempotency_key is not null then
    select * into v_replay from public.openings
      where user_id = v_user_id and idempotency_key = p_idempotency_key;
    if v_replay.id is not null then
      if v_replay.source_lot_id <> p_source_lot_id
         or v_replay.quantity_opened <> p_quantity
         or v_replay.opened_on <> p_opened_on then
        raise exception
          'idempotency-key-reuse: key % already belongs to a different opening request',
          p_idempotency_key;
      end if;
      return v_replay;
    end if;
  end if;

  -- Bulk remainder is both-or-neither (the table CHECK is the backstop; this is the readable error).
  if (p_bulk_remainder_estimate_nok_minor is null) <> (p_bulk_remainder_count is null) then
    raise exception
      'bulk remainder requires both estimate and count, or neither — never silently one-sided';
  end if;
  if p_bulk_remainder_estimate_nok_minor is not null
     and (p_bulk_remainder_estimate_nok_minor < 0 or p_bulk_remainder_count <= 0) then
    raise exception 'bulk remainder estimate must be >= 0 with a positive count';
  end if;

  -- Provisional link consistency: the named purchase must be the caller's own live
  -- provisional_opening purchase whose line produced EXACTLY this source lot.
  if p_provisional_purchase_id is not null then
    if not exists (
      select 1
      from public.purchases p
      join public.purchase_lines pl on pl.purchase_id = p.id
      join public.acquisition_lots al on al.purchase_line_id = pl.id
      where p.id = p_provisional_purchase_id
        and p.user_id = v_user_id
        and p.origin = 'provisional_opening'
        and p.voided_at is null
        and al.id = p_source_lot_id
    ) then
      raise exception 'provisional purchase does not match this opening''s source lot';
    end if;
  end if;

  -- Lock the source lot, then validate against the LIVE row (prompt §11: frozen facts only).
  select l.id, l.user_id, l.cost_basis_state, l.unit_cost_basis_nok_minor, l.residual_nok_minor,
         l.quantity, l.quantity_remaining, l.voided_at,
         h.holding_kind, h.sealed_product_id
    into v_lot
  from public.acquisition_lots l
  join public.holdings h on h.id = l.holding_id
  where l.id = p_source_lot_id and l.user_id = v_user_id
  for update of l;

  -- No existence oracle: foreign, missing or voided all fail identically.
  if v_lot.id is null or v_lot.voided_at is not null then
    raise exception 'source lot is unavailable';
  end if;
  if v_lot.holding_kind <> 'sealed' then
    raise exception 'openings consume sealed lots only';
  end if;
  if v_lot.quantity_remaining < p_quantity then
    raise exception 'only % of the selected lot remain available, but % were requested',
      v_lot.quantity_remaining, p_quantity;
  end if;

  -- Freeze the exact consumed basis (see the migration header). NULL propagates as unknown cost.
  if v_lot.cost_basis_state = 'known' then
    select coalesce(sum(amount_nok_minor), 0) into v_adjustments_total_nok
      from public.lot_cost_adjustments where lot_id = v_lot.id;
    v_adj_per_unit := v_adjustments_total_nok / v_lot.quantity;
    v_adj_residual := v_adjustments_total_nok - v_adj_per_unit * v_lot.quantity;
    -- D-209: same rule as create_sale. The lot row is locked above.
    select exists (
      select 1 from public.lot_disposals ld
      where ld.lot_id = v_lot.id and ld.voided_at is null and ld.consumed_lot_residual
    ) into v_residual_taken;
    v_exhausts := (v_lot.quantity_remaining - p_quantity) = 0 and not v_residual_taken;
    v_basis := (v_lot.unit_cost_basis_nok_minor + v_adj_per_unit) * p_quantity;
    if v_exhausts then
      v_basis := v_basis + v_lot.residual_nok_minor + v_adj_residual;
    end if;
  else
    v_basis := null;
  end if;

  -- Insert the opening. Two concurrent retries of one request can both pass the replay check
  -- before either commits; the composite unique index (user_id, idempotency_key) is the
  -- arbiter — the loser re-reads the winner's row and returns it (still verified against the
  -- material request), so exactly one opening ever exists for a key.
  begin
    insert into public.openings (
      user_id, opened_on, source_lot_id, sealed_product_id, quantity_opened,
      cost_source, cost_nok_minor, tracking_completeness,
      bulk_remainder_estimate_nok_minor, bulk_remainder_count,
      provisional_purchase_id, notes, idempotency_key
    ) values (
      v_user_id, p_opened_on, p_source_lot_id, v_lot.sealed_product_id, p_quantity,
      case when v_basis is null then 'unknown' else 'from_lot' end::public.opening_cost_source,
      v_basis, p_tracking_completeness,
      p_bulk_remainder_estimate_nok_minor, p_bulk_remainder_count,
      p_provisional_purchase_id, p_notes,
      coalesce(p_idempotency_key, gen_random_uuid())
    )
    returning * into v_opening;
  exception when unique_violation then
    -- Without a client key the index cannot be what fired (fresh random uuid) — re-raise.
    if p_idempotency_key is null then
      raise;
    end if;
    select * into v_replay from public.openings
      where user_id = v_user_id and idempotency_key = p_idempotency_key;
    if v_replay.id is null
       or v_replay.source_lot_id <> p_source_lot_id
       or v_replay.quantity_opened <> p_quantity
       or v_replay.opened_on <> p_opened_on then
      raise;
    end if;
    return v_replay;
  end;

  -- The consumption IS a disposal row: D1 decrements quantity_remaining, the M12 invalidation
  -- triggers dirty history from disposed_on, and the frozen share lands on the existing column.
  insert into public.lot_disposals (
    lot_id, user_id, kind, quantity, disposed_on, opening_id, cost_basis_at_disposal_nok_minor,
    consumed_lot_residual
  ) values (
    v_lot.id, v_user_id, 'opened', p_quantity, p_opened_on, v_opening.id, v_basis,
    coalesce(v_exhausts, false)
  );

  -- Pulled-card lots (prompt §14). One lot per input item; holdings consolidate via
  -- holdings_identity, provenance stays opening-specific. No cost parameters exist here at all —
  -- origin='opening' + unallocated_opening makes a costed pull structurally unrepresentable.
  v_pull_count := coalesce(jsonb_array_length(p_pulls), 0);
  for v_idx in 0 .. v_pull_count - 1 loop
    v_pull := p_pulls -> v_idx;
    v_card_variant_id := nullif(v_pull ->> 'card_variant_id', '')::uuid;
    v_manual_card_id := nullif(v_pull ->> 'manual_card_id', '')::uuid;
    v_identity_count := (v_card_variant_id is not null)::int + (v_manual_card_id is not null)::int;
    if v_identity_count <> 1 then
      raise exception 'pull %: exactly one of card_variant_id / manual_card_id is required', v_idx;
    end if;
    v_quantity := (v_pull ->> 'quantity')::int;
    if v_quantity is null or v_quantity <= 0 then
      raise exception 'pull %: quantity must be a positive integer', v_idx;
    end if;
    v_condition := nullif(v_pull ->> 'condition', '')::public.card_condition;
    if v_condition is null then
      raise exception 'pull %: condition is required for a raw card', v_idx;
    end if;
    v_storage_location_id := nullif(v_pull ->> 'storage_location_id', '')::uuid;

    -- Explicit ownership checks (DEFINER bodies do not inherit RLS): a forged cross-tenant id
    -- fails identically to a missing one — no existence oracle either way.
    if v_manual_card_id is not null and not exists (
      select 1 from public.manual_card_definitions
      where id = v_manual_card_id and user_id = v_user_id
    ) then
      raise exception 'pull %: manual card not found or not accessible', v_idx;
    end if;
    if v_card_variant_id is not null and not exists (
      select 1 from public.card_variants where id = v_card_variant_id
    ) then
      raise exception 'pull %: card variant not found', v_idx;
    end if;
    if v_storage_location_id is not null and not exists (
      select 1 from public.storage_locations
      where id = v_storage_location_id and user_id = v_user_id
    ) then
      raise exception 'pull %: storage location not found or not accessible', v_idx;
    end if;

    -- Find-or-create the raw-card holding, race-safe via holdings_identity (M6 pattern).
    begin
      insert into public.holdings (
        user_id, holding_kind, card_variant_id, manual_card_id,
        condition, grading_state, grader, grade, cert_number, is_favorite
      ) values (
        v_user_id, 'raw_card', v_card_variant_id, v_manual_card_id,
        v_condition, 'raw', null, null, null, false
      )
      returning id into v_holding_id;
    exception when unique_violation then
      select id into v_holding_id
        from public.holdings
        where user_id = v_user_id
          and holding_kind = 'raw_card'
          and coalesce(card_variant_id, sealed_product_id, manual_card_id)
              = coalesce(v_card_variant_id, v_manual_card_id)
          and coalesce(public.card_condition_to_text(condition), '')
              = coalesce(public.card_condition_to_text(v_condition), '')
          and grading_state = 'raw'
          and coalesce(public.grader_to_text(grader), '') = ''
          and coalesce(grade, -1) = -1
          and deleted_at is null;
      if v_holding_id is null then
        raise;
      end if;
    end;

    insert into public.acquisition_lots (
      holding_id, user_id, origin, cost_basis_state, acquired_on,
      quantity, quantity_remaining, opening_id, storage_location_id, notes
    ) values (
      v_holding_id, v_user_id, 'opening', 'unallocated_opening', p_opened_on,
      v_quantity, v_quantity, v_opening.id, v_storage_location_id,
      v_pull ->> 'notes'
    );
  end loop;

  return v_opening;
end;
$$;



create or replace function public.reconcile_opening_cost(p_opening_id uuid, p_real_source_lot_id uuid)
returns public.openings
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_opening public.openings;
  -- P56 §3 (P54 finding H1): captured BEFORE anything is repointed. This is the provisional
  -- lot create_opening_from_provisional auto-created and consumed; once its consumption is
  -- retired below, D1 would restore it to full availability while its purchase is being
  -- voided — live sealed inventory citing money that just left the ledger. It is voided in
  -- the same transaction instead.
  v_provisional_source_lot_id uuid;
  v_lot record;
  v_adjustments_total_nok bigint;
  v_adj_per_unit bigint;
  v_adj_residual bigint;
  v_basis bigint;
  v_takes_residual boolean := false;
begin
  if v_user_id is null then
    raise exception 'not authenticated';
  end if;

  select * into v_opening from public.openings
    where id = p_opening_id and user_id = v_user_id
  for update;

  if v_opening.id is null then
    raise exception 'opening % not found', p_opening_id;
  end if;
  v_provisional_source_lot_id := v_opening.source_lot_id;
  if v_opening.voided_at is not null then
    raise exception 'opening % is voided and cannot be reconciled', p_opening_id;
  end if;
  if v_opening.provisional_purchase_id is null then
    raise exception 'opening % has no provisional purchase to reconcile', p_opening_id;
  end if;
  if v_opening.reconciled_at is not null then
    raise exception 'opening % is already reconciled', p_opening_id;
  end if;

  -- The real lot: owned, live, sealed, the SAME product, known basis, enough remaining units —
  -- and it must belong to a LIVE purchase that is not itself a provisional_opening purchase
  -- (P56 §6 / P55 finding F55-10). Reconciling provisional → provisional would just trade one
  -- self-annihilating world for another and defeat the operation's purpose; reconciling onto a
  -- voided purchase's lot would freeze basis from money outside the ledger. The join filters
  -- make every such target indistinguishable from foreign/missing ('source lot is unavailable')
  -- — no existence oracle.
  select l.id, l.cost_basis_state, l.unit_cost_basis_nok_minor, l.residual_nok_minor,
         l.quantity, l.quantity_remaining, l.voided_at,
         h.sealed_product_id, h.holding_kind,
         pl.purchase_id as real_purchase_id
    into v_lot
  from public.acquisition_lots l
  join public.holdings h on h.id = l.holding_id
  join public.purchase_lines pl on pl.id = l.purchase_line_id
  join public.purchases p on p.id = pl.purchase_id
   and p.user_id = v_user_id
   and p.voided_at is null
   and p.origin <> 'provisional_opening'
  where l.id = p_real_source_lot_id and l.user_id = v_user_id
  for update of l;

  if v_lot.id is null or v_lot.voided_at is not null then
    raise exception 'source lot is unavailable';
  end if;
  if v_lot.holding_kind <> 'sealed' or v_lot.sealed_product_id <> v_opening.sealed_product_id then
    raise exception 'reconciliation target must be a live lot of the same sealed product';
  end if;
  if v_lot.cost_basis_state <> 'known' then
    raise exception 'reconciliation target must carry a known cost basis';
  end if;
  if v_lot.quantity_remaining < v_opening.quantity_opened then
    raise exception 'only % of the target lot remain available, but % are needed',
      v_lot.quantity_remaining, v_opening.quantity_opened;
  end if;

  -- Exact consumed share of the REAL lot (same formula as everywhere else).
  select coalesce(sum(amount_nok_minor), 0) into v_adjustments_total_nok
    from public.lot_cost_adjustments where lot_id = v_lot.id;
  v_adj_per_unit := v_adjustments_total_nok / v_lot.quantity;
  v_adj_residual := v_adjustments_total_nok - v_adj_per_unit * v_lot.quantity;
  v_basis := (v_lot.unit_cost_basis_nok_minor + v_adj_per_unit) * v_opening.quantity_opened;
  -- D-209: the residual goes to this consumption only if it exhausts the lot AND no live disposal
  -- of the real lot already carries it (the real lot is locked above).
  v_takes_residual := (v_lot.quantity_remaining - v_opening.quantity_opened) = 0
    and not exists (
      select 1 from public.lot_disposals ld
      where ld.lot_id = v_lot.id and ld.voided_at is null and ld.consumed_lot_residual
    );
  if v_takes_residual then
    v_basis := v_basis + v_lot.residual_nok_minor + v_adj_residual;
  end if;

  -- Retire the provisional consumption FIRST (unique live-per-opening index + D1 restore),
  -- then retire the provisional lot itself, then write the repointed consumption.
  update public.lot_disposals
    set voided_at = now()
    where opening_id = v_opening.id and voided_at is null;

  -- P56 §4 (P54 finding H1): D1 has just restored the provisional lot to full availability —
  -- but its purchase is being voided in this same transaction, so letting it live would create
  -- known-basis sealed inventory citing money that no longer counts. VOID it here. Historical
  -- rows are retained (never hard-deleted): the voided purchase line, the voided lot and the
  -- voided consumption remain exactly the audit trail the reconciliation columns point at.
  -- This is deliberately DIFFERENT from void_opening's policy: reconciliation REPLACES the
  -- provisional purchase with the real one, so the provisional world must annihilate as a
  -- unit — purchase, lot and consumption together.
  update public.acquisition_lots
    set voided_at = now()
    where id = v_provisional_source_lot_id
      and user_id = v_user_id
      and voided_at is null;

  insert into public.lot_disposals (
    lot_id, user_id, kind, quantity, disposed_on, opening_id, cost_basis_at_disposal_nok_minor,
    consumed_lot_residual
  ) values (
    v_lot.id, v_user_id, 'opened', v_opening.quantity_opened, v_opening.opened_on,
    v_opening.id, v_basis, v_takes_residual
  );

  update public.openings set
    source_lot_id = v_lot.id,
    cost_source = 'from_lot',
    cost_nok_minor = v_basis,
    reconciled_at = now(),
    reconciled_to_purchase_id = v_lot.real_purchase_id
  where id = v_opening.id
  returning * into v_opening;

  -- The provisional purchase leaves every calculation (retained, voided — never deleted).
  update public.purchases
    set voided_at = now()
    where id = v_opening.provisional_purchase_id
      and user_id = v_user_id
      and voided_at is null;

  return v_opening;
end;
$$;



create or replace function public.list_opening_sources(p_holding_id uuid default null)
returns table (
  lot_id uuid,
  holding_id uuid,
  sealed_product_id uuid,
  product_name text,
  product_type text,
  image_url text,
  acquired_on date,
  quantity_available int,
  cost_known boolean,
  effective_unit_basis_nok_minor text,
  exhaustion_residual_nok_minor text,
  purchase_id uuid,
  purchase_origin text,
  purchased_on date
)
language sql
stable
security invoker
set search_path = ''
as $$
  with adjustments as materialized (
    select a.lot_id, sum(a.amount_nok_minor)::bigint as total_nok
    from public.lot_cost_adjustments a
    group by a.lot_id
  )
  select l.id,
         l.holding_id,
         h.sealed_product_id,
         sp.name,
         sp.product_type::text,
         sp.image_url,
         l.acquired_on,
         l.quantity_remaining,
         (l.cost_basis_state = 'known'),
         (case when l.cost_basis_state = 'known' then
            l.unit_cost_basis_nok_minor + coalesce(adj.total_nok, 0) / l.quantity
          end)::text,
         (case when l.cost_basis_state = 'known' then
            case
              -- D-209: a live disposal already carries the residual, so exhausting this lot
              -- takes none of it (the preview must equal what create_opening freezes).
              when exists (
                select 1 from public.lot_disposals ld
                where ld.lot_id = l.id and ld.voided_at is null and ld.consumed_lot_residual
              ) then 0::bigint
              else l.residual_nok_minor
                + (coalesce(adj.total_nok, 0) - (coalesce(adj.total_nok, 0) / l.quantity) * l.quantity)
            end
          end)::text,
         pu.id,
         pu.origin::text,
         pu.purchased_on
  from public.acquisition_lots l
  join public.holdings h on h.id = l.holding_id
  join public.sealed_products sp on sp.id = h.sealed_product_id
  left join public.purchase_lines pl on pl.id = l.purchase_line_id
  left join public.purchases pu on pu.id = pl.purchase_id
  left join adjustments adj on adj.lot_id = l.id
  where l.user_id = auth.uid()
    and l.voided_at is null
    and l.quantity_remaining > 0
    and h.holding_kind = 'sealed'
    and h.deleted_at is null
    and (p_holding_id is null or l.holding_id = p_holding_id)
  order by sp.name asc, l.acquired_on desc, l.id asc;
$$;



create or replace function public.rebuild_portfolio_snapshots(
  p_user_id uuid,
  p_from date,
  p_through date
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- A reversed range is a malformed maintenance call and is rejected below rather than silently
  -- reordered: every legitimate caller (the drain, the sweep, explicit service-role rebuilds)
  -- passes from <= through, so normalization could only ever mask a swapped-argument mistake by
  -- launching an unrequested rebuild with no error signal.
  v_from date;
  v_through date;
  v_use_eu boolean;
  v_first_tracked date;
  v_written integer := 0;
begin
  if p_user_id is null then
    raise exception 'p_user_id is required';
  end if;
  if p_from is null or p_through is null then
    raise exception 'p_from and p_through are required';
  end if;
  if p_through < p_from then
    raise exception
      'rebuild_portfolio_snapshots: p_through % precedes p_from % - reversed range rejected',
      p_through, p_from;
  end if;
  v_from := p_from;
  v_through := least(p_through, current_date);

  select coalesce(p.use_eu_pricing, true) into v_use_eu
    from public.profiles p where p.id = p_user_id;
  v_use_eu := coalesce(v_use_eu, true);

  delete from public.portfolio_snapshots s
   where s.user_id = p_user_id
     and s.snapshot_date between v_from and v_through;

  -- Earliest date any canonical fact begins for this user. Nothing before it can have a
  -- snapshot: no ownership, no spend, no proceeds — storing zero-filled rows there would
  -- fabricate history (prompt §27/§48/§91).
  select min(d) into v_first_tracked from (
    select min(l.acquired_on) as d from public.acquisition_lots l
      where l.user_id = p_user_id and l.voided_at is null
    union all
    select min(p.purchased_on) from public.purchases p
      where p.user_id = p_user_id and p.voided_at is null
    union all
    select min(s.sold_on) from public.sales s
      where s.user_id = p_user_id and s.voided_at is null
  ) f;

  if v_first_tracked is null or v_through < v_first_tracked or v_through < v_from then
    return 0;
  end if;
  v_from := greatest(v_from, v_first_tracked);

  insert into public.portfolio_snapshots (
    user_id, snapshot_date,
    market_value_nok_minor, attributed_value_nok_minor, cost_basis_nok_minor,
    collectible_spend_to_date_nok_minor, sales_proceeds_to_date_nok_minor,
    open_lot_count, unvalued_lot_count, computed_at
  )
  with lots as materialized (
    -- Every non-voided lot of every live holding, with its identity for valuation. Voided lots
    -- are corrections: they are excluded from every historical state entirely (prompt §21),
    -- exactly as the current-state queries treat them.
    select l.id as lot_id, l.holding_id, l.acquired_on, l.quantity, l.residual_nok_minor,
           l.cost_basis_state, l.unit_cost_basis_nok_minor
    from public.acquisition_lots l
    join public.holdings h on h.id = l.holding_id
    where l.user_id = p_user_id
      and l.voided_at is null
      and h.deleted_at is null
      and h.user_id = p_user_id
  ),
  dates as materialized (
    select d::date as d from generate_series(v_from, v_through, interval '1 day') d
  ),
  -- ── ownership timeline: quantity remaining as of each date ────────────────────────────────
  grid as materialized (
    select l.lot_id, l.holding_id, l.quantity, l.cost_basis_state,
           l.unit_cost_basis_nok_minor, dt.d
    from lots l join dates dt on dt.d >= l.acquired_on
  ),
  disposed_per_day as materialized (
    select ld.lot_id, ld.disposed_on as d, sum(ld.quantity) as qty
    from public.lot_disposals ld
    join lots l on l.lot_id = ld.lot_id
    where ld.voided_at is null and ld.disposed_on <= v_through
    group by ld.lot_id, ld.disposed_on
  ),
  -- D-209: the first day on which a live disposal carries the lot's residual. From that day the
  -- residual is no longer on the lot, however many units are open (an out-of-order void brings units
  -- back; a backdated exhausting sale leaves units open on earlier days).
  residual_carried as materialized (
    select ld.lot_id, min(ld.disposed_on) as carried_on
    from public.lot_disposals ld
    join lots l on l.lot_id = ld.lot_id
    where ld.voided_at is null and ld.consumed_lot_residual and ld.disposed_on <= v_through
    group by ld.lot_id
  ),
  adjusted_per_day as materialized (
    select a.lot_id, a.occurred_on as d, sum(a.amount_nok_minor) as amt
    from public.lot_cost_adjustments a
    join lots l on l.lot_id = a.lot_id
    where a.occurred_on <= v_through
    group by a.lot_id, a.occurred_on
  ),
  -- Two single-stream joins + GROUP BY (never a correlated per-row subquery, D-054 discipline):
  -- cumulative disposal quantity and cumulative adjustment amount as of each date.
  lot_qty_day as materialized (
    select g.lot_id, g.holding_id, g.d, g.cost_basis_state, g.unit_cost_basis_nok_minor,
           g.quantity - coalesce(sum(dp.qty), 0)::int as qty_open
    from grid g
    left join disposed_per_day dp on dp.lot_id = g.lot_id and dp.d <= g.d
    group by g.lot_id, g.holding_id, g.d, g.quantity, g.cost_basis_state, g.unit_cost_basis_nok_minor
  ),
  lot_adj_day as materialized (
    select g.lot_id, g.d, coalesce(sum(ap.amt), 0)::bigint as adj_to_date
    from grid g
    left join adjusted_per_day ap on ap.lot_id = g.lot_id and ap.d <= g.d
    group by g.lot_id, g.d
  ),
  lot_day as materialized (
    select q.*, a.adj_to_date
    from lot_qty_day q join lot_adj_day a on a.lot_id = q.lot_id and a.d = q.d
    where q.qty_open > 0
  ),
  -- ── manual valuation intervals (D-062): economic validity [effective_from, valid_to), rows
  -- sorted by (effective_from, created_at, id). Two distinct ways a row can end, and the schema's
  -- timestamps distinguish them because now() is the TRANSACTION timestamp:
  --
  --   ATOMIC REPLACEMENT  set_manual_valuation supersedes the old row and inserts the new one in
  --   ONE transaction, so the old row's superseded_at equals the successor row's created_at.
  --   D-062: the replacement's effective_from defines the economic boundary — the old value runs
  --   to the day the new one begins.
  --
  --   INDEPENDENT CLEAR   clear_manual_valuation stamps superseded_at and inserts nothing. If a
  --   NEW valuation only arrives later as a separate transaction, the old row was cleared and
  --   STAYS CLEARED: it ends at its own clear date, and the gap before the later row's
  --   effective_from resolves through the normal provider/missing path. A user's explicit clear
  --   must never be silently resurrected by an unrelated later insertion.
  --
  -- The pairing test below is "does ANY later-created row share this row's supersession
  -- timestamp", not "does the immediately-next row in sort order" — a still-later backdated
  -- correction can sort BETWEEN a row and its actual successor in (effective_from, created_at)
  -- order, and misreading that as a clear would produce overlapping intervals (double-counted
  -- days). With the pairing test every interval satisfies valid_to <= next row's effective_from,
  -- so per-day coverage stays single-valued by construction.
  mv_supersede_pairs as materialized (
    select distinct m.holding_id, m.superseded_at
    from public.manual_valuations m
    join public.manual_valuations n
      on n.user_id = m.user_id
     and n.holding_id = m.holding_id
     and n.created_at = m.superseded_at
    where m.user_id = p_user_id
      and m.superseded_at is not null
  ),
  mv_intervals as materialized (
    select mv.holding_id, mv.effective_from,
           lead(mv.effective_from) over w as next_eff,
           case
             -- Terminal row: active → open-ended; cleared → ends at the clear date itself.
             when lead(mv.effective_from) over w is null
               then cast(mv.superseded_at as date)
             -- Superseded by a transaction that also inserted a successor: replacement boundary.
             when pair.superseded_at is not null
               then lead(mv.effective_from) over w
             -- Cleared independently, with independent later insert(s) following: the clear stays
             -- cleared. least() covers the backdated-correction case where the later row's
             -- effective_from lands before the clear date — corrections rewrite history; they do
             -- not extend what they correct.
             else least(cast(mv.superseded_at as date), lead(mv.effective_from) over w)
           end as valid_to,
           mv.value_nok_minor
    from public.manual_valuations mv
    left join mv_supersede_pairs pair
      on pair.holding_id = mv.holding_id and pair.superseded_at = mv.superseded_at
    where mv.user_id = p_user_id
    window w as (partition by mv.holding_id order by mv.effective_from, mv.created_at, mv.id)
  ),
  holding_meta as materialized (
    select h.id as holding_id, h.holding_kind, h.card_variant_id
    from public.holdings h
    where h.user_id = p_user_id and h.deleted_at is null
  ),
  manual_days as materialized (
    select mi.holding_id, dt.d, mi.value_nok_minor
    from mv_intervals mi join dates dt
      on dt.d >= mi.effective_from
     and (mi.valid_to is null or dt.d < mi.valid_to)
  ),
  -- ── provider observations as step functions over the range (age measured from D, prompt §25)
  owned_variants as materialized (
    select distinct hm.card_variant_id
    from holding_meta hm
    where hm.card_variant_id is not null and hm.holding_kind = 'raw_card'
  ),
  obs as materialized (
    select ps.card_variant_id, ps.provider, ps.snapshot_date, ps.source_currency, ps.value_minor
    from public.price_snapshots ps
    join owned_variants ov on ov.card_variant_id = ps.card_variant_id
    where ps.snapshot_date > v_from - 31   -- older observations can never resolve inside the range
      and ps.snapshot_date <= v_through
  ),
  obs_step as materialized (
    select o.*,
           lead(o.snapshot_date) over (
             partition by o.card_variant_id, o.provider order by o.snapshot_date
           ) as next_date
    from obs o
  ),
  obs_fx as materialized (
    select
      d.base_currency, d.snapshot_date,
      (
        select fr.rate from public.fx_rates fr
        where fr.base_currency = d.base_currency
          and fr.quote_currency = 'NOK'
          and fr.source = 'norges_bank'
          and fr.rate_date <= d.snapshot_date
        order by fr.rate_date desc
        limit 1
      ) as rate
    from (
      select distinct o.source_currency as base_currency, o.snapshot_date
      from obs_step o where o.source_currency <> 'NOK'
    ) d
  ),
  steps as materialized (
    select os.card_variant_id, os.provider, os.snapshot_date,
           least(os.snapshot_date + 31, coalesce(os.next_date, os.snapshot_date + 31)) as valid_to,
           case when os.source_currency = 'NOK' then os.value_minor::numeric
                when fx.rate is not null then round(os.value_minor * fx.rate)
           end as nok_value
    from obs_step os
    left join obs_fx fx
      on fx.base_currency = os.source_currency and fx.snapshot_date = os.snapshot_date
  ),
  provider_days as materialized (
    select s.card_variant_id, dt.d, s.nok_value, s.provider
    from steps s join dates dt
      on dt.d >= s.snapshot_date and dt.d < s.valid_to
    where s.nok_value is not null
  ),
  -- One resolved unit value per (variant, date), honouring the same use_eu_pricing preference
  -- (D-052) as the current-value resolver — freshness never overrides the preference.
  provider_choice as materialized (
    select pd.card_variant_id, pd.d,
           max(pd.nok_value) filter (where pd.provider = 'tcgdex_cardmarket') as cm,
           max(pd.nok_value) filter (where pd.provider = 'tcgdex_tcgplayer') as tp
    from provider_days pd
    group by pd.card_variant_id, pd.d
  ),
  variant_unit as materialized (
    select pc.card_variant_id, pc.d,
           case when v_use_eu and pc.cm is not null then pc.cm
                when v_use_eu and pc.tp is not null then pc.tp
                when not v_use_eu and pc.tp is not null then pc.tp
                else pc.cm
           end as unit_value
    from provider_choice pc
  ),
  holding_days as materialized (
    select distinct ld.holding_id, ld.d from lot_day ld
  ),
  -- Per-holding unit value on a day: active manual interval wins; otherwise a provider value
  -- ONLY for raw cards (F10 — graded and sealed resolve manual-or-missing, unchanged from M9).
  holding_unit as materialized (
    select hd.holding_id, hd.d,
           case
             when md.value_nok_minor is not null then md.value_nok_minor
             when hm.holding_kind = 'raw_card' and vu.unit_value is not null then vu.unit_value::bigint
             else null
           end as unit_value
    from holding_days hd
    join holding_meta hm on hm.holding_id = hd.holding_id
    left join manual_days md on md.holding_id = hd.holding_id and md.d = hd.d
    left join variant_unit vu on vu.card_variant_id = hm.card_variant_id and vu.d = hd.d
  ),
  lot_valued as materialized (
    select ld.d, ld.lot_id, ld.qty_open, ld.adj_to_date,
           lq.cost_basis_state, lq.unit_cost_basis_nok_minor, hu.unit_value
    from lot_day ld
    join lots lq on lq.lot_id = ld.lot_id
    join holding_meta hm on hm.holding_id = ld.holding_id
    left join holding_unit hu on hu.holding_id = ld.holding_id and hu.d = ld.d
  ),
  -- DCB as of D: quantity × unit basis plus the lot's proportional share (floor) of adjustments
  -- that had occurred by D — a future grading adjustment never inflates a past snapshot
  -- (prompt §58). Exact integers; the flooring rule is DECISIONS.md D-068.
  daily_core as materialized (
    select lv.d,
           coalesce(sum(lv.qty_open * lv.unit_value)
             filter (where lv.unit_value is not null), 0)::bigint as cmv,
           coalesce(sum(lv.qty_open * lv.unit_value)
             filter (where lv.unit_value is not null and lv.cost_basis_state = 'known'), 0)::bigint as acmv,
           coalesce(sum(
             lv.qty_open * lq.unit_cost_basis_nok_minor
             + case when rc.carried_on <= lv.d then 0 else lq.residual_nok_minor end
             + floor(lv.adj_to_date * lv.qty_open / greatest(lq.quantity, 1))
           ) filter (where lv.cost_basis_state = 'known'), 0)::bigint as dcb,
           count(*)::bigint as open_lot_count,
           count(*) filter (where lv.unit_value is null)::bigint as unvalued_lot_count
    from lot_valued lv
    join lots lq on lq.lot_id = lv.lot_id
    left join residual_carried rc on rc.lot_id = lv.lot_id
    group by lv.d
  ),
  spend_by_day as materialized (
    select p.purchased_on as d,
           coalesce(sum(pl.attributable_cost_nok_minor)
             filter (where pl.spend_class = 'collectible'), 0)::bigint as cs_delta,
           coalesce(sum(pl.attributable_cost_nok_minor)
             filter (where pl.spend_class = 'hobby'), 0)::bigint as hs_delta
    from public.purchase_lines pl
    join public.purchases p on p.id = pl.purchase_id
    where pl.user_id = p_user_id
      and p.user_id = p_user_id
      and p.voided_at is null
      and p.purchased_on <= v_through
    group by p.purchased_on
  ),
  proceeds_by_day as materialized (
    select s.sold_on as d, sum(s.net_proceeds_nok_minor)::bigint as nsp_delta
    from public.sales s
    where s.user_id = p_user_id and s.voided_at is null and s.sold_on <= v_through
    group by s.sold_on
  ),
  spend_before as materialized (
    select coalesce(sum(pl.attributable_cost_nok_minor) filter (where pl.spend_class = 'collectible'), 0)::bigint as cs,
           coalesce(sum(pl.attributable_cost_nok_minor) filter (where pl.spend_class = 'hobby'), 0)::bigint as hs
    from public.purchase_lines pl
    join public.purchases p on p.id = pl.purchase_id
    where pl.user_id = p_user_id and p.voided_at is null and p.purchased_on < v_from
  ),
  proceeds_before as materialized (
    select coalesce(sum(s.net_proceeds_nok_minor), 0)::bigint as nsp
    from public.sales s
    where s.user_id = p_user_id and s.voided_at is null and s.sold_on < v_from
  ),
  -- Frozen-ledger cumulatives over the date spine: opening balance before the range plus a
  -- running sum of per-day deltas. Set-based window, no correlated per-date subquery.
  spine as materialized (
    select dt.d,
           sb.cs + coalesce(sum(sd.cs_delta) over (order by dt.d), 0)::bigint as cs,
           pb.nsp + coalesce(sum(pd.nsp_delta) over (order by dt.d), 0)::bigint as nsp
    from dates dt
    left join spend_by_day sd on sd.d = dt.d
    left join proceeds_by_day pd on pd.d = dt.d
    cross join spend_before sb
    cross join proceeds_before pb
  )
  select
    p_user_id,
    spine.d,
    coalesce(dc.cmv, 0),
    coalesce(dc.acmv, 0),
    coalesce(dc.dcb, 0),
    spine.cs,
    spine.nsp,
    coalesce(dc.open_lot_count, 0),
    coalesce(dc.unvalued_lot_count, 0),
    now()
  from spine
  left join daily_core dc on dc.d = spine.d;

  get diagnostics v_written = row_count;
  return v_written;
end;
$$;


comment on function public.create_sale(
  date, text, jsonb, uuid, text, bigint, bigint, bigint, numeric, date, public.fx_source, text
) is
  'Atomic multi-line sale write: one sale, its lines (each disposing from exactly one explicitly-chosen lot), the disposal ledger rows, and the frozen cost basis/realized result each line is entitled to. p_idempotency_key is required: a replay with the same (user, key) and the same material request returns the original sale, updating only p_notes if it differs (P138/D-122); a same-key replay with a materially different request is refused with a named idempotency-key-reuse error. A disposal that exhausts a lot freezes the lot residual only if no live disposal already carries it (D-209). P133 (20260915120000) made the NOK conversion exponent-aware (P130-02). See FINANCIAL_MODEL.md section 2.2/4.3/4.5, DATA_MODEL.md section 5.7/5.11.';

-- Queue every user whose snapshots differ from the P199 rule: a live carrier exists and either units
-- are still on the lot or a later-dated live disposal leaves units open between the two dates.
select public.enqueue_portfolio_recompute(t.user_id, t.first_acquired)
from (
  select l.user_id, min(l.acquired_on) as first_acquired
  from public.acquisition_lots l
  where l.voided_at is null
    and l.cost_basis_state = 'known'
    and l.residual_nok_minor > 0
    and exists (
      select 1 from public.lot_disposals c
      where c.lot_id = l.id and c.voided_at is null and c.consumed_lot_residual
        and (
          l.quantity_remaining > 0
          or exists (
            select 1 from public.lot_disposals o
            where o.lot_id = l.id and o.voided_at is null and o.disposed_on > c.disposed_on
          )
        )
    )
  group by l.user_id
) t;
