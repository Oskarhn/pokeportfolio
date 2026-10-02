-- P191 / P130-13: the browser can no longer edit the ledger directly.
--
-- THE PROBLEM. `authenticated` holds INSERT / column-UPDATE (and, for holdings, DELETE) on the five
-- ledger tables — purchases, purchase_lines, acquisition_lots, holdings, manual_valuations — because
-- ten of the functions that legitimately write them are SECURITY INVOKER and run with the caller's
-- own table privileges. Anyone holding the public publishable key and a session could therefore
-- `PATCH /rest/v1/acquisition_lots {quantity_remaining: 999}` or insert a purchase whose total does
-- not match its lines, bypassing every invariant the RPCs enforce. (Self-only — RLS still confines a
-- user to their own rows — but a ledger an owner can silently corrupt is not a ledger.)
--
-- WHY NOT JUST REVOKE. The writers are INVOKER: revoking the grants breaks them. Flipping them to
-- SECURITY DEFINER would also drop RLS from every statement in ten large function bodies, so each
-- query would need re-auditing for cross-user reach. This migration changes neither.
--
-- THE DESIGN. A write gate. A BEFORE trigger on each ledger table refuses INSERT / DELETE — and any
-- UPDATE that touches a column outside the small browser-editable set — when the statement runs as
-- a Data API role (`authenticated` / `anon`) AND the transaction is not inside one of the
-- authoritative writer functions. The writers announce themselves by calling
--
--     perform set_config('app.ledger_write', 'rpc', true);
--
-- as the first statement of their body (transaction-local). Why a client cannot do the same:
-- PostgREST gives a request no way to run `SET` or `set_config` (the `public` schema is the only
-- one exposed, and the only functions granted are the allowlisted RPCs); it forwards request data
-- only as `request.*` settings. Roles other than the Data API roles — the definer-owned functions
-- (create_sale, create_opening, reset, account purge...), `service_role`, `postgres` — pass the gate
-- untouched, so SECURITY DEFINER writers and operator tooling need no flag.
--
-- FAIL-CLOSED MAINTENANCE. The flag lives in the function body. If a later migration re-creates one
-- of the ten writers from an older copy that lacks the line, the gate refuses the writer's own
-- statements and every test of that RPC fails — a loud failure, never a silent bypass.
-- tests/db/p191_ledger_write_gate.test.ts and scripts/grant-audit.sql also pin the writer list.
--
-- BROWSER-EDITABLE COLUMNS (everything else is RPC-only). The web and native clients write exactly
-- these directly (src/data/collection.ts): holdings.is_favorite, holdings.notes,
-- acquisition_lots.storage_location_id, acquisition_lots.acquired_on, acquisition_lots.notes.
-- None of them is a quantity, a cost, a price or a status.
--
-- No grant changes: the table privileges stay as they are, so the privilege baseline and
-- scripts/grant-audit.sql are unchanged by this file (the gate triggers are asserted separately).

create or replace function public.enforce_ledger_write_gate()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_open text[] := coalesce(tg_argv, '{}'::text[]);
begin
  -- Only the browser-reachable roles are gated. Definer-owned functions, service_role and
  -- operators run as another current_user and are not the surface this closes.
  if current_user not in ('authenticated', 'anon') then
    return case tg_op when 'DELETE' then old else new end;
  end if;

  if coalesce(current_setting('app.ledger_write', true), '') = 'rpc' then
    return case tg_op when 'DELETE' then old else new end;
  end if;

  if tg_op = 'UPDATE'
     and (to_jsonb(new) - 'updated_at' - v_open) = (to_jsonb(old) - 'updated_at' - v_open) then
    return new;
  end if;

  raise exception 'direct writes to % are not permitted; use the provided operation', tg_table_name
    using errcode = '42501';
end;
$$;

-- Sorts before every other BEFORE trigger on these tables (alphabetical firing order), so a refused
-- write never reaches the owner / date-contract triggers and cannot be used to probe them.
create trigger a00_ledger_write_gate
  before insert or update or delete on public.purchases
  for each row execute function public.enforce_ledger_write_gate();

create trigger a00_ledger_write_gate
  before insert or update or delete on public.purchase_lines
  for each row execute function public.enforce_ledger_write_gate();

create trigger a00_ledger_write_gate
  before insert or update or delete on public.manual_valuations
  for each row execute function public.enforce_ledger_write_gate();

