-- P132-A: update_purchase fabricates units and cost basis when a purchase line has more than one
-- live acquisition lot, and races unlocked against create_sale/other correction RPCs (P130-01,
-- P130-03's update_purchase-specific slice). Both are fixed together because they are the same
-- function and the lock fix is a prerequisite for the multi-lot fix being safe under concurrency.
--
-- THE BUG (P130-01). A purchase line normally produces exactly one `acquisition_lots` row, but
-- `set_sealed_lot_intent`'s partial split (20260829120000_m11_sealed_intent_lot_level.sql) can
-- legitimately leave TWO OR MORE live sibling lots pointing at the same `purchase_line_id` — one
-- per sealed_intent the owner has split the quantity into. `update_purchase` never accounted for
-- this: `select * into v_lot from acquisition_lots where purchase_line_id = v_line_id and
-- voided_at is null` (no STRICT, no loop) silently picks ONE of the siblings and overwrites it
-- with the WHOLE line's new quantity and basis, leaving the other siblings' quantity and basis
-- untouched. Reproduced exactly as P130 recorded it: buy 5 sealed @100.00 NOK, split 2 into
-- `keep_sealed` (lots of 3 and 2, basis 30000+20000=50000), then edit only the unit price to
-- 120.00 -> lots end up 3@10000 (untouched) and 5@12000 (overwritten), live sum quantity 8 vs the
-- line's real quantity 5, live sum basis 90000 vs the line's real attributable 60000. Three
-- phantom units, sellable/openable, inflating Portfolio value and P/L. See
-- ai_outputs/Claude_outputs/output_130.txt P130-01 for the full audit entry;
-- PRE_FIX_REPRO=PASS in output_132_a.txt reproduces the identical numbers against this branch's
-- pre-fix code before this migration existed.
--
-- THE BUG (P130-03, this function's slice only). The pre-existing "no partially disposed lot"
-- blocker read every affected lot's `quantity_remaining` WITHOUT a lock, then wrote based on that
-- stale read. A concurrent `create_sale` against the same lot (which DOES take `SELECT ... FOR
-- UPDATE`, 20260828120010_m10_sales_rpc.sql) could commit a disposal in the gap between this
-- function's unlocked read and its write, producing a lot whose recorded state contradicts a live
-- sale against it (D1 broken either by the sale looking sold against a lot that update_purchase
-- just reset to full quantity, or by update_purchase silently overwriting a lot mid-disposal).
-- Reproduced with a held lock exactly as P130's t4/R1 harness did (ai_outputs/Claude_outputs/
-- p130_evidence/trackA/harness/t4_toctou.mjs).
--
-- THE FIX, multi-lot (MULTILOT_RULE, output_132_a.txt). update_purchase now handles EVERY live
-- lot of a line, not one arbitrary row:
--   * Zero live lots (every lot of the line was removed while another, unaccounted-for line on
--     the same purchase keeps the purchase itself live — D-051): nothing to write for that line's
--     lots, and a QUANTITY change is refused (D-130): the new units would be neither inventory
--     nor a recorded removal.
--   * Exactly one live lot and no removed sibling: unchanged in shape from the pre-P132-A code —
--     the whole line's attributable cost lands on that lot, quantity is free to change.
--   * Live lot(s) plus removed (voided) sibling lots (a split line one of whose siblings was
--     removed from inventory): handled like the split case below, with the allocation weighted
--     over every lot of the line but written only to live lots and a quantity change refused —
--     removed units are never resurrected (D-130).
--   * More than one live lot (a split): quantity and quantity_remaining are NEVER touched on any
--     sibling by this function -- see QUANTITY_CHANGE_RULE below for why. What DOES change (a
--     price/shipping/customs/discount/FX correction) is the line's attributable cost, in both
--     currencies, which is redistributed across the UNCHANGED sibling quantities using the
--     project's own exact/deterministic allocator (`allocate_largest_remainder`, already proven
--     exact for any input by D-125/P117/P120's property suite) at TWO levels: first the line
--     total is split across siblings weighted by each sibling's own (untouched) quantity, then
--     each sibling's own share is split into unit_cost_basis + residual exactly as every
--     single-lot line already does (FINANCIAL_MODEL.md §4.3). Because the top-level allocator
--     guarantees `Σ shares = total` (invariant F6) and each sibling's own floor+residual split
--     exactly reconstructs its share, `Σ live sibling lot basis = purchase_line attributable
--     basis` holds exactly, in both currencies, for any number of siblings. sealed_intent and
--     purchase_line_id are never touched, so lot intent and identity survive the edit untouched
--     (prompt's "preserve lot intent / lot identity where practical"). A lot whose
--     cost_basis_state is not 'known' (never fabricate a number where FINANCIAL_MODEL.md's own
--     rule already says there isn't one) has its basis columns left alone entirely; if the
--     siblings of one line ever disagree on cost_basis_state, that is a corrupt state no code path
--     in this product can currently produce (create_purchase only ever originates 'known',
--     set_sealed_lot_intent copies cost_basis_state unchanged when it splits), so it is asserted
--     rather than silently handled -- a future change that breaks this invariant fails loudly here
--     instead of fabricating a number.
--
-- THE FIX, quantity-change ambiguity (QUANTITY_CHANGE_RULE). When a line has more than one live
-- sibling lot, this function has no way to know which sibling a quantity CHANGE is meant to add
-- units to or take units from -- the split itself is the owner's record of a real difference
-- between those units (different sealed_intent), and inventing an allocation would silently
-- misattribute units between two organisationally distinct piles. So: if the line's incoming
-- quantity does not equal the CURRENT total of its live siblings' quantities (verified from the
-- freshly locked rows, not the possibly-stale purchase_lines.quantity column), the whole call is
-- refused before anything is written -- FAIL CLOSED, named 'multi-lot-quantity-ambiguous' the same
-- way this codebase already names 'idempotency-key-reuse' for callers/tests to recognise. The
-- owner's documented recourse is exactly D-047's existing one for "this purchase can no longer
-- represent what happened": void it and record a new one. An ordinary, never-split purchase line
-- (the overwhelming majority) is completely unaffected -- its quantity changes exactly as before.
--
-- THE FIX, locking (LOCK_RULE, P130-03). Every live lot belonging to ANY line of this purchase
-- (not just the lines a caller happens to touch -- update_purchase cannot add/remove lines, so
-- that is every line) is locked with `SELECT ... FOR UPDATE`, in ascending lot-id order, BEFORE
-- the disposal blocker is (re-)checked and before anything is written -- the identical global-
-- ascending-order convention `create_sale` (20260828120010_m10_sales_rpc.sql) and
-- `reduce_holding_quantity` (20260831120000_p28_reduce_holding_quantity.sql) already use, so this
-- function can never deadlock against either of them no matter which lots each call happens to
-- name. Concretely:
--   * `create_sale` locks first: `update_purchase` blocks on the same row lock, then (once
--     unblocked) re-reads `quantity_remaining` fresh under its OWN lock and finds the live
--     disposal -> the blocker fires -> `update_purchase` refuses the edit.
--   * `update_purchase` locks first: `create_sale` blocks on the same row lock, then (once
--     unblocked) re-reads the lot fresh under its own lock and safely sees the just-committed
--     edit (updated basis) -> the sale proceeds correctly costed against the new state.
-- Both orderings proven with a held-lock two-session harness (UPDATE_PURCHASE_RACE_TEST,
-- tests/db/p132a_multilot_purchase_integrity.test.ts).
--
-- INTEGRATION (P132). Refinements made after the independent P132-C package ran against the first
-- candidate of this file, before it was ever applied to a hosted database: (1) the write loop
-- reused the validation loop's sibling-quantity array, so a split line that was not the last line
-- was allocated with another line's quantities (wrong basis, or a raw NOT NULL violation on
-- residual_minor); every per-line array is now read inside the write loop for that line. (2) A
-- line with removed sibling lots no longer resurrects the removed units, and a zero-live-lot line
-- refuses a quantity change (D-130). (3) The purchase's voided state and the live-lot membership
-- are re-read once the locks are held (MEMBERSHIP_RULE): a concurrent void_purchase makes the edit
-- refuse, and a sibling lot created by a concurrent set_sealed_lot_intent while this call waited
-- makes it refuse with SQLSTATE 40001 instead of editing a lot it does not hold.
--
-- CREATE OR REPLACE, not DROP + CREATE: the signature is unchanged from
-- 20260828110000_m10_lot_residual_nok_fix.sql, so no privilege re-grant is required for this
-- function specifically (still restated as a whole in the next milestone's own
-- *_privilege_baseline.sql per house style, unchanged by this migration).

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
  'Recomputes a purchase''s allocations and every existing line''s attributable cost/cost basis atomically. Cannot add or remove lines. Locks every live lot on the purchase (ascending id order) before validating or writing, refuses if any is partially disposed elsewhere. A line with more than one live sibling lot (a sealed-intent split) preserves each sibling''s quantity and redistributes the line''s attributable cost across them exactly; changing such a line''s quantity is refused as ambiguous, as is changing the quantity of a line with removed sibling lots or with no live lot at all (removed units are never resurrected, D-130). P132 (20260914120000) fixed P130-01 (multi-lot fabrication) and this function''s P130-03 slice (unlocked disposal check) together.';
