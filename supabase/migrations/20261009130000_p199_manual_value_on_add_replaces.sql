-- P199 (D-199B): a manual value typed while adding a graded or sealed copy replaces the holding's
-- active manual valuation instead of failing the acquisition.
--
-- add_card_acquisition (p_manual_value_minor) and create_purchase (a line's manual_value_minor) inserted a
-- manual valuation unconditionally. A holding has at most one active valuation
-- (manual_valuations_one_active), so adding a second copy of a graded card or sealed product that already
-- had one raised a raw 23505 and rolled the whole acquisition back - lot, synthetic purchase or receipt -
-- for the exact action the form invites ("Add another copy"). The same happened to two lines for one
-- holding in one receipt.
--
-- The value is per copy and is the same fact as set_manual_valuation: it supersedes the active valuation
-- atomically (superseded_at = the new row's created_at, D-062) and starts no earlier than the row it
-- replaces. Raw cards still refuse a manual value. No other behaviour changes: this file is the P191
-- definition of both functions (20261002140000_p191_ledger_write_gate.sql) with the valuation block
-- replaced. Signatures, ownership, grants and gate flag are unchanged, so no privilege baseline is
-- restated (as in P132). authenticated may UPDATE only manual_valuations.superseded_at (column grant),
-- which is all the replacement needs.
--
-- Backward compatible: existing rows are untouched; callers that never passed a manual value on a
-- holding that already had one see no difference. Production requirement: apply with the normal
-- migration path (no data repair, no backfill).

CREATE OR REPLACE FUNCTION public.add_card_acquisition(p_card_variant_id uuid DEFAULT NULL::uuid, p_manual_card_id uuid DEFAULT NULL::uuid, p_grading_state grading_state DEFAULT 'raw'::grading_state, p_condition card_condition DEFAULT NULL::card_condition, p_grader grader DEFAULT NULL::grader, p_grade numeric DEFAULT NULL::numeric, p_cert_number text DEFAULT NULL::text, p_is_favorite boolean DEFAULT false, p_holding_notes text DEFAULT NULL::text, p_origin lot_origin DEFAULT 'purchase'::lot_origin, p_cost_basis_state cost_basis_state DEFAULT 'unknown'::cost_basis_state, p_unit_cost_basis_minor bigint DEFAULT NULL::bigint, p_quantity integer DEFAULT 1, p_acquired_on date DEFAULT CURRENT_DATE, p_storage_location_id uuid DEFAULT NULL::uuid, p_lot_notes text DEFAULT NULL::text, p_manual_value_minor bigint DEFAULT NULL::bigint, p_sealed_product_id uuid DEFAULT NULL::uuid, p_sealed_intent sealed_intent DEFAULT 'undecided'::sealed_intent, p_client_request_key uuid DEFAULT NULL::uuid)
 RETURNS TABLE(holding_id uuid, lot_id uuid)
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_prev_effective_from date;
  v_prev_created_at timestamptz;
  v_valuation_ts timestamptz;
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
  perform set_config('app.ledger_write', 'rpc', true);
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
      -- P199 (D-199B): a manual value typed while adding a copy is "set the value of this holding"
      -- (per copy), exactly as set_manual_valuation: an existing active valuation is superseded in this
      -- same transaction (the old row ends exactly when the new one begins, D-062) instead of failing
      -- the whole acquisition with a raw unique violation. The replacement never starts before the row it
      -- replaces (an earlier effective_from would sort BEFORE the superseded row and the rebuild would lose
      -- the active value from that row's start), and both timestamps are one explicit value that is
      -- strictly later than the replaced row's created_at - so two lines for one holding in one receipt
      -- (same transaction, same now()) still order deterministically.
      v_prev_effective_from := null;
      v_prev_created_at := null;
      select mv.effective_from, mv.created_at
        into v_prev_effective_from, v_prev_created_at
        from public.manual_valuations mv
       where mv.holding_id = v_holding_id and mv.user_id = v_user_id and mv.superseded_at is null;
      v_valuation_ts := greatest(
        clock_timestamp(),
        coalesce(v_prev_created_at + interval '1 microsecond', clock_timestamp())
      );
      if v_prev_created_at is not null then
        update public.manual_valuations mv
           set superseded_at = v_valuation_ts
         where mv.holding_id = v_holding_id and mv.user_id = v_user_id and mv.superseded_at is null;
      end if;
      insert into public.manual_valuations (
        user_id, holding_id, value_minor, currency, value_nok_minor, effective_from, created_at
      ) values (
        v_user_id, v_holding_id, p_manual_value_minor, 'NOK', p_manual_value_minor,
        greatest(p_acquired_on, coalesce(v_prev_effective_from, p_acquired_on)), v_valuation_ts
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
    --
    -- P94 F-20/F-21: this race-path replay now applies the EXACT SAME voided_at and material-
    -- equivalence checks the early sequential path above already runs, with the identical
    -- external error semantics. Before this fix, a winner's lot voided in the narrow window
    -- between its own commit and this loser's lookup here was returned as a silent "success" —
    -- resurrecting removed inventory from the loser's point of view; a race for a DIFFERENT
    -- logical request (e.g. same key, different grade — F-21) could likewise be handed back the
    -- winner's lot as if it were its own. Both gaps are closed identically to the early path.
    if p_client_request_key is not null then
      select al.holding_id, al.id as lot_id, al.voided_at into v_replay
        from public.acquisition_lots al
       where al.user_id = v_user_id
         and al.client_request_key = p_client_request_key;
      if v_replay.lot_id is not null then
        if v_replay.voided_at is not null then
          raise exception 'idempotency-key-reuse: the original acquisition was already processed '
            'and later corrected/removed; a new logical acquisition requires a new request key';
        end if;
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
$function$;

CREATE OR REPLACE FUNCTION public.create_purchase(p_purchased_on date, p_currency text, p_lines jsonb, p_retailer_id uuid DEFAULT NULL::uuid, p_shipping_minor bigint DEFAULT 0, p_customs_minor bigint DEFAULT 0, p_discount_minor bigint DEFAULT 0, p_fx_rate_to_nok numeric DEFAULT NULL::numeric, p_fx_rate_date date DEFAULT NULL::date, p_fx_source fx_source DEFAULT NULL::fx_source, p_notes text DEFAULT NULL::text, p_idempotency_key uuid DEFAULT NULL::uuid)
 RETURNS purchases
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_prev_effective_from date;
  v_prev_created_at timestamptz;
  v_valuation_ts timestamptz;
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
  perform set_config('app.ledger_write', 'rpc', true);
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
  -- P144/D-135: the discount is allocated by allocate_purchase_discount (goods first, then the part of
  -- the discount that exceeds the goods against the allocated shipping + customs), not by goods weight
  -- alone, so no line's attributable cost can go negative for a receipt the total check above accepts.
  v_alloc_discount := public.allocate_purchase_discount(
    coalesce(p_discount_minor, 0), v_line_totals, v_alloc_ship, v_alloc_customs
  );

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
        -- P199 (D-199B): a manual value typed while adding a copy is "set the value of this holding"
        -- (per copy), exactly as set_manual_valuation: an existing active valuation is superseded in this
        -- same transaction (the old row ends exactly when the new one begins, D-062) instead of failing
        -- the whole acquisition with a raw unique violation. The replacement never starts before the row it
        -- replaces (an earlier effective_from would sort BEFORE the superseded row and the rebuild would lose
        -- the active value from that row's start), and both timestamps are one explicit value that is
        -- strictly later than the replaced row's created_at - so two lines for one holding in one receipt
        -- (same transaction, same now()) still order deterministically.
        v_prev_effective_from := null;
        v_prev_created_at := null;
        select mv.effective_from, mv.created_at
          into v_prev_effective_from, v_prev_created_at
          from public.manual_valuations mv
         where mv.holding_id = v_holding_id and mv.user_id = v_user_id and mv.superseded_at is null;
        v_valuation_ts := greatest(
          clock_timestamp(),
          coalesce(v_prev_created_at + interval '1 microsecond', clock_timestamp())
        );
        if v_prev_created_at is not null then
          update public.manual_valuations mv
             set superseded_at = v_valuation_ts
           where mv.holding_id = v_holding_id and mv.user_id = v_user_id and mv.superseded_at is null;
        end if;
        insert into public.manual_valuations (
          user_id, holding_id, value_minor, currency, value_nok_minor, effective_from, created_at
        ) values (
          v_user_id, v_holding_id, v_manual_value_minor, 'NOK', v_manual_value_minor,
          greatest(p_purchased_on, coalesce(v_prev_effective_from, p_purchased_on)), v_valuation_ts
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
$function$;