create trigger a00_ledger_write_gate
  before insert or update or delete on public.holdings
  for each row execute function public.enforce_ledger_write_gate('is_favorite', 'notes');

create trigger a00_ledger_write_gate
  before insert or update or delete on public.acquisition_lots
  for each row execute function public.enforce_ledger_write_gate(
    'storage_location_id', 'acquired_on', 'notes'
  );

-- The ten SECURITY INVOKER writers, re-created VERBATIM from their live definitions (as of
-- 20261002130000) with exactly one added statement as the first line of the body:
--
--     perform set_config('app.ledger_write', 'rpc', true);
--
-- (A function-level `ALTER FUNCTION ... SET app.ledger_write` would need no body edit, but
-- Postgres refuses a non-superuser `SET` of an unregistered custom parameter — "permission denied
-- to set parameter" — on the local stack and so on a hosted project. `set_config` from inside the
-- function is allowed.) The setting is transaction-local: PostgREST runs one RPC per transaction, so
-- it is never live for any statement a client chose. Grants are unchanged (CREATE OR REPLACE keeps
-- them). tests/db/p191_ledger_write_gate.test.ts asserts every writer carries the line.

-- ── add_card_acquisition ──
CREATE OR REPLACE FUNCTION public.add_card_acquisition(p_card_variant_id uuid DEFAULT NULL::uuid, p_manual_card_id uuid DEFAULT NULL::uuid, p_grading_state grading_state DEFAULT 'raw'::grading_state, p_condition card_condition DEFAULT NULL::card_condition, p_grader grader DEFAULT NULL::grader, p_grade numeric DEFAULT NULL::numeric, p_cert_number text DEFAULT NULL::text, p_is_favorite boolean DEFAULT false, p_holding_notes text DEFAULT NULL::text, p_origin lot_origin DEFAULT 'purchase'::lot_origin, p_cost_basis_state cost_basis_state DEFAULT 'unknown'::cost_basis_state, p_unit_cost_basis_minor bigint DEFAULT NULL::bigint, p_quantity integer DEFAULT 1, p_acquired_on date DEFAULT CURRENT_DATE, p_storage_location_id uuid DEFAULT NULL::uuid, p_lot_notes text DEFAULT NULL::text, p_manual_value_minor bigint DEFAULT NULL::bigint, p_sealed_product_id uuid DEFAULT NULL::uuid, p_sealed_intent sealed_intent DEFAULT 'undecided'::sealed_intent, p_client_request_key uuid DEFAULT NULL::uuid)
 RETURNS TABLE(holding_id uuid, lot_id uuid)
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
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

