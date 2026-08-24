-- P28 — Holding Detail quantity reduction (BACKLOG.md "Holding-level quantity reduction and
-- removal", owner-requested after M12). This is a CORRECTION lifecycle, not a sale: no proceeds,
-- no sale row, no realized result, no fake zero-price disposition.
--
-- WHAT ALREADY EXISTED, AND WHAT WAS MISSING.
--
-- Whole-holding removal has shipped since M8.1: void_acquisition_lot voids one lot (refusing any
-- lot that has already been partially disposed elsewhere), and remove_holdings_from_portfolio
-- voids every live lot of given holdings atomically. Both are reused unchanged by this feature's
-- UI for "Remove from Portfolio" (quantity = 1) and "Remove all".
--
-- A purchased lot's QUANTITY is corrected through the receipt itself: update_purchase accepts a
-- changed line quantity, recomputes every allocation and that lot's cost basis atomically, so
-- inventory and money move together by construction. Silently shrinking a purchased lot here
-- instead would desync it from its purchase_line — CS/GPO would keep counting spend for copies
-- the lot no longer holds, and the D-060 reconciliation identity (quantity × unit + residual =
-- attributable cost) would break. So purchased lots are REFUSED below, on purpose; the UI routes
-- them to /purchases/$id/edit.
--
-- What was genuinely missing is partial reduction of a NON-purchase lot: gift / pre_tracking /
-- found / opening / trade_in lots carry purchase_line_id IS NULL (the schema CHECK guarantees a
-- known-cost lot always cites its purchase line, so anything without one has NO money recorded
-- anywhere — reducing it touches no financial row at all). reduce_holding_quantity closes exactly
-- that gap, atomically across every lot one adjustment touches.
--
-- SEMANTICS (all mirroring set_sealed_lot_intent's established shrink pattern, 20260829120000):
--   * Both quantity and quantity_remaining shrink by the same amount, so invariant D1
--     (quantity_remaining = quantity − Σ non-voided disposals) stays satisfied by construction —
--     legal only because the same guard family update_purchase/void_purchase/void_acquisition_lot
--     already enforce (quantity_remaining = quantity) means no disposal row exists against the lot.
--   * unit_cost_basis_* stays NULL (it must be — non-known states never carry one); residual_*
--     stays 0 (no allocation ever ran for a lot without a purchase line); origin, acquired_on,
--     storage_location_id and sealed_intent are untouched — provenance is preserved, not rewritten.
--   * History is rewritten to corrected truth, exactly like every other correction in this schema:
--     FINANCIAL_MODEL.md §3 derives ownership from CURRENT canonical rows replayed per date, and
--     the M12 invalidation trigger portfolio_recompute_lot_updated (UPDATE OF quantity,
--     quantity_remaining ...) enqueues the recompute naturally. No manual queue writes here.
--   * A holding always keeps at least one owned unit through this path. Removing the last unit is
--     the existing Remove from Portfolio flow (void semantics, history preserved).
--
-- CONCURRENCY (Prompt 32 repair of Claude's PR #42 review findings): the "never removes the last
-- owned unit" invariant above must hold under CONCURRENT calls, not just sequential ones. The
-- first draft computed v_owned_total with a plain unlocked aggregate before locking anything, so
-- two simultaneous adjustments targeting different sibling lots of one holding (A=5, B=5) could
-- each read total=10, each pass 5 < 10, and jointly commit the holding to zero. Fixed by making
-- serialization explicit, in create_sale's established style (20260828120010 pass 2):
--   Pass 1 parses/validates the whole payload BEFORE any database access, so malformed input still
--   aborts with zero mutation and — newly — without acquiring a single lock.
--   Pass 2 then locks EVERY live sibling lot of the holding (p_holding_id + auth.uid(), never
--   another user's rows) FOR UPDATE in ascending lot-id order — one statement, so two concurrent
--   adjustments of the same holding fully serialize regardless of which lots each names; a
--   concurrent insert of a NEW lot needs no row lock and only ever RAISES the real owned total,
--   so validating against the pre-insert total is conservative-safe for the invariant.
--   Only after those locks are held is v_owned_total computed (an aggregate itself cannot take
--   row locks that mean anything — lock the underlying rows first), and the per-lot guards then
--   run on already-held locks (plain SELECTs; no second, conflicting lock order).
--   Ascending lot-id order matches create_sale's convention exactly (which locks its referenced
--   lots the same way), so reduce vs create_sale on overlapping lots cannot deadlock either: both
--   acquire in one global order. The legacy M8.1 remove/void path takes its write locks only at
--   UPDATE time in plan order; against that unordered order a theoretical 40P01 deadlock remains
--   possible (pre-existing exposure class, not introduced here) — Postgres detects it, aborts one
--   side with zero mutation, and a retry succeeds. See output_32's cross-operation analysis.
--
-- INPUT CONTRACT: p_lot_reductions must arrive as an actual JSON array (the browser wrapper passes
-- a JavaScript array; PostgREST casts it to jsonb). A stringified payload ('[{"lot_id":...}]')
-- arrives as a jsonb STRING scalar and is rejected by the array guard — deliberately strict, so a
-- broken caller fails loudly instead of being silently reinterpreted. Entries are validated as
-- {lot_id uuid, remove_quantity positive-integer-text}; anything else aborts the whole call with
-- zero mutations.
--
-- SECURITY INVOKER: RLS already lets an owner touch their own acquisition_lots rows; like
-- set_sealed_lot_intent, the RPC exists because several guarded writes plus a cross-lot total
-- check must succeed or fail as ONE transaction, which separate REST calls cannot guarantee.
-- Ownership comes from auth.uid() alone — there is no user_id parameter to forge.

create function public.reduce_holding_quantity(
  p_holding_id uuid,
  p_lot_reductions jsonb
)
returns table (owned_quantity integer)
language plpgsql
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_owned_total int;
  v_remove_total int := 0;
  v_entry jsonb;
  v_idx int;
  v_lot_id uuid;
  v_remove_text text;
  v_remove int;
  v_lot public.acquisition_lots;
  v_lot_ids uuid[] := '{}';
  v_removes int[] := '{}';
begin
  if v_user_id is null then
    raise exception 'not authenticated';
  end if;

  if p_holding_id is null then
    raise exception 'p_holding_id is required';
  end if;
  -- Separate statements, not one OR chain: Postgres does not guarantee evaluation order across
  -- OR, and jsonb_array_length errors outright on a non-array value.
  if p_lot_reductions is null or jsonb_typeof(p_lot_reductions) is distinct from 'array' then
    raise exception 'p_lot_reductions must be a JSON array of {lot_id, remove_quantity} objects';
  end if;
  if jsonb_array_length(p_lot_reductions) = 0 then
    raise exception 'p_lot_reductions must contain at least one reduction';
  end if;

  -- Pass 1 — parse and validate the whole payload BEFORE any database access. Strict integer
  -- text, not a bare ::int cast: '1.5'::int silently ROUNDS to 2 in Postgres, which would quietly
  -- adjust a different quantity than the caller sent. Digits only — a missing, fractional,
  -- negative or non-numeric value all reject with the same message. Separate statements again:
  -- Postgres does not guarantee OR evaluation order, and the cast must never run on text the
  -- pattern check has not vetted. Nothing below can run until every entry has passed here, so
  -- malformed input still aborts with zero mutation (and, newly, zero locks taken).
  for v_idx in 0 .. jsonb_array_length(p_lot_reductions) - 1 loop
    v_entry := p_lot_reductions -> v_idx;
    v_lot_id := nullif(v_entry ->> 'lot_id', '')::uuid;
    v_remove_text := v_entry ->> 'remove_quantity';

    if v_lot_id is null then
      raise exception 'reduction %: lot_id is required', v_idx;
    end if;
    if v_remove_text is null then
      raise exception 'reduction %: remove_quantity must be a positive integer', v_idx;
    end if;
    if v_remove_text !~ '^[0-9]+$' then
      raise exception 'reduction %: remove_quantity must be a positive integer', v_idx;
    end if;
    v_remove := v_remove_text::int;
    if v_remove <= 0 then
      raise exception 'reduction %: remove_quantity must be a positive integer', v_idx;
    end if;
    if v_lot_id = any(v_lot_ids) then
      raise exception 'lot % appears more than once', v_lot_id;
    end if;
    v_lot_ids := v_lot_ids || v_lot_id;
    v_removes := v_removes || v_remove;
  end loop;

  -- Pass 2 — serialize quantity changes for this holding. Lock EVERY live sibling lot (not just
  -- the requested subset) FOR UPDATE, in ascending lot-id order — create_sale's established
  -- convention against concurrent multi-lot deadlocks. One statement means two simultaneous
  -- adjustments of the same holding fully serialize no matter which lots each names: the second
  -- waits here until the first commits, then re-reads and validates against the UPDATED state.
  -- The user_id predicate guarantees a forged p_holding_id can never lock or even inspect another
  -- user's rows.
  perform 1
    from public.acquisition_lots al
   where al.holding_id = p_holding_id
     and al.user_id = v_user_id
     and al.voided_at is null
   order by al.id
   for update;

  -- Pass 3 — only now compute the owned total, under the held locks. An aggregate cannot take
  -- meaningful row locks itself; locking the underlying rows first is what makes this figure
  -- trustworthy against concurrent siblings.
  select coalesce(sum(al.quantity_remaining), 0)::int into v_owned_total
    from public.acquisition_lots al
    join public.holdings h on h.id = al.holding_id
   where al.holding_id = p_holding_id
     and al.user_id = v_user_id
     and h.user_id = v_user_id
     and al.voided_at is null;

  -- Pass 4 — per-lot validation on already-held locks (plain SELECTs: pass 2 holds every sibling
  -- lock, so introducing FOR UPDATE here would only add a second, redundant acquisition path).
  -- Same all-or-nothing posture as remove_holdings_from_portfolio: nothing is written until every
  -- entry has validated; any raise aborts the whole call with zero mutations.
  for v_idx in 1 .. array_length(v_lot_ids, 1) loop
    select * into v_lot
      from public.acquisition_lots al
     where al.id = v_lot_ids[v_idx]
       and al.holding_id = p_holding_id
       and al.user_id = v_user_id
       and al.voided_at is null;
    if v_lot.id is null then
      raise exception 'acquisition lot % not found on holding %', v_lot_ids[v_idx], p_holding_id;
    end if;

    -- Partial disposal first: it is the terminal obstruction. A purchased AND partially-sold lot
    -- cannot be corrected through the receipt editor either (update_purchase refuses partially
    -- disposed lots), so routing the caller to Purchases would be advice that fails — same
    -- precedence AdjustQuantitySheet renders (purchased && !partiallyDisposed is the only case
    -- that links to the receipt editor; any disposed lot reads "Can't adjust").
    if v_lot.quantity_remaining <> v_lot.quantity then
      raise exception
        'acquisition lot % has already been partially disposed elsewhere (% of % remaining) and cannot be adjusted here',
        v_lot.id, v_lot.quantity_remaining, v_lot.quantity;
    end if;
    -- Purchased copies are corrected through their receipt (update_purchase), which rewrites
    -- allocations and cost basis atomically with the quantity. Never silently desync a lot from
    -- its purchase_line here.
    if v_lot.purchase_line_id is not null then
      raise exception
        'lot % came from a purchase - correct its quantity by editing that receipt in Purchases',
        v_lot.id;
    end if;
    if v_removes[v_idx] > v_lot.quantity_remaining then
      raise exception 'reduction %: remove_quantity exceeds the lot''s remaining quantity (%)',
        v_idx - 1, v_lot.quantity_remaining;
    end if;

    v_remove_total := v_remove_total + v_removes[v_idx];
  end loop;

  -- The adjustment path always leaves the holding alive; removing the last unit belongs to the
  -- Remove-from-Portfolio flow (void_acquisition_lot / remove_holdings_from_portfolio). With
  -- every sibling locked, this check is now race-free: a concurrent adjustment of ANY lot of
  -- this holding committed before we got here and is already reflected in v_owned_total.
  if v_remove_total >= v_owned_total then
    raise exception
      'this adjustment would remove every remaining copy - use Remove from Portfolio for that';
  end if;

  -- Pass 5 — updates, only after all validation passed. Every target row is already locked by
  -- this transaction, so iteration order cannot deadlock.
  for v_idx in 1 .. array_length(v_lot_ids, 1) loop
    update public.acquisition_lots
       set quantity = quantity - v_removes[v_idx],
           quantity_remaining = quantity_remaining - v_removes[v_idx]
     where id = v_lot_ids[v_idx]
       and user_id = v_user_id;
  end loop;

  return query select v_owned_total - v_remove_total;
end;
$$;

comment on function public.reduce_holding_quantity(uuid, jsonb) is
  'Correction path for a non-purchase lot''s tracked quantity (gift/pre_tracking/found/opening/trade_in): shrinks quantity and quantity_remaining together per lot, atomically across the whole adjustment, preserving provenance and leaving every financial row untouched. Serializes concurrent adjustments of one holding by locking all its live sibling lots in ascending lot-id order before computing the owned total, so no adjustment can remove a holding''s final owned unit even when two calls race on different lots. Refuses purchased lots (correct via update_purchase), partially-disposed lots, and adjustments that would remove a holding''s last unit. See BACKLOG.md / DECISIONS.md and 20260829120000''s shrink precedent.';

-- PostgreSQL grants EXECUTE on a newly created function to PUBLIC by default — revoke explicitly
-- at creation, same as every function-creating migration since M4. The restated privilege baseline
-- that follows this migration carries the same grant.
revoke execute on function public.reduce_holding_quantity(uuid, jsonb) from public;
grant execute on function public.reduce_holding_quantity(uuid, jsonb) to authenticated;
