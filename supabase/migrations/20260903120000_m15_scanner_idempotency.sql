-- M15: Server-side idempotency for add_card_acquisition (D-096).
--
-- Scanner's sequential batch commit calls add_card_acquisition once per card. When an ambiguous
-- transport failure occurs (response lost after the RPC may have committed), the client retries
-- only the unresolved items. Without idempotency the retry duplicates every committed row.
--
-- Design (adapted from D-089's opening idempotency):
--   - An optional p_client_request_key (uuid, default NULL) is added to the RPC signature.
--   - acquisition_lots gains a nullable client_request_key column with a partial unique index
--     on (user_id, client_request_key) WHERE client_request_key IS NOT NULL.
--   - Before creating a new lot the function checks for an existing lot with the same key
--     under the same user. If found, it returns the ORIGINAL holding/lot pair — no second lot,
--     no second quantity increase.
--   - If the insert races the check (two concurrent calls with the same key), the unique index
--     fires a unique_violation; the outer exception handler catches it and replays the original
--     result. The implicit savepoint created by the outer BEGIN block ensures that ALL mutations
--     (purchase, purchase_line, holding attempt, lot insert, manual valuation) are rolled back
--     when the losing transaction's lot INSERT fires unique_violation.
--   - Existing non-scanner callers omit the parameter (NULL default) and behave exactly as before.
--   - No user-supplied target user_id: ownership is always auth.uid().
--   - The client_request_key is operational retry metadata, NOT user financial data: it is
--     excluded from M13 backup/export (Backup v2 does not SELECT this column) and does not
--     survive a reset that deletes the associated acquisition_lots rows.
--   - Material mismatch detection: replaying the same key with different material facts is
--     rejected to prevent silent data loss.
--   - Voided lot detection: replaying a key that was later voided is rejected to prevent
--     resurrection of removed inventory.
--
-- DROP+CREATE (D-054/D-059 discipline): adding a parameter changes a function's identity.

-- 1. Schema change: add client_request_key to acquisition_lots
alter table public.acquisition_lots
  add column client_request_key uuid;

comment on column public.acquisition_lots.client_request_key is
  'Optional client-generated idempotency key for server-side retry deduplication (D-096). '
  'NULL for all pre-existing callers and non-scanner acquisitions. Unique per user when set. '
  'Operational metadata — excluded from backup/export and does not survive a clean reset.';

-- Partial unique index: only enforced when the key is not NULL, so existing NULL rows
-- and future NULL callers are unaffected.
create unique index acquisition_lots_user_client_request_key_idx
  on public.acquisition_lots (user_id, client_request_key)
  where client_request_key is not null;

-- 2. Modify the add_card_acquisition RPC
-- DROP the M11 19-parameter signature, CREATE with the new 20-parameter signature.
-- All existing parameters keep their exact positions, types and defaults.

drop function if exists public.add_card_acquisition(
  uuid, uuid, public.grading_state, public.card_condition, public.grader, numeric,
  text, boolean, text, public.lot_origin, public.cost_basis_state, bigint, int, date, uuid, text,
  bigint, uuid, public.sealed_intent
);

create function public.add_card_acquisition(
  p_card_variant_id uuid default null,
  p_manual_card_id uuid default null,
  p_grading_state public.grading_state default 'raw',
  p_condition public.card_condition default null,
  p_grader public.grader default null,
  p_grade numeric(3, 1) default null,
  p_cert_number text default null,
  p_is_favorite boolean default false,
  p_holding_notes text default null,
  p_origin public.lot_origin default 'purchase',
  p_cost_basis_state public.cost_basis_state default 'unknown',
  p_unit_cost_basis_minor bigint default null,
  p_quantity int default 1,
  p_acquired_on date default current_date,
  p_storage_location_id uuid default null,
  p_lot_notes text default null,
  p_manual_value_minor bigint default null,
  p_sealed_product_id uuid default null,
  p_sealed_intent public.sealed_intent default 'undecided',
  -- NEW: optional client-generated idempotency key for safe scanner retry (D-096).
  -- NULL for all existing callers; scanner generates one UUID per logical batch item.
  p_client_request_key uuid default null
)
returns table (holding_id uuid, lot_id uuid)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_holding_kind public.holding_kind;
  v_holding_id uuid;
  v_lot_id uuid;
  v_purchase_id uuid;
  v_purchase_line_id uuid;
  v_total_minor bigint;
  v_description text;
  v_identity_count int;
  v_replay record;
  v_holding_replay_id uuid;
begin
  if v_user_id is null then
    raise exception 'not authenticated';
  end if;

  v_identity_count := (p_card_variant_id is not null)::int
    + (p_manual_card_id is not null)::int
    + (p_sealed_product_id is not null)::int;
  if v_identity_count <> 1 then
    raise exception 'exactly one of p_card_variant_id / p_manual_card_id / p_sealed_product_id is required';
  end if;

  if p_quantity is null or p_quantity <= 0 then
    raise exception 'p_quantity must be a positive integer';
  end if;

  if p_acquired_on is null then
    raise exception 'p_acquired_on is required';
  end if;

  if p_sealed_product_id is not null then
    v_holding_kind := 'sealed';
    p_condition := null;
    p_grading_state := 'raw';
    p_grader := null;
    p_grade := null;
    if p_sealed_intent is null then
      raise exception 'p_sealed_intent is required for a sealed product';
    end if;
    if not exists (select 1 from public.sealed_products where id = p_sealed_product_id) then
      raise exception 'sealed product % not found or not accessible', p_sealed_product_id;
    end if;
  else
    v_holding_kind := case p_grading_state
      when 'graded' then 'graded_card'::public.holding_kind
      else 'raw_card'::public.holding_kind
    end;
    if v_holding_kind = 'raw_card' and p_condition is null then
      raise exception 'p_condition is required for a raw card';
    end if;
    if v_holding_kind = 'graded_card' and (p_grader is null or p_grade is null) then
      raise exception 'p_grader and p_grade are required for a graded card';
    end if;
  end if;

  -- ── Early idempotent replay (D-096) ───────────────────────────────────────────────────────────
  -- A committed-but-unanswered request must return the SAME holding/lot on retry, never a
  -- second acquisition. The key is only honored when not NULL; NULL callers (existing callers,
  -- non-scanner acquisitions) behave exactly as before.
  --
  -- This check runs BEFORE any mutation. If the lot already exists, we verify:
  --   1. The lot is not voided (voided_at IS NULL) — a stale retry after void must NOT
  --      resurrect removed inventory.
  --   2. Material facts match (identity, grading, quantity, origin, cost, date, storage) —
  --      a key reused with different material is rejected.
  if p_client_request_key is not null then
    select al.holding_id, al.id as lot_id,
           al.voided_at,
           al.holding_id as r_holding_id
      into v_replay
      from public.acquisition_lots al
     where al.user_id = v_user_id
       and al.client_request_key = p_client_request_key
     limit 1;
    -- NOTE: `v_replay is not null` is a row-wise NULL test — for a mixed record (voided_at NULL
    -- while the other columns are non-null, the common case) BOTH "is null" and "is not null"
    -- evaluate false, silently skipping this whole block. Test the NOT NULL lot_id column
    -- instead — a reliable "was a row found" check.
    if v_replay.lot_id is not null then
      -- Check voided: stale retry after void must be rejected.
      if v_replay.voided_at is not null then
        raise exception 'idempotency-key-reuse: the original acquisition was already processed '
          'and later corrected/removed; a new logical acquisition requires a new request key';
      end if;
      -- Material mismatch check: verify the persisted facts match the request.
      -- Compare against the lot's holding for identity fields, and the lot itself for lot fields.
      if not exists (
        select 1
          from public.holdings h
          join public.acquisition_lots al2 on al2.holding_id = h.id
         where al2.id = v_replay.lot_id
           and h.user_id = v_user_id
           and h.holding_kind = v_holding_kind
           and coalesce(h.card_variant_id, h.sealed_product_id, h.manual_card_id)
               = coalesce(p_card_variant_id, p_sealed_product_id, p_manual_card_id)
           and coalesce(public.card_condition_to_text(h.condition), '')
               = coalesce(public.card_condition_to_text(p_condition), '')
           and h.grading_state = p_grading_state
           and coalesce(public.grader_to_text(h.grader), '') = coalesce(public.grader_to_text(p_grader), '')
           and coalesce(h.grade, -1) = coalesce(p_grade, -1)
           and al2.origin = p_origin
           and al2.cost_basis_state = p_cost_basis_state
           and (al2.unit_cost_basis_minor is not distinct from
                case when p_cost_basis_state = 'known' then p_unit_cost_basis_minor end)
           and al2.quantity = p_quantity
           and al2.acquired_on = p_acquired_on
           and (al2.storage_location_id is not distinct from p_storage_location_id)
      ) then
        raise exception 'idempotency-key-reuse: key % already belongs to a different '
          'acquisition request', p_client_request_key;
      end if;
      -- Valid replay: return the original lot.
      holding_id := v_replay.holding_id;
      lot_id := v_replay.lot_id;
      return next;
      return;
    end if;
  end if;

  -- ── All mutations inside one outer BEGIN/EXCEPTION block ───────────────────────────────────────
  -- The outer BEGIN creates an implicit savepoint. If the lot INSERT fires unique_violation
  -- (a concurrent call committed first with the same client_request_key), the EXCEPTION
  -- handler rolls back ALL changes inside the block — including the purchase/purchase_line
  -- inserts from this losing transaction. The handler then re-reads the winner's committed
  -- lot and returns it, leaving zero orphan financial rows.
  --
  -- The holdings find-or-create race handler remains as a nested BEGIN/EXCEPTION inside this
  -- block. It handles the DIFFERENT unique constraint (holdings_identity) and is necessary
  -- for the normal concurrent-add path where two different users or different keys legitimately
  -- create the same holding.

  begin
    -- ── Purchase + purchase line, only when the cost is actually known ──────────────────────────
    if p_cost_basis_state = 'known' then
      if p_unit_cost_basis_minor is null or p_unit_cost_basis_minor < 0 then
        raise exception 'p_unit_cost_basis_minor must be a non-negative amount when cost is known';
      end if;
      v_total_minor := p_unit_cost_basis_minor * p_quantity;

      if p_manual_card_id is not null then
        select name into v_description from public.manual_card_definitions where id = p_manual_card_id;
      elsif p_sealed_product_id is not null then
        select name into v_description from public.sealed_products where id = p_sealed_product_id;
      end if;

      insert into public.purchases (
        user_id, origin, purchased_on, currency,
        subtotal_minor, shipping_minor, customs_minor, discount_minor, total_minor,
        fx_rate_to_nok, fx_rate_date, fx_source, total_nok_minor
      ) values (
        v_user_id, 'manual', p_acquired_on, 'NOK',
        v_total_minor, 0, 0, 0, v_total_minor,
        1, p_acquired_on, 'manual', v_total_minor
      )
      returning id into v_purchase_id;

      insert into public.purchase_lines (
        purchase_id, user_id, line_type, spend_class, description,
        card_variant_id, sealed_product_id, condition, quantity, unit_price_minor, line_total_minor,
        attributable_cost_minor, attributable_cost_nok_minor
      ) values (
        v_purchase_id, v_user_id,
        case when p_sealed_product_id is not null then 'sealed' else 'card' end::public.line_type,
        'collectible', v_description,
        p_card_variant_id, p_sealed_product_id, p_condition, p_quantity, p_unit_cost_basis_minor,
        v_total_minor, v_total_minor, v_total_minor
      )
      returning id into v_purchase_line_id;
    end if;

    -- ── Find-or-create the holding, race-safe via holdings_identity ─────────────────────────────
    begin
      insert into public.holdings (
        user_id, holding_kind, card_variant_id, manual_card_id, sealed_product_id,
        condition, grading_state, grader, grade, cert_number, is_favorite, notes
      ) values (
        v_user_id, v_holding_kind, p_card_variant_id, p_manual_card_id, p_sealed_product_id,
        p_condition, p_grading_state, p_grader, p_grade, p_cert_number, p_is_favorite, p_holding_notes
      )
      returning id into v_holding_id;
    exception when unique_violation then
      select id into v_holding_id
        from public.holdings
        where user_id = v_user_id
          and holding_kind = v_holding_kind
          and coalesce(card_variant_id, sealed_product_id, manual_card_id)
              = coalesce(p_card_variant_id, p_sealed_product_id, p_manual_card_id)
          and coalesce(public.card_condition_to_text(condition), '')
              = coalesce(public.card_condition_to_text(p_condition), '')
          and grading_state = p_grading_state
          and coalesce(public.grader_to_text(grader), '') = coalesce(public.grader_to_text(p_grader), '')
          and coalesce(grade, -1) = coalesce(p_grade, -1)
          and deleted_at is null;
      if v_holding_id is null then
        raise;
      end if;
    end;

    -- ── The acquisition lot itself ─────────────────────────────────────────────────────────────
    insert into public.acquisition_lots (
      holding_id, user_id, origin, cost_basis_state, purchase_line_id, acquired_on,
      quantity, quantity_remaining, unit_cost_basis_minor, cost_basis_currency,
      unit_cost_basis_nok_minor, storage_location_id, notes, sealed_intent,
      client_request_key
    ) values (
      v_holding_id, v_user_id, p_origin, p_cost_basis_state, v_purchase_line_id, p_acquired_on,
      p_quantity, p_quantity,
      case when p_cost_basis_state = 'known' then p_unit_cost_basis_minor end,
      case when p_cost_basis_state = 'known' then 'NOK' end,
      case when p_cost_basis_state = 'known' then p_unit_cost_basis_minor end,
      p_storage_location_id, p_lot_notes,
      case when v_holding_kind = 'sealed' then p_sealed_intent end,
      p_client_request_key
    )
    returning id into v_lot_id;

    -- ── Optional manual value, set at the moment it is added ────────────────────────────────────
    if p_manual_value_minor is not null then
      if v_holding_kind not in ('graded_card', 'sealed') then
        raise exception 'p_manual_value_minor is only meaningful for a graded or sealed holding';
      end if;
      insert into public.manual_valuations (
        user_id, holding_id, value_minor, currency, value_nok_minor, effective_from
      ) values (
        v_user_id, v_holding_id, p_manual_value_minor, 'NOK', p_manual_value_minor, p_acquired_on
      );
    end if;

  exception when unique_violation then
    -- The outer block catches unique_violation from ANY INSERT inside it. We need to distinguish
    -- the idempotency-key race (acquisition_lots partial unique index) from the holdings-identity
    -- race (already handled by the nested handler above). If we reach the outer handler, it means
    -- the nested holdings handler did NOT fire — so the unique_violation is from the lot INSERT.
    --
    -- Only treat as idempotent replay when:
    --   1. p_client_request_key IS NOT NULL (a keyed request)
    --   2. A row for (user_id, client_request_key) actually exists after rollback
    --      (confirms it was the idempotency index that fired, not some other constraint)
    --
    -- If no matching keyed lot exists, this is an unrelated uniqueness failure — re-raise.
    if p_client_request_key is not null then
      select al.holding_id, al.id as lot_id into v_replay
        from public.acquisition_lots al
       where al.user_id = v_user_id
         and al.client_request_key = p_client_request_key;
      if v_replay.lot_id is not null then
        -- Idempotent replay detected at INSERT time.
        -- The implicit savepoint has rolled back ALL changes inside the outer BEGIN block:
        --   - This transaction's purchase/purchase_line rows: GONE
        --   - This transaction's holding INSERT attempt (if it created one): GONE
        --   - This transaction's lot INSERT attempt: GONE (it failed)
        -- We return the winner's committed lot. Zero orphan financial rows.
        holding_id := v_replay.holding_id;
        lot_id := v_replay.lot_id;
        return next;
        return;
      end if;
    end if;
    -- Not an idempotency race — re-raise the original constraint violation.
    raise;
  end;

  return query select v_holding_id, v_lot_id;
end;
$$;

comment on function public.add_card_acquisition(
  uuid, uuid, public.grading_state, public.card_condition, public.grader, numeric,
  text, boolean, text, public.lot_origin, public.cost_basis_state, bigint, int, date, uuid, text,
  bigint, uuid, public.sealed_intent, uuid
) is
  'Atomic add-to-collection for a card, manual card, or sealed product: finds or creates the '
  'holding, then writes one acquisition lot (with sealed_intent for a sealed lot) and, when the '
  'cost is known, the single-line purchase it traces to. Server-side idempotent via optional '
  'p_client_request_key (D-096): same key returns the original holding/lot pair; NULL key '
  '(existing callers) behaves exactly as before. All mutations inside one outer BEGIN/EXCEPTION '
  'block ensures that a losing concurrent keyed transaction leaves zero orphan financial rows.';

-- 3. Revoke from PUBLIC and grant to authenticated with the NEW signature.
revoke execute on function public.add_card_acquisition(
  uuid, uuid, public.grading_state, public.card_condition, public.grader, numeric,
  text, boolean, text, public.lot_origin, public.cost_basis_state, bigint, int, date, uuid, text,
  bigint, uuid, public.sealed_intent, uuid
) from public;

grant execute on function public.add_card_acquisition(
  uuid, uuid, public.grading_state, public.card_condition, public.grader, numeric,
  text, boolean, text, public.lot_origin, public.cost_basis_state, bigint, int, date, uuid, text,
  bigint, uuid, public.sealed_intent, uuid
) to authenticated;