-- ── clear_manual_valuation ──
CREATE OR REPLACE FUNCTION public.clear_manual_valuation(p_holding_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_user_id uuid := auth.uid();
begin
  perform set_config('app.ledger_write', 'rpc', true);
  if v_user_id is null then
    raise exception 'not authenticated';
  end if;

  update public.manual_valuations
    set superseded_at = now()
    where holding_id = p_holding_id
      and user_id = v_user_id
      and superseded_at is null;
end;
$function$;

-- ── create_purchase ──
CREATE OR REPLACE FUNCTION public.create_purchase(p_purchased_on date, p_currency text, p_lines jsonb, p_retailer_id uuid DEFAULT NULL::uuid, p_shipping_minor bigint DEFAULT 0, p_customs_minor bigint DEFAULT 0, p_discount_minor bigint DEFAULT 0, p_fx_rate_to_nok numeric DEFAULT NULL::numeric, p_fx_rate_date date DEFAULT NULL::date, p_fx_source fx_source DEFAULT NULL::fx_source, p_notes text DEFAULT NULL::text, p_idempotency_key uuid DEFAULT NULL::uuid)
 RETURNS purchases
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
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
$function$;

-- ── reduce_holding_quantity ──
CREATE OR REPLACE FUNCTION public.reduce_holding_quantity(p_holding_id uuid, p_lot_reductions jsonb)
 RETURNS TABLE(owned_quantity integer)
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_user_id uuid := auth.uid();
  v_owned_total int;
  v_final_total int;
  v_remove_total int := 0;
  v_entry jsonb;
  v_idx int;
  v_lot_id uuid;
  v_sibling_id uuid;
  v_sibling_ids uuid[] := '{}';
  v_remove_text text;
  v_remove int;
  v_lot public.acquisition_lots;
  v_lot_ids uuid[] := '{}';
  v_removes int[] := '{}';
begin
  perform set_config('app.ledger_write', 'rpc', true);
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
  -- the requested subset), in ascending lot-id order — create_sale's established convention
  -- against concurrent multi-lot deadlocks: collect the ids sorted first, then take each row
  -- lock with its own SELECT ... FOR UPDATE in that order, the exact mechanism create_sale's
  -- pass 2 uses, so both operations acquire overlapping locks through identical code paths and
  -- cannot deadlock against each other. Two simultaneous adjustments of the same holding fully
  -- serialize no matter which lots each names: the second waits here until the first commits,
  -- then re-reads and validates against the UPDATED state. The user_id predicate guarantees a
  -- forged p_holding_id can never lock or even inspect another user's rows.
  select coalesce(array_agg(al.id order by al.id), '{}') into v_sibling_ids
    from public.acquisition_lots al
   where al.holding_id = p_holding_id
     and al.user_id = v_user_id
     and al.voided_at is null;

  foreach v_sibling_id in array v_sibling_ids loop
    select * into v_lot
      from public.acquisition_lots al
     where al.id = v_sibling_id
       and al.user_id = v_user_id
       for update;
  end loop;

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
    -- A live lot can never sit at zero copies — acquisition_lots_quantity_positive (quantity > 0)
    -- forbids it schema-wide, so taking a lot's last unit was never a legal quantity edit. It is
    -- the Void lot / Remove-from-Portfolio decision, which keeps history intact instead. Naming
    -- that here turns what would otherwise surface as a raw 23514 check violation into the same
    -- domain language every other refusal in this function uses. AdjustQuantitySheet's own
    -- confirm-guard only clamps the HOLDING total, not each lot, so this is reachable from the
    -- UI whenever one lot of a multi-lot holding is emptied while a sibling keeps units.
    if v_removes[v_idx] = v_lot.quantity_remaining then
      raise exception
        'reduction %: lot % would be left with zero copies - void the lot or use Remove from Portfolio for that',
        v_idx - 1, v_lot.id;
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

  -- Final guard — the invariant is enforced on the post-image itself: recompute the holding's
  -- owned total from the rows this transaction just wrote and refuse to return a zero. With the
  -- sibling locks held this can only ever agree with v_owned_total - v_remove_total; if locking
  -- were ever to regress silently, this converts the corruption back into a loud refusal (the
  -- whole call aborts with zero mutations). It also makes the RETURNED figure the real one.
  select coalesce(sum(al.quantity_remaining), 0)::int into v_final_total
    from public.acquisition_lots al
   where al.holding_id = p_holding_id
     and al.user_id = v_user_id
     and al.voided_at is null;
  if v_final_total < 1 then
    raise exception
      'this adjustment would remove every remaining copy - use Remove from Portfolio for that';
  end if;

  return query select v_final_total;
end;
$function$;

-- ── remove_holdings_from_portfolio ──
CREATE OR REPLACE FUNCTION public.remove_holdings_from_portfolio(p_holding_ids uuid[])
 RETURNS TABLE(holding_id uuid, blocked boolean, blocked_reason text, physical_count integer)
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_user_id uuid := auth.uid();
  v_has_blocked boolean := false;
  v_hid uuid;
  v_result_holding uuid[] := '{}';
  v_result_blocked boolean[] := '{}';
  v_result_reason text[] := '{}';
  v_result_count int[] := '{}';
  v_lot_ids uuid[];
  v_lot_id uuid;
