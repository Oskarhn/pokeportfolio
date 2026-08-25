-- M16: Openings V1 — the transactional write surface (FINANCIAL_MODEL.md §5, prompt §13/§18/§20).
--
--   create_opening(...)                        one atomic opening: opening row + 'opened' disposal
--                                              + pulled-card lots, in one transaction.
--   create_opening_from_provisional(...)       the §5.5 provisional path: creates a REAL purchase
--                                              (origin='provisional_opening') + its sealed lot,
--                                              then consumes it through create_opening in the
--                                              SAME transaction. No opening-local spend number
--                                              exists anywhere; GPO/CS count the money once.
--   void_opening(...)                          safe lifecycle: restores sealed quantity via D1,
--                                              voids pull lots, voids the provisional purchase;
--                                              refused while any pull has a downstream disposal.
--   reconcile_opening_cost(...)                links a provisionally-costed opening to the real
--                                              purchase's lot; voids the provisional purchase.
--                                              Provenance on the row (no audit_events — prompt §4B).
--   get_opening(...)                           bounded Opening Detail read incl. the §5.3 result
--                                              components, money as text.
--
-- ── Why SECURITY DEFINER ──────────────────────────────────────────────────────────────────────
-- Same standard as create_sale/update_sale/void_sale (D-060): these functions author frozen
-- financial figures — openings.cost_nok_minor copied from the lot's frozen basis, the disposal's
-- cost_basis_at_disposal_nok_minor, and the provisional purchase's allocated ledger columns —
-- that must be genuinely unreachable by direct writes. authenticated holds NO INSERT/UPDATE grant
-- on openings at all and no INSERT on lot_disposals at all (20260902120000), so an INVOKER write
-- path is structurally impossible without widening grants the void lifecycle exists to avoid
-- widening. What replaces RLS as the authorization boundary is the same discipline every DEFINER
-- function here already has: v_user_id := auth.uid() with no user-id parameter to forge, explicit
-- `user_id = v_user_id` filters on every statement about caller-supplied ids, FOR UPDATE locks on
-- referenced lots, and explicit curated-or-owned checks for any referenced sealed product /
-- manual card / storage location (a DEFINER body does NOT get RLS for free — postgres bypasses
-- it — so each foreign reference is verified explicitly, the M11 bug-5 lesson institutionalized).
-- get_opening stays SECURITY INVOKER: it reads only owner-readable rows under ordinary RLS.
--
-- ── The exactness rule (verbatim M10 discipline) ──────────────────────────────────────────────
-- Consuming q units from lot L freezes:
--   adjustments_total_nok = Σ lot_cost_adjustments.amount_nok_minor for L
--   adj_per_unit          = adjustments_total_nok / L.quantity          (floor)
--   adj_residual           = adjustments_total_nok - adj_per_unit * L.quantity
--   basis                  = (L.unit_cost_basis_nok_minor + adj_per_unit) * q
--                            + (L.residual_nok_minor + adj_residual)    -- only if this disposal
--                                                                       -- exhausts L
-- Because a lot's quantity_remaining decreases monotonically and reaches zero at most once per
-- lifetime (D-060), Σ basis over every disposal of L reproduces its exact original attributable
-- cost: no øre lost, none invented, deterministic regardless of how many openings/sales split the
-- lot or in what order. A non-known lot freezes NULL — never 0 (M1/M2); the opening then has
-- cost_source='unknown' and a NULL cost, and its return renders "—", not "0 kr result".
--
-- ── Concurrency ───────────────────────────────────────────────────────────────────────────────
-- The source lot is locked SELECT ... FOR UPDATE before quantity_remaining is re-checked against
-- the live row (never a client-cached value). Two concurrent openings of the same units serialize
-- on the lock; the loser sees the winner's committed disposal through the D1 trigger and fails its
-- own check cleanly. Lock order is a single lot per call (single-source-lot model), so no new
-- deadlock class versus create_sale's ascending multi-lot order can arise.

