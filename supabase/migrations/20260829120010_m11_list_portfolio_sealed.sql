-- M11: sealed identity and intent breakdown in list_portfolio/portfolio_counts, plus a distinct
-- sealed value segment (prompt §37-44/§109).
--
-- D-054/D-059 DISCIPLINE (TESTING.md §6a) — read before touching this file again. This DROPs and
-- CREATEs list_portfolio because the return column set changes (Postgres cannot ALTER a function's
-- RETURNS TABLE shape in place). Every clause below is the M9 body
-- (20260826120030_m9_list_portfolio_resolver.sql) unchanged except where a comment marks an M11
-- addition — the `with lot_agg as materialized (...)` / `resolved as materialized (...)` CTE
-- architecture that fixed the real 10,000-lot regression (D-054) is preserved exactly, not
-- reintroduced as a per-holding LATERAL. The permanent benchmark
-- (scripts/portfolio-perf-benchmark.mjs) must be re-run against this change before it is considered
-- safe — see HANDOVER.md for this session's actual run.
--
-- WHAT'S NEW, and why each piece is safe:
--   - sealed_products / its linked card_sets are LEFT JOINed the same way card_variants/cards/
--     card_sets and manual_card_definitions already are — an indexed LEFT JOIN keyed on a holding's
--     own nullable FK, not a per-row correlated subquery (prompt §75).
--   - lot_agg gains three more FILTERed SUMs (qty_keep_sealed/qty_planned_to_open/qty_undecided),
--     computed in the same single GROUP BY pass over acquisition_lots the CTE already does — no
--     second scan.
--   - name/set/language matching (search, sort, cursor, filters) now coalesces in sp.name/sp_set.*/
--     sp.language alongside the existing card/manual-card coalesce chains, so a sealed holding
--     participates in every existing sort mode instead of silently sorting as an empty string.
--     number_asc/number_desc is the one deliberate exception (prompt §47): sealed has no collector
--     number, so it coalesces to '' like a card with no local_id would, sorting first in *_asc and
--     last in *_desc — deterministic, not a fabricated number.
--   - value/price-state resolution is UNCHANGED: the existing `resolved_case`/`val` LATERAL already
--     falls straight to "manual valuation or missing" for any holding_kind other than 'raw_card'
--     (the F10 graded-card rule, which sealed already rode for free since M9) — sealed needed no new
--     branch there at all.
--   - three new optional filters: p_holding_kind (Portfolio's All/Raw/Graded/Sealed type filter),
--     p_sealed_product_type, p_sealed_intent (matches a holding with at least one non-voided lot
--     carrying that intent among its remaining quantity).

drop function if exists public.list_portfolio(
  public.portfolio_sort_order, int, text, uuid, public.card_condition, boolean, public.grader,
  boolean, text, boolean, uuid, uuid, uuid, boolean, boolean, uuid, text, text, bigint, date,
  timestamptz, bigint, boolean, text
);

create function public.list_portfolio(
  p_sort public.portfolio_sort_order default 'value_desc',
  p_limit int default 30,
  p_query text default null,
  p_set_id uuid default null,
  p_condition public.card_condition default null,
  p_graded boolean default null,
  p_grader public.grader default null,
  p_favorite boolean default null,
  p_language text default null,
  p_manual_only boolean default null,
  p_custom_collection_id uuid default null,
  p_storage_location_id uuid default null,
  p_tag_id uuid default null,
  p_low_value boolean default null,
  p_missing_value boolean default null,
  p_cursor_holding_id uuid default null,
  p_cursor_name text default null,
  p_cursor_set_name text default null,
  p_cursor_quantity bigint default null,
  p_cursor_acquired_on date default null,
  p_cursor_added_at timestamptz default null,
  p_cursor_value_minor bigint default null,
  p_cursor_has_value boolean default null,
  p_cursor_number_key text default null,
  p_holding_kind public.holding_kind default null,
  p_sealed_product_type public.sealed_product_type default null,
  p_sealed_intent public.sealed_intent default null
)
returns table (
  holding_id uuid,
  holding_kind public.holding_kind,
  card_variant_id uuid,
  manual_card_id uuid,
  condition public.card_condition,
  grading_state public.grading_state,
  grader public.grader,
  grade numeric(3, 1),
  cert_number text,
  is_favorite boolean,
  notes text,
  created_at timestamptz,
  quantity bigint,
  lot_count bigint,
  variant_finish public.card_finish,
  variant_stamp text,
  variant_subtype text,
  card_name text,
  card_local_id text,
  card_image_base_url text,
  card_language text,
  card_set_id uuid,
  card_set_name text,
  manual_name text,
  manual_set_name text,
  manual_collector_number text,
  manual_language text,
  sealed_product_id uuid,
  sealed_product_type public.sealed_product_type,
  sealed_product_name text,
  sealed_product_language text,
  sealed_pack_count int,
  sealed_image_url text,
  sealed_set_id uuid,
  sealed_set_name text,
  sealed_is_custom boolean,
  qty_keep_sealed bigint,
  qty_planned_to_open bigint,
  qty_undecided bigint,
  unit_value_nok_minor text,
  holding_value_nok_minor text,
  price_state text,
  acquired_on_min date,
  acquired_on_max date,
  has_multiple_storage_locations boolean,
  number_sort_key text
)
language plpgsql
stable
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_limit int := least(greatest(coalesce(p_limit, 30), 1), 100);
  v_threshold bigint;
  v_variant_ids uuid[];
begin
  if v_user_id is null then
    raise exception 'not authenticated';
  end if;

  select p.low_value_threshold_minor into v_threshold
    from public.profiles p where p.id = v_user_id;

  select array_agg(distinct h.card_variant_id) into v_variant_ids
    from public.holdings h
    where h.user_id = v_user_id and h.card_variant_id is not null and h.deleted_at is null;

  return query
  with lot_agg as materialized (
    select
      h.id as holding_id,
      coalesce(sum(l.quantity_remaining) filter (where l.voided_at is null), 0)::bigint as quantity,
      count(l.id) filter (where l.voided_at is null and l.quantity_remaining > 0) as lot_count,
      min(l.acquired_on) filter (where l.voided_at is null) as acquired_min,
      max(l.acquired_on) filter (where l.voided_at is null) as acquired_max,
      count(distinct l.storage_location_id) filter (
        where l.voided_at is null and l.storage_location_id is not null
      ) as storage_location_count,
      -- M11: per-intent remaining-quantity breakdown, one pass, no second scan of acquisition_lots.
      coalesce(sum(l.quantity_remaining) filter (
        where l.voided_at is null and l.sealed_intent = 'keep_sealed'
      ), 0)::bigint as qty_keep_sealed,
      coalesce(sum(l.quantity_remaining) filter (
        where l.voided_at is null and l.sealed_intent = 'planned_to_open'
      ), 0)::bigint as qty_planned_to_open,
      coalesce(sum(l.quantity_remaining) filter (
        where l.voided_at is null and l.sealed_intent = 'undecided'
      ), 0)::bigint as qty_undecided
    from public.holdings h
    left join public.acquisition_lots l on l.holding_id = h.id
    where h.deleted_at is null and h.user_id = v_user_id
    group by h.id
  ),
  resolved as materialized (
    select r.card_variant_id, r.price_state, r.value_nok_minor::bigint as value_nok_minor
    from public.resolve_variant_market_values(coalesce(v_variant_ids, array[]::uuid[])) r
  )
  select
    h.id,
    h.holding_kind,
    h.card_variant_id,
    h.manual_card_id,
    h.condition,
    h.grading_state,
    h.grader,
    h.grade,
    h.cert_number,
    h.is_favorite,
    h.notes,
    h.created_at,
    q.quantity,
    q.lot_count,
    cv.finish,
    cv.stamp,
    cv.subtype,
    c.name,
    c.local_id,
    c.image_base_url,
    c.language,
    cs.id,
    cs.name,
    mc.name,
    mc.set_name,
    mc.collector_number,
    mc.language,
    h.sealed_product_id,
    sp.product_type,
    sp.name,
    sp.language,
    sp.pack_count,
    sp.image_url,
    sp_set.id,
    sp_set.name,
    (sp.created_by_user_id is not null),
    q.qty_keep_sealed,
    q.qty_planned_to_open,
    q.qty_undecided,
    val.unit_value_nok_minor::text,
    val.holding_value_nok_minor::text,
    val.price_state,
    q.acquired_min,
    q.acquired_max,
    q.storage_location_count > 1,
    public.natural_sort_key(coalesce(c.local_id, mc.collector_number, ''))
  from lot_agg q
  join public.holdings h on h.id = q.holding_id
  left join public.card_variants cv on cv.id = h.card_variant_id
  left join public.cards c on c.id = cv.card_id
  left join public.card_sets cs on cs.id = c.set_id
  left join public.manual_card_definitions mc on mc.id = h.manual_card_id
  left join public.sealed_products sp on sp.id = h.sealed_product_id
  left join public.card_sets sp_set on sp_set.id = sp.set_id
  left join public.manual_valuations mv on mv.holding_id = h.id and mv.superseded_at is null
  left join resolved r on r.card_variant_id = h.card_variant_id
  -- F10: a raw provider price never values a graded or sealed holding, regardless of what the
  -- resolver returned for the underlying printing's card_variant_id (sealed holdings never have a
  -- card_variant_id in the first place, so r is already null for them via the join above — this
  -- branch is unchanged from M9). This LATERAL is pure computation over already-joined row-local
  -- values (no table scan inside it) — purely so the CASE expressions below can be written once and
  -- reused in SELECT/WHERE/ORDER BY; it is not the per-holding correlated-subquery-against-a-table
  -- pattern the migration header's perf note is about.
  cross join lateral (
    select
      case
        when mv.value_nok_minor is not null then mv.value_nok_minor
        when h.holding_kind = 'raw_card' and r.price_state in ('fresh', 'stale') then r.value_nok_minor
        else null
      end as unit_value_nok_minor,
      case
        when mv.value_nok_minor is not null then 'manual'
        when h.holding_kind = 'raw_card' then coalesce(r.price_state, 'missing')
        else 'missing'
      end as price_state
  ) resolved_case
  cross join lateral (
    select
      resolved_case.unit_value_nok_minor,
      resolved_case.price_state,
      case
        when resolved_case.unit_value_nok_minor is not null then resolved_case.unit_value_nok_minor * q.quantity
        else null
      end as holding_value_nok_minor
  ) val
  where q.quantity > 0
    and (p_query is null or btrim(p_query) = ''
         or c.name ilike '%' || p_query || '%'
         or mc.name ilike '%' || p_query || '%'
         or sp.name ilike '%' || p_query || '%')
    and (p_set_id is null or coalesce(cs.id, sp_set.id) = p_set_id)
    and (p_condition is null or h.condition = p_condition)
    and (p_graded is null
         or (p_graded and h.grading_state = 'graded')
         or (not p_graded and h.grading_state <> 'graded'))
    and (p_grader is null or h.grader = p_grader)
    and (p_favorite is null or h.is_favorite = p_favorite)
    and (p_language is null or coalesce(c.language, mc.language, sp.language) = p_language)
    and (p_manual_only is null
         or (p_manual_only and h.manual_card_id is not null)
         or (not p_manual_only and h.manual_card_id is null))
    and (p_custom_collection_id is null or exists (
      select 1 from public.custom_collection_members m
      where m.holding_id = h.id and m.collection_id = p_custom_collection_id
        and m.user_id = v_user_id
    ))
    and (p_storage_location_id is null or exists (
      select 1 from public.acquisition_lots l2
      where l2.holding_id = h.id and l2.voided_at is null
        and l2.storage_location_id = p_storage_location_id
    ))
    and (p_tag_id is null or exists (
      select 1 from public.holding_tags t where t.holding_id = h.id and t.tag_id = p_tag_id
    ))
    -- M11: Portfolio's type filter (All/Raw/Graded/Sealed) and sealed-only refinements.
    and (p_holding_kind is null or h.holding_kind = p_holding_kind)
    and (p_sealed_product_type is null or sp.product_type = p_sealed_product_type)
    and (p_sealed_intent is null or exists (
      select 1 from public.acquisition_lots l3
      where l3.holding_id = h.id and l3.voided_at is null and l3.quantity_remaining > 0
        and l3.sealed_intent = p_sealed_intent
    ))
    -- Low value / missing value: the per-item UNIT value (DATA_MODEL.md §5.2.2 — "is this specific
    -- card cheap" is per-printing, not "is my whole stack of it cheap"). Already correct for sealed:
    -- val.unit_value_nok_minor resolves to manual-or-null for any non-raw-card holding.
    and (p_low_value is not true or (val.unit_value_nok_minor is not null and val.unit_value_nok_minor <= v_threshold))
    and (p_missing_value is not true or val.unit_value_nok_minor is null)
    and (
      p_cursor_holding_id is null
      or (
        (p_sort = 'name_asc' and (lower(coalesce(c.name, mc.name, sp.name, '')), h.id)
           > (lower(coalesce(p_cursor_name, '')), p_cursor_holding_id))
        or (p_sort = 'name_desc' and (lower(coalesce(c.name, mc.name, sp.name, '')), h.id)
           < (lower(coalesce(p_cursor_name, '')), p_cursor_holding_id))
        or (p_sort = 'set_asc' and (lower(coalesce(cs.name, mc.set_name, sp_set.name, '')), h.id)
           > (lower(coalesce(p_cursor_set_name, '')), p_cursor_holding_id))
        or (p_sort = 'quantity_desc' and (q.quantity, h.id)
           < (coalesce(p_cursor_quantity, 0), p_cursor_holding_id))
        or (p_sort = 'added_newest' and (h.created_at, h.id)
           < (coalesce(p_cursor_added_at, now()), p_cursor_holding_id))
        or (p_sort = 'added_oldest' and (h.created_at, h.id)
           > (coalesce(p_cursor_added_at, now()), p_cursor_holding_id))
        or (p_sort = 'acquired_newest' and (coalesce(q.acquired_max, h.created_at::date), h.id)
           < (coalesce(p_cursor_acquired_on, current_date), p_cursor_holding_id))
        or (p_sort = 'acquired_oldest' and (coalesce(q.acquired_min, h.created_at::date), h.id)
           > (coalesce(p_cursor_acquired_on, current_date), p_cursor_holding_id))
        or (p_sort = 'number_asc' and (
          public.natural_sort_key(coalesce(c.local_id, mc.collector_number, '')), h.id
        ) > (coalesce(p_cursor_number_key, ''), p_cursor_holding_id))
        or (p_sort = 'number_desc' and (
          public.natural_sort_key(coalesce(c.local_id, mc.collector_number, '')), h.id
        ) < (coalesce(p_cursor_number_key, ''), p_cursor_holding_id))
        or (p_sort = 'value_desc' and (
          (val.holding_value_nok_minor is not null and coalesce(p_cursor_has_value, false) and (
            val.holding_value_nok_minor < coalesce(p_cursor_value_minor, 0)
            or (val.holding_value_nok_minor = coalesce(p_cursor_value_minor, 0)
                and (lower(coalesce(c.name, mc.name, sp.name, '')), h.id)
                    > (lower(coalesce(p_cursor_name, '')), p_cursor_holding_id))
          ))
          or (val.holding_value_nok_minor is null and coalesce(p_cursor_has_value, false))
          or (val.holding_value_nok_minor is null and not coalesce(p_cursor_has_value, false)
              and (lower(coalesce(c.name, mc.name, sp.name, '')), h.id)
                  > (lower(coalesce(p_cursor_name, '')), p_cursor_holding_id))
        ))
        or (p_sort = 'value_asc' and (
          (val.holding_value_nok_minor is not null and coalesce(p_cursor_has_value, false) and (
            val.holding_value_nok_minor > coalesce(p_cursor_value_minor, 0)
            or (val.holding_value_nok_minor = coalesce(p_cursor_value_minor, 0)
                and (lower(coalesce(c.name, mc.name, sp.name, '')), h.id)
                    > (lower(coalesce(p_cursor_name, '')), p_cursor_holding_id))
          ))
          or (val.holding_value_nok_minor is null and coalesce(p_cursor_has_value, false))
          or (val.holding_value_nok_minor is null and not coalesce(p_cursor_has_value, false)
              and (lower(coalesce(c.name, mc.name, sp.name, '')), h.id)
                  > (lower(coalesce(p_cursor_name, '')), p_cursor_holding_id))
        ))
      )
    )
  order by
    case when p_sort in ('value_desc', 'value_asc') and val.holding_value_nok_minor is not null then 0
         when p_sort in ('value_desc', 'value_asc') then 1
         else 0 end,
    case when p_sort = 'value_desc' then val.holding_value_nok_minor end desc,
    case when p_sort = 'value_asc' then val.holding_value_nok_minor end asc,
    case when p_sort = 'quantity_desc' then q.quantity end desc,
    case when p_sort = 'added_newest' then h.created_at end desc,
    case when p_sort = 'added_oldest' then h.created_at end asc,
    case when p_sort = 'acquired_newest' then coalesce(q.acquired_max, h.created_at::date) end desc,
    case when p_sort = 'acquired_oldest' then coalesce(q.acquired_min, h.created_at::date) end asc,
    case when p_sort = 'number_asc'
      then public.natural_sort_key(coalesce(c.local_id, mc.collector_number, '')) end asc,
    case when p_sort = 'number_desc'
      then public.natural_sort_key(coalesce(c.local_id, mc.collector_number, '')) end desc,
    case when p_sort = 'set_asc' then lower(coalesce(cs.name, mc.set_name, sp_set.name, '')) end asc,
    case when p_sort = 'name_desc' then lower(coalesce(c.name, mc.name, sp.name, '')) end desc,
    lower(coalesce(c.name, mc.name, sp.name, '')) asc,
    h.id asc
  limit v_limit;
end;
$$;

grant execute on function public.list_portfolio(
  public.portfolio_sort_order, int, text, uuid, public.card_condition, boolean, public.grader,
  boolean, text, boolean, uuid, uuid, uuid, boolean, boolean, uuid, text, text, bigint, date,
  timestamptz, bigint, boolean, text, public.holding_kind, public.sealed_product_type, public.sealed_intent
) to authenticated;
revoke execute on function public.list_portfolio(
  public.portfolio_sort_order, int, text, uuid, public.card_condition, boolean, public.grader,
  boolean, text, boolean, uuid, uuid, uuid, boolean, boolean, uuid, text, text, bigint, date,
  timestamptz, bigint, boolean, text, public.holding_kind, public.sealed_product_type, public.sealed_intent
) from public;

-- ── portfolio_counts: a distinct sealed value segment (prompt §37-40/§66) ──────────────────────
-- Same DROP+CREATE reasoning as above (new return columns). lot_agg/resolved/owned keep the exact
-- M9 shape; only the final SELECT gains cards-vs-sealed split totals and sealed-scoped priced/
-- unpriced/unit counts, computed from the same `owned` CTE with a `holding_kind` filter — no new
-- scan, no new join.

drop function if exists public.portfolio_counts(uuid);

create function public.portfolio_counts(p_custom_collection_id uuid default null)
returns table (
  physical_card_count text,
  unique_holding_count text,
  graded_count text,
  manual_count text,
  priced_holding_count text,
  unpriced_holding_count text,
  portfolio_value_nok_minor text,
  cards_value_nok_minor text,
  sealed_value_nok_minor text,
  sealed_holding_count text,
  sealed_priced_holding_count text,
  sealed_unpriced_holding_count text,
  sealed_unit_count text
)
language plpgsql
stable
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_variant_ids uuid[];
begin
  if v_user_id is null then
    raise exception 'not authenticated';
  end if;

  select array_agg(distinct h.card_variant_id) into v_variant_ids
    from public.holdings h
    where h.user_id = v_user_id and h.card_variant_id is not null and h.deleted_at is null;

  return query
  with lot_agg as materialized (
    select
      h.id as holding_id,
      h.holding_kind,
      h.card_variant_id,
      h.manual_card_id,
      coalesce(sum(l.quantity_remaining) filter (where l.voided_at is null), 0)::bigint as quantity
    from public.holdings h
    left join public.acquisition_lots l on l.holding_id = h.id
    where h.deleted_at is null and h.user_id = v_user_id
      and (p_custom_collection_id is null or exists (
        select 1 from public.custom_collection_members m
        where m.holding_id = h.id and m.collection_id = p_custom_collection_id
          and m.user_id = v_user_id
      ))
    group by h.id, h.holding_kind, h.card_variant_id, h.manual_card_id
  ),
  resolved as materialized (
    select r.card_variant_id, r.price_state, r.value_nok_minor::bigint as value_nok_minor
    from public.resolve_variant_market_values(coalesce(v_variant_ids, array[]::uuid[])) r
  ),
  owned as materialized (
    select
      la.*,
      mv.value_nok_minor as manual_value_nok_minor,
      case
        when mv.value_nok_minor is not null then mv.value_nok_minor
        when la.holding_kind = 'raw_card' and r.price_state in ('fresh', 'stale') then r.value_nok_minor
        else null
      end as unit_value_nok_minor
    from lot_agg la
    left join public.manual_valuations mv on mv.holding_id = la.holding_id and mv.superseded_at is null
    left join resolved r on r.card_variant_id = la.card_variant_id
    where la.quantity > 0
  )
  select
    coalesce(sum(quantity), 0)::text,
    count(*)::text,
    count(*) filter (where holding_kind = 'graded_card')::text,
    count(*) filter (where manual_card_id is not null)::text,
    count(*) filter (where unit_value_nok_minor is not null)::text,
    count(*) filter (where unit_value_nok_minor is null)::text,
    coalesce(sum(unit_value_nok_minor * quantity) filter (where unit_value_nok_minor is not null), 0)::text,
    coalesce(sum(unit_value_nok_minor * quantity)
      filter (where unit_value_nok_minor is not null and holding_kind <> 'sealed'), 0)::text,
    coalesce(sum(unit_value_nok_minor * quantity)
      filter (where unit_value_nok_minor is not null and holding_kind = 'sealed'), 0)::text,
    count(*) filter (where holding_kind = 'sealed')::text,
    count(*) filter (where holding_kind = 'sealed' and unit_value_nok_minor is not null)::text,
    count(*) filter (where holding_kind = 'sealed' and unit_value_nok_minor is null)::text,
    coalesce(sum(quantity) filter (where holding_kind = 'sealed'), 0)::text
  from owned;
end;
$$;

grant execute on function public.portfolio_counts(uuid) to authenticated;
revoke execute on function public.portfolio_counts(uuid) from public;

comment on function public.list_portfolio(
  public.portfolio_sort_order, int, text, uuid, public.card_condition, boolean, public.grader,
  boolean, text, boolean, uuid, uuid, uuid, boolean, boolean, uuid, text, text, bigint, date,
  timestamptz, bigint, boolean, text, public.holding_kind, public.sealed_product_type, public.sealed_intent
) is
  'Portfolio browsing: sorted/filtered/keyset-paginated holdings, cards and sealed alike. M11 (20260829120010) added sealed product identity, per-lot intent aggregates, and the type/product-type/intent filters. See DATA_MODEL.md §5.4-5.5/§3.3, FINANCIAL_MODEL.md §6.3.';

comment on function public.portfolio_counts(uuid) is
  'Portfolio header counts and value. M11 (20260829120010) added the cards/sealed value segment and sealed-scoped priced/unpriced/unit counts (FINANCIAL_MODEL.md §2.4/§6.3 — sealed value is never merged silently into an unexplained combined total).';