begin
  perform set_config('app.ledger_write', 'rpc', true);
  if v_user_id is null then
    raise exception 'not authenticated';
  end if;
  if p_holding_ids is null or array_length(p_holding_ids, 1) is null then
    raise exception 'p_holding_ids must be a non-empty array';
  end if;

  if exists (
    select 1 from unnest(p_holding_ids) as x(hid)
    where not exists (
      select 1 from public.holdings h where h.id = x.hid and h.user_id = v_user_id
    )
  ) then
    raise exception 'one or more holdings were not found';
  end if;

  -- Lock every live lot of every selected holding, ascending id order, in ONE pass, BEFORE
  -- evaluating any disposal state (P130-03 / P132-B) -- the same discipline create_sale and the
  -- two functions above now share. A concurrent create_sale already holding one of these rows is
  -- waited on here, so the "blocked" pass below can never run against a lot whose disposal hasn't
  -- committed yet. Caller-supplied holding order is irrelevant: the lock order is the lot id, not
  -- the array position, so two overlapping calls (however the caller orders their holdings) can
  -- never deadlock against each other or against create_sale.
  select coalesce(array_agg(al.id order by al.id), '{}') into v_lot_ids
    from public.acquisition_lots al
    where al.holding_id = any(p_holding_ids) and al.user_id = v_user_id and al.voided_at is null;

  foreach v_lot_id in array v_lot_ids loop
    perform 1 from public.acquisition_lots where id = v_lot_id for update;
  end loop;

  -- Pass 1 (now race-safe): determine per-holding blocked status from the locked, live rows.
  -- Nothing else can make a removal unsafe: the parent-purchase correction is handled entirely
  -- inside void_acquisition_lot itself.
  for v_hid in select unnest(p_holding_ids) loop
    declare
      v_blocked boolean;
      v_qty bigint;
    begin
      select coalesce(bool_or(al.quantity_remaining <> al.quantity), false),
             coalesce(sum(al.quantity_remaining), 0)
        into v_blocked, v_qty
        from public.acquisition_lots al
        where al.holding_id = v_hid and al.user_id = v_user_id and al.voided_at is null;

      if v_blocked then
        v_has_blocked := true;
      end if;

      v_result_holding := v_result_holding || v_hid;
      v_result_blocked := v_result_blocked || v_blocked;
      v_result_reason := v_result_reason || (
        case when v_blocked
          then 'One or more copies have already been partially removed elsewhere and cannot be corrected this way yet.'
          else null
        end
      );
      v_result_count := v_result_count || v_qty::int;
    end;
  end loop;

  -- Pass 2: nothing blocked anywhere in the selection -- void every live lot of every selected
  -- holding via void_acquisition_lot itself. The locks taken above are already held by this same
  -- transaction, so each void_acquisition_lot call's own FOR UPDATE re-acquires (never re-waits
  -- on) the row it already holds -- no additional blocking, no new deadlock exposure.
  if not v_has_blocked then
    perform public.void_acquisition_lot(al.id)
      from public.acquisition_lots al
      where al.holding_id = any(p_holding_ids) and al.user_id = v_user_id and al.voided_at is null;
  end if;

  return query
    select v_result_holding[i], v_result_blocked[i], v_result_reason[i], v_result_count[i]
    from generate_subscripts(v_result_holding, 1) as i;
end;
$function$;

-- ── set_manual_valuation ──
CREATE OR REPLACE FUNCTION public.set_manual_valuation(p_holding_id uuid, p_value_minor bigint, p_note text DEFAULT NULL::text, p_effective_from date DEFAULT CURRENT_DATE)
 RETURNS manual_valuations
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_user_id uuid := auth.uid();
  v_row public.manual_valuations;
begin
  perform set_config('app.ledger_write', 'rpc', true);
  if v_user_id is null then
    raise exception 'not authenticated';
  end if;
  if p_value_minor is null or p_value_minor < 0 then
    raise exception 'p_value_minor must be a non-negative amount';
  end if;

  update public.manual_valuations
    set superseded_at = now()
    where holding_id = p_holding_id and user_id = v_user_id and superseded_at is null;

  insert into public.manual_valuations (
    user_id, holding_id, value_minor, currency, value_nok_minor, effective_from, note
  ) values (
    v_user_id, p_holding_id, p_value_minor, 'NOK', p_value_minor, p_effective_from, p_note
  )
  returning * into v_row;

  return v_row;
end;
$function$;

-- ── set_sealed_lot_intent ──
CREATE OR REPLACE FUNCTION public.set_sealed_lot_intent(p_lot_id uuid, p_intent sealed_intent, p_quantity integer DEFAULT NULL::integer)
 RETURNS acquisition_lots
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_user_id uuid := auth.uid();
  v_lot public.acquisition_lots;
  v_holding_kind public.holding_kind;
  v_split_qty int;
  v_new_lot public.acquisition_lots;