-- ── 1. create_opening ────────────────────────────────────────────────────────────────────────
create function public.create_opening(
  p_source_lot_id uuid,
  p_quantity int,
  p_opened_on date default current_date,
  p_tracking_completeness public.opening_tracking default 'all_cards',
  p_pulls jsonb default null,
  p_bulk_remainder_estimate_nok_minor bigint default null,
  p_bulk_remainder_count int default null,
  p_notes text default null,
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
  v_lot record;
  v_adjustments_total_nok bigint;
  v_adj_per_unit bigint;
  v_adj_residual bigint;
  v_exhausts boolean;
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
    v_exhausts := (v_lot.quantity_remaining - p_quantity) = 0;
    v_basis := (v_lot.unit_cost_basis_nok_minor + v_adj_per_unit) * p_quantity;
    if v_exhausts then
      v_basis := v_basis + v_lot.residual_nok_minor + v_adj_residual;
    end if;
  else
    v_basis := null;
  end if;

  insert into public.openings (
    user_id, opened_on, source_lot_id, sealed_product_id, quantity_opened,
    cost_source, cost_nok_minor, tracking_completeness,
    bulk_remainder_estimate_nok_minor, bulk_remainder_count,
    provisional_purchase_id, notes
  ) values (
    v_user_id, p_opened_on, p_source_lot_id, v_lot.sealed_product_id, p_quantity,
    case when v_basis is null then 'unknown' else 'from_lot' end::public.opening_cost_source,
    v_basis, p_tracking_completeness,
    p_bulk_remainder_estimate_nok_minor, p_bulk_remainder_count,
    p_provisional_purchase_id, p_notes
  )
  returning * into v_opening;

  -- The consumption IS a disposal row: D1 decrements quantity_remaining, the M12 invalidation
  -- triggers dirty history from disposed_on, and the frozen share lands on the existing column.
  insert into public.lot_disposals (
    lot_id, user_id, kind, quantity, disposed_on, opening_id, cost_basis_at_disposal_nok_minor
  ) values (
    v_lot.id, v_user_id, 'opened', p_quantity, p_opened_on, v_opening.id, v_basis
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

comment on function public.create_opening(
  uuid, int, date, public.opening_tracking, jsonb, bigint, int, text, uuid
) is
  'Atomic opening write: one opening row consuming 1..N units of ONE sealed lot (frozen exact '
  'basis, residual rule identical to sales), its kind=''opened'' lot_disposal, and the pulled-card '
  'lots (NULL individual basis by construction). Creates no spend. See FINANCIAL_MODEL.md §5.';

-- ── 2. create_opening_from_provisional — FINANCIAL_MODEL.md §5.5 / D-021 ─────────────────────
-- The owner opened something never entered as a purchase and states what they paid. The money is
-- REAL: it enters the ledger as an ordinary purchase (origin='provisional_opening', one sealed
-- line), producing an ordinary known-cost lot — which create_opening then consumes through the
-- normal path in the SAME transaction. Every aggregate (GPO/CS/monthly spend/history) reads it
-- with no special case; the opening gets cost_source='from_lot'; openings.provisional_purchase_id
-- marks it for later reconciliation. Unit price × quantity is exact by construction (the same
-- unit-price shape every other acquisition path uses); NOK only — a provisional entry invents no
-- FX precision.
create function public.create_opening_from_provisional(
  p_sealed_product_id uuid,
  p_quantity int,
  p_unit_price_minor bigint,
  p_purchased_on date,
  p_opened_on date default null,
  p_tracking_completeness public.opening_tracking default 'all_cards',
  p_pulls jsonb default null,
  p_bulk_remainder_estimate_nok_minor bigint default null,
  p_bulk_remainder_count int default null,
  p_notes text default null
)
returns public.openings
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_opened_on date := coalesce(p_opened_on, p_purchased_on);
  v_purchase_id uuid;
  v_line_id uuid;
  v_holding_id uuid;
  v_lot_id uuid;
  v_total_minor bigint;
  v_product_name text;
begin
  if v_user_id is null then
    raise exception 'not authenticated';
  end if;
  if p_sealed_product_id is null then
    raise exception 'p_sealed_product_id is required';
  end if;
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'p_quantity must be a positive integer';
  end if;
  if p_unit_price_minor is null or p_unit_price_minor < 0 then
    raise exception 'p_unit_price_minor must be a non-negative amount';
  end if;
  if p_purchased_on is null then
    raise exception 'p_purchased_on is required';
  end if;

  -- Curated-or-own, enforced explicitly (this DEFINER body does not inherit RLS; the M11 bug-5
  -- rule: a forged id fails here server-side, not merely by omission from Search results).
  select name into v_product_name from public.sealed_products
    where id = p_sealed_product_id
      and (created_by_user_id is null or created_by_user_id = v_user_id);
  if v_product_name is null then
    raise exception 'sealed product % not found or not accessible', p_sealed_product_id;
  end if;

  v_total_minor := p_unit_price_minor * p_quantity;

  insert into public.purchases (
    user_id, origin, purchased_on, currency,
    subtotal_minor, shipping_minor, customs_minor, discount_minor, total_minor,
    fx_rate_to_nok, fx_rate_date, fx_source, total_nok_minor
  ) values (
    v_user_id, 'provisional_opening', p_purchased_on, 'NOK',
    v_total_minor, 0, 0, 0, v_total_minor,
    1, p_purchased_on, 'manual', v_total_minor
  )
  returning id into v_purchase_id;

  insert into public.purchase_lines (
    purchase_id, user_id, line_type, spend_class, description,
    sealed_product_id, quantity, unit_price_minor, line_total_minor,
    allocated_shipping_minor, allocated_customs_minor, allocated_discount_minor,
    attributable_cost_minor, attributable_cost_nok_minor
  ) values (
    v_purchase_id, v_user_id, 'sealed', 'collectible', v_product_name,
    p_sealed_product_id, p_quantity, p_unit_price_minor, v_total_minor,
    0, 0, 0,
    v_total_minor, v_total_minor
  )
  returning id into v_line_id;

  -- Find-or-create the sealed holding, race-safe via holdings_identity (M6/M8/M11 pattern).
  begin
    insert into public.holdings (
      user_id, holding_kind, sealed_product_id, grading_state, sealed_intent, is_favorite
    ) values (
      v_user_id, 'sealed', p_sealed_product_id, 'raw', 'undecided', false
    )
    returning id into v_holding_id;
  exception when unique_violation then
    select id into v_holding_id
      from public.holdings
      where user_id = v_user_id
        and holding_kind = 'sealed'
        and sealed_product_id = p_sealed_product_id
        and grading_state = 'raw'
        and deleted_at is null;
    if v_holding_id is null then
      raise;
    end if;
  end;

  -- The ordinary known-cost lot the opening consumes. Exact: unit × quantity reconstructs the
  -- attributable total with zero residual, by construction.
  insert into public.acquisition_lots (
    holding_id, user_id, origin, cost_basis_state, purchase_line_id, acquired_on,
    quantity, quantity_remaining, unit_cost_basis_minor, cost_basis_currency,
    unit_cost_basis_nok_minor, residual_nok_minor, sealed_intent
  ) values (
    v_holding_id, v_user_id, 'purchase', 'known', v_line_id, p_purchased_on,
    p_quantity, p_quantity, p_unit_price_minor, 'NOK',
    p_unit_price_minor, 0, 'undecided'
  )
  returning id into v_lot_id;

  return public.create_opening(
    p_source_lot_id => v_lot_id,
    p_quantity => p_quantity,
    p_opened_on => v_opened_on,
    p_tracking_completeness => p_tracking_completeness,
    p_pulls => p_pulls,
    p_bulk_remainder_estimate_nok_minor => p_bulk_remainder_estimate_nok_minor,
    p_bulk_remainder_count => p_bulk_remainder_count,
    p_notes => p_notes,
    p_provisional_purchase_id => v_purchase_id
  );
end;
$$;

comment on function public.create_opening_from_provisional(
  uuid, int, bigint, date, date, public.opening_tracking, jsonb, bigint, int, text
) is
  'FINANCIAL_MODEL §5.5 provisional path in one transaction: creates the real '
  'purchase(origin=provisional_opening) + its known-cost sealed lot, then consumes it through the '
  'normal create_opening path. Money counted exactly once; reconcilable later without faking spend.';

-- ── 3. void_opening ──────────────────────────────────────────────────────────────────────────
-- Safe lifecycle (prompt §20). One transaction: void the opening, void its consumption disposal
-- (the D1 trigger restores the source lot's quantity_remaining), void every pull lot that is
-- still live, and — for an UNRECONCILED provisional opening — void the provisional purchase so
-- its money leaves the ledger symmetrically to how it entered. A RECONCILED opening's real
-- purchase stays: that money was genuinely spent regardless of the opening's fate.
-- Refused outright while any pull lot carries a non-voided downstream disposal (a sale today;
-- trades/write-offs later) — never orphan a financial fact.
create function public.void_opening(p_opening_id uuid, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_opening public.openings;
  v_blocker record;
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
  if v_opening.voided_at is not null then
    raise exception 'opening % is already voided', p_opening_id;
  end if;

  -- Downstream-dependency guard: any non-voided disposal on any pull lot blocks the void.
  select ld.id as disposal_id, sl.sale_id
    into v_blocker
  from public.lot_disposals ld
  join public.acquisition_lots al on al.id = ld.lot_id
  left join public.sale_lines sl on sl.id = ld.sale_line_id
  where al.opening_id = v_opening.id
    and ld.voided_at is null
  limit 1;

  if v_blocker.disposal_id is not null then
    raise exception
      'opening % cannot be voided: a pulled card already has a downstream disposal (%) — void that transaction first',
      p_opening_id, coalesce(v_blocker.sale_id::text, v_blocker.disposal_id::text);
  end if;

  update public.openings
    set voided_at = now(), notes = coalesce(p_reason, notes)
    where id = v_opening.id;

  -- Restores the source lot via recompute_lot_quantity_remaining (D1).
  update public.lot_disposals
    set voided_at = now()
    where opening_id = v_opening.id and voided_at is null;

  update public.acquisition_lots
    set voided_at = now()
    where opening_id = v_opening.id and voided_at is null;

  -- Provisional money leaves only when this opening was still standing on it. After
  -- reconciliation the real purchase owns the cost and is deliberately untouched.
  if v_opening.provisional_purchase_id is not null and v_opening.reconciled_at is null then
    update public.purchases
      set voided_at = now()
      where id = v_opening.provisional_purchase_id
        and user_id = v_user_id
        and voided_at is null;
  end if;
end;
$$;

comment on function public.void_opening(uuid, text) is
  'Voids an opening atomically: restores the sealed lot (D1), corrects the pull lots through the '
  'void lifecycle, voids an unreconciled provisional purchase. Blocked while any pull has been '
  'sold or otherwise disposed downstream. Already-voided is a named error.';

-- ── 4. reconcile_opening_cost ────────────────────────────────────────────────────────────────
-- FINANCIAL_MODEL.md §5.5 / prompt §18-19. Links a provisionally-costed opening to the real
-- receipt's lot. In ONE transaction the provisional consumption is retired (restoring the
-- provisional lot via D1), a new consumption freezes the REAL lot's exact share, the opening
-- repoints at the real lot, the provisional purchase is voided, and the provenance pair
-- (reconciled_at, reconciled_to_purchase_id) records what replaced what — traceable WITHOUT
-- audit_events, which do not exist and are not invented here (prompt §4B). F12 holds at every
-- instant inside the single commit: at most one active monetary source.
create function public.reconcile_opening_cost(p_opening_id uuid, p_real_source_lot_id uuid)
returns public.openings
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_opening public.openings;
  v_lot record;
  v_adjustments_total_nok bigint;
  v_adj_per_unit bigint;
  v_adj_residual bigint;
  v_basis bigint;
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
  if v_opening.voided_at is not null then
    raise exception 'opening % is voided and cannot be reconciled', p_opening_id;
  end if;
  if v_opening.provisional_purchase_id is null then
    raise exception 'opening % has no provisional purchase to reconcile', p_opening_id;
  end if;
  if v_opening.reconciled_at is not null then
    raise exception 'opening % is already reconciled', p_opening_id;
  end if;

  -- The real lot: owned, live, sealed, the SAME product, known basis, enough remaining units.
  select l.id, l.cost_basis_state, l.unit_cost_basis_nok_minor, l.residual_nok_minor,
         l.quantity, l.quantity_remaining, l.voided_at,
         h.sealed_product_id, h.holding_kind,
         pl.purchase_id as real_purchase_id
    into v_lot
  from public.acquisition_lots l
  join public.holdings h on h.id = l.holding_id
  join public.purchase_lines pl on pl.id = l.purchase_line_id
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
  if (v_lot.quantity_remaining - v_opening.quantity_opened) = 0 then
    v_basis := v_basis + v_lot.residual_nok_minor + v_adj_residual;
  end if;

  -- Retire the provisional consumption FIRST (unique live-per-opening index + D1 restore),
  -- then write the repointed consumption.
  update public.lot_disposals
    set voided_at = now()
    where opening_id = v_opening.id and voided_at is null;

  insert into public.lot_disposals (
    lot_id, user_id, kind, quantity, disposed_on, opening_id, cost_basis_at_disposal_nok_minor
  ) values (
    v_lot.id, v_user_id, 'opened', v_opening.quantity_opened, v_opening.opened_on,
    v_opening.id, v_basis
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

comment on function public.reconcile_opening_cost(uuid, uuid) is
  'Links a provisionally-costed opening to the real purchase''s lot in one transaction: retires '
  'the provisional consumption, freezes the real lot''s exact share, repoints the opening, voids '
  'the provisional purchase. F12 holds throughout; provenance kept on the row (no audit_events).';

-- ── 5. get_opening — the bounded Opening Detail read ─────────────────────────────────────────
-- SECURITY INVOKER: reads only rows ordinary RLS already shows the caller. Computes the §5.3
-- result components ON READ (never stored, never summed with TTEP anywhere — F8): retained
-- tracked value over live pull lots (manual valuation wins, then the shared M9 resolver called
-- ONCE for all variants — never per row), net proceeds from sold pulls (live sales only; the lot
-- keeps its opening_id forever), plus the owner's bulk remainder estimate. NULL cost ⇒ NULL
-- return AND roi inputs — "—", never "0 kr result". Money as text at the boundary.
create function public.get_opening(p_opening_id uuid)
returns table (
  id uuid,
  opened_on date,
  sealed_product_id uuid,
  sealed_product_name text,
  source_lot_id uuid,
  quantity_opened int,
  cost_source public.opening_cost_source,
  cost_nok_minor text,
  tracking_completeness public.opening_tracking,
  bulk_remainder_estimate_nok_minor text,
  bulk_remainder_count int,
  provisional_purchase_id uuid,
  reconciled_at timestamptz,
  reconciled_to_purchase_id uuid,
  notes text,
  voided_at timestamptz,
  created_at timestamptz,
  retained_tracked_value_nok_minor text,
  priced_pull_lot_count int,
  unpriced_pull_lot_count int,
  sold_pull_lot_count int,
  net_proceeds_from_sold_pulls_nok_minor text,
  opening_return_nok_minor text
)
language sql
stable
security invoker
set search_path = ''
as $$
  with opening as materialized (
    select o.*
    from public.openings o
    where o.id = p_opening_id and o.user_id = auth.uid()
  ),
  -- Live pulls of this opening, each carrying its holding's active manual valuation if one
  -- exists (the partial unique index guarantees at most one active row per holding).
  pulls as materialized (
    select l.id as lot_id, h.card_variant_id, l.quantity_remaining,
           mv.value_nok_minor as manual_value
    from public.acquisition_lots l
    join public.holdings h on h.id = l.holding_id
    left join public.manual_valuations mv
      on mv.holding_id = h.id and mv.superseded_at is null
    where l.opening_id = (select o.id from opening o)
      and l.user_id = auth.uid()
      and l.voided_at is null
  ),
  variant_ids as (
    select coalesce(array_agg(distinct p.card_variant_id), '{}') as ids
    from pulls p
    where p.card_variant_id is not null
  ),
  -- ONE resolver call for ALL distinct variants (D-054 discipline) — never per row.
  resolved as materialized (
    select r.card_variant_id, r.price_state, r.value_nok_minor
    from public.resolve_variant_market_values((select ids from variant_ids)) r
    where r.price_state in ('fresh', 'stale')
  ),
  pull_value as materialized (
    select
      p.lot_id,
      case
        when p.manual_value is not null then p.manual_value * p.quantity_remaining
        when rv.value_nok_minor is not null then rv.value_nok_minor::bigint * p.quantity_remaining
        else 0
      end as value_component,
      (p.manual_value is not null or rv.value_nok_minor is not null)::int as priced,
      (p.manual_value is null and rv.value_nok_minor is null)::int as unpriced
    from pulls p
    left join resolved rv on rv.card_variant_id = p.card_variant_id
  ),
  retained as (
    select coalesce(sum(pv.value_component), 0)::bigint as total,
           coalesce(sum(pv.priced), 0)::int as priced_count,
           coalesce(sum(pv.unpriced), 0)::int as unpriced_count
    from pull_value pv
  ),
  proceeds as (
    select count(distinct sl.lot_id)::int as sold_lot_count,
           coalesce(sum(sl.net_proceeds_nok_minor), 0)::bigint as total
    from public.sale_lines sl
    join public.sales s on s.id = sl.sale_id
    join public.acquisition_lots al on al.id = sl.lot_id
    where al.opening_id = (select o.id from opening o)
      and s.voided_at is null
  )
  select o.id, o.opened_on, o.sealed_product_id, sp.name, o.source_lot_id, o.quantity_opened,
         o.cost_source, o.cost_nok_minor::text, o.tracking_completeness,
         o.bulk_remainder_estimate_nok_minor::text, o.bulk_remainder_count,
         o.provisional_purchase_id, o.reconciled_at, o.reconciled_to_purchase_id,
         o.notes, o.voided_at, o.created_at,
         r.total::text, r.priced_count, r.unpriced_count, pr.sold_lot_count, pr.total::text,
         (case when o.cost_nok_minor is null then null::bigint
               else r.total + pr.total + coalesce(o.bulk_remainder_estimate_nok_minor, 0)
                    - o.cost_nok_minor
          end)::text
  from opening o
  join public.sealed_products sp on sp.id = o.sealed_product_id
  cross join retained r
  cross join proceeds pr;
$$;

comment on function public.get_opening(uuid) is
  'Bounded Opening Detail read: canonical fields plus the FINANCIAL_MODEL §5.3 result computed on '
  'read — retained tracked value (manual wins → resolver, F14-honest unpriced counts), sold-pull '
  'proceeds, bulk estimate, minus the frozen opening cost. NULL cost renders NULL everywhere; '
  'never summed with TTEP (F8).';

-- ── 6. Grants ────────────────────────────────────────────────────────────────────────────────
revoke execute on function public.create_opening(
  uuid, int, date, public.opening_tracking, jsonb, bigint, int, text, uuid
) from public;
revoke execute on function public.create_opening_from_provisional(
  uuid, int, bigint, date, date, public.opening_tracking, jsonb, bigint, int, text
) from public;
revoke execute on function public.void_opening(uuid, text) from public;
revoke execute on function public.reconcile_opening_cost(uuid, uuid) from public;
revoke execute on function public.get_opening(uuid) from public;

grant execute on function public.create_opening(
  uuid, int, date, public.opening_tracking, jsonb, bigint, int, text, uuid
) to authenticated;
grant execute on function public.create_opening_from_provisional(
  uuid, int, bigint, date, date, public.opening_tracking, jsonb, bigint, int, text
) to authenticated;
grant execute on function public.void_opening(uuid, text) to authenticated;
grant execute on function public.reconcile_opening_cost(uuid, uuid) to authenticated;
grant execute on function public.get_opening(uuid) to authenticated;