begin
  perform set_config('app.ledger_write', 'rpc', true);
  if v_user_id is null then
    raise exception 'not authenticated';
  end if;
  if p_intent is null then
    raise exception 'p_intent is required';
  end if;

  -- Lock first: every check below reads the locked row, and nothing is written before the lock.
  select * into v_lot from public.acquisition_lots
    where id = p_lot_id and user_id = v_user_id
    for update;
  if v_lot.id is null then
    raise exception 'acquisition lot % not found', p_lot_id;
  end if;
  if v_lot.voided_at is not null then
    raise exception 'acquisition lot % is voided', p_lot_id;
  end if;

  select holding_kind into v_holding_kind from public.holdings where id = v_lot.holding_id;
  if v_holding_kind <> 'sealed' then
    raise exception 'sealed_intent only applies to a sealed holding''s lot';
  end if;

  v_split_qty := coalesce(p_quantity, v_lot.quantity_remaining);
  if v_split_qty <= 0 or v_split_qty > v_lot.quantity_remaining then
    raise exception 'p_quantity must be between 1 and the lot''s quantity_remaining (%)', v_lot.quantity_remaining;
  end if;

  if v_split_qty = v_lot.quantity_remaining then
    -- Whole lot: every unit still in this lot moves to the new intent, no split needed.
    update public.acquisition_lots
      set sealed_intent = p_intent
      where id = p_lot_id
      returning * into v_lot;
    return v_lot;
  end if;

  -- Partial: carve v_split_qty units into a new, otherwise-identical lot at the new intent, and
  -- shrink the original by the same amount. Cost basis is conserved exactly (unchanged M11 rule).
  insert into public.acquisition_lots (
    holding_id, user_id, origin, cost_basis_state, purchase_line_id, acquired_on,
    quantity, quantity_remaining, unit_cost_basis_minor, cost_basis_currency,
    unit_cost_basis_nok_minor, residual_minor, residual_nok_minor, storage_location_id, notes,
    sealed_intent
  ) values (
    v_lot.holding_id, v_user_id, v_lot.origin, v_lot.cost_basis_state, v_lot.purchase_line_id,
    v_lot.acquired_on, v_split_qty, v_split_qty, v_lot.unit_cost_basis_minor, v_lot.cost_basis_currency,
    v_lot.unit_cost_basis_nok_minor, 0, 0, v_lot.storage_location_id, v_lot.notes,
    p_intent
  )
  returning * into v_new_lot;

  update public.acquisition_lots
    set quantity = quantity - v_split_qty,
        quantity_remaining = quantity_remaining - v_split_qty
    where id = p_lot_id;

  return v_new_lot;
end;
$function$;

-- ── update_purchase ──
CREATE OR REPLACE FUNCTION public.update_purchase(p_purchase_id uuid, p_purchased_on date, p_currency text, p_lines jsonb, p_retailer_id uuid DEFAULT NULL::uuid, p_shipping_minor bigint DEFAULT 0, p_customs_minor bigint DEFAULT 0, p_discount_minor bigint DEFAULT 0, p_fx_rate_to_nok numeric DEFAULT NULL::numeric, p_fx_rate_date date DEFAULT NULL::date, p_fx_source fx_source DEFAULT NULL::fx_source, p_notes text DEFAULT NULL::text)
 RETURNS purchases
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
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
  perform set_config('app.ledger_write', 'rpc', true);
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
$function$;

-- ── void_acquisition_lot ──
CREATE OR REPLACE FUNCTION public.void_acquisition_lot(p_lot_id uuid, p_reason text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_user_id uuid := auth.uid();
  v_lot public.acquisition_lots;
  v_purchase_id uuid;
  v_unaccounted_lines int;
begin
  perform set_config('app.ledger_write', 'rpc', true);
  if v_user_id is null then
    raise exception 'not authenticated';
  end if;

  -- Lock this lot FIRST (P130-03 / P132-B): the same row create_sale locks before disposing from
  -- it. Only after the lock is granted do we read quantity_remaining -- never before.
  select * into v_lot from public.acquisition_lots where id = p_lot_id and user_id = v_user_id for update;
  if v_lot.id is null then
    raise exception 'acquisition lot % not found', p_lot_id;
  end if;
  if v_lot.voided_at is not null then
    raise exception 'acquisition lot % is already voided', p_lot_id;
  end if;
  if v_lot.quantity_remaining <> v_lot.quantity then
    raise exception
      'acquisition lot % has already been partially disposed elsewhere (% of % remaining) and cannot be voided here',
      p_lot_id, v_lot.quantity_remaining, v_lot.quantity;
  end if;

  update public.acquisition_lots
    set voided_at = now(), notes = coalesce(p_reason, notes)
    where id = p_lot_id and user_id = v_user_id;

  if v_lot.purchase_line_id is not null then
    select purchase_id into v_purchase_id
      from public.purchase_lines where id = v_lot.purchase_line_id;

    -- D-051, made sibling-aware (D-131, P132 X-1): the purchase auto-voids only when EVERY line on
    -- it is accounted for -- a line is accounted for when it has at least one lot and all of its
    -- lots are voided. The M8.1 query skipped this lot's OWN line entirely, which was right only
    -- while a line could hold one lot: after a set_sealed_lot_intent split, voiding one sibling
    -- auto-voided the purchase while another sibling on the same line was still live inventory.
    -- This lot's own void above is already visible to this statement, so the own line counts as
    -- unaccounted exactly when another sibling of it is still live. A line that can never produce
    -- a lot (accessory, shipping, ...) still always counts as unaccounted, as in D-051.
    select count(*) into v_unaccounted_lines
      from public.purchase_lines pl
      where pl.purchase_id = v_purchase_id
        and (
          not exists (select 1 from public.acquisition_lots al where al.purchase_line_id = pl.id)
          or exists (
            select 1 from public.acquisition_lots al
            where al.purchase_line_id = pl.id and al.voided_at is null
          )
        );

    if v_unaccounted_lines = 0 then
      update public.purchases
        set voided_at = now()
        where id = v_purchase_id and voided_at is null;
    end if;
  end if;
end;
$function$;

-- ── void_purchase ──
CREATE OR REPLACE FUNCTION public.void_purchase(p_purchase_id uuid, p_reason text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_user_id uuid := auth.uid();
  v_existing public.purchases;
  v_blocker record;
  v_lot_ids uuid[];
  v_lot_id uuid;
begin
  perform set_config('app.ledger_write', 'rpc', true);
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

  -- Lock every live lot this purchase produced, ascending id order, BEFORE looking at disposal
  -- state (P130-03 / P132-B). A concurrent create_sale already holding one of these rows is
  -- waited on here; whichever transaction is granted the lock first serializes the other.
  select coalesce(array_agg(al.id order by al.id), '{}') into v_lot_ids
    from public.acquisition_lots al
    join public.purchase_lines pl on pl.id = al.purchase_line_id
    where pl.purchase_id = p_purchase_id and al.voided_at is null;

  foreach v_lot_id in array v_lot_ids loop
    perform 1 from public.acquisition_lots where id = v_lot_id for update;
  end loop;

  -- Membership re-check (P132 integration): the purchase row and the lot set above were read
  -- before any lock was held. A concurrent void (this function, or void_acquisition_lot's parent
  -- auto-void) that committed while this call waited is a named refusal. A live lot created by a
  -- concurrent set_sealed_lot_intent split while this call waited is not locked and would survive
  -- the void below as live inventory under a voided purchase, so the call refuses with a retryable
  -- serialization failure instead.
  if exists (select 1 from public.purchases where id = p_purchase_id and voided_at is not null) then
    raise exception 'purchase % is already voided', p_purchase_id;
  end if;
  if exists (
    select 1
      from public.acquisition_lots al
      join public.purchase_lines pl on pl.id = al.purchase_line_id
     where pl.purchase_id = p_purchase_id and al.voided_at is null
       and al.id <> all(v_lot_ids)
  ) then
    raise exception using
      errcode = '40001',
      message = format('concurrent-inventory-change: purchase %s gained a lot while this void was waiting; retry the void', p_purchase_id);
  end if;

  -- Re-validate against the now-locked, live rows -- never a value read before the lock above.
  select pl.description, pl.line_type, al.quantity, al.quantity_remaining
    into v_blocker
    from public.purchase_lines pl
    join public.acquisition_lots al on al.purchase_line_id = pl.id
    where pl.purchase_id = p_purchase_id
      and al.id = any(v_lot_ids)
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

  update public.acquisition_lots
    set voided_at = now()
    where id = any(v_lot_ids) and voided_at is null;
end;
$function$;

-- The gate function is a trigger function: no role calls it, so it holds no EXECUTE grant.
revoke execute on function public.enforce_ledger_write_gate() from public;
