-- M9: wires the real valuation resolver into list_portfolio/portfolio_counts, replacing D-041's
-- manual-only transitional value with manual → fresh → stale → missing (FINANCIAL_MODEL.md §6).
--
-- Two things change together here, not just the value source:
--
-- 1. VALUE SEMANTICS (D-052). `resolved_value_nok_minor` is replaced by two figures:
--    `unit_value_nok_minor` (per printing, used for the low-value/missing-value filters — "is this
--    specific card cheap" is a per-item question) and `holding_value_nok_minor` (unit × open
--    quantity, used for the value_desc/value_asc SORT — a portfolio view answering "what's my
--    biggest position" should not rank ×20 Basic Energy below a single low-value rare just because
--    their unit prices are compared instead of what the user actually holds, prompt §42).
--    `price_state` ('manual'/'fresh'/'stale'/'missing') rides along for the stale-indicator UI.
--
-- 2. PERFORMANCE REGRESSION FIX. The M7.1 migration that added number-sort
--    (20260823120010_m71_number_sort.sql) had to DROP and CREATE list_portfolio because adding a
--    parameter changes a function's identity — and in doing so it silently reverted the lot
--    aggregation back to the `join lateral (...) q on true` per-holding shape the real 10,000-lot
--    benchmark had already found forces a nested-loop plan (20260822120030_m7_portfolio_query_perf_fix.sql).
--    Never caught since, because CI's ephemeral data is too small to expose it. Restored to the
--    `with lot_agg as materialized (...)` GROUP BY shape here, in the same rewrite this milestone
--    already needs for the resolver — see PROJECT_JOURNAL.md for the full account. The resolver
--    itself follows the identical rule (prompt §74/§77): `resolve_variant_market_values` is called
--    exactly ONCE per list_portfolio call with the full array of this page's distinct
--    card_variant_ids, never once per holding.

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
  p_cursor_number_key text default null
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
      ) as storage_location_count
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
  left join public.manual_valuations mv on mv.holding_id = h.id and mv.superseded_at is null
  left join resolved r on r.card_variant_id = h.card_variant_id
  -- F10: a raw provider price never values a graded holding, regardless of what the resolver
  -- returned for the underlying printing's card_variant_id. This LATERAL is pure computation over
  -- already-joined row-local values (no table scan inside it) — purely so the CASE expressions
  -- below can be written once and reused in SELECT/WHERE/ORDER BY; it is not the per-holding
  -- correlated-subquery-against-a-table pattern the migration header's perf note is about.
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
         or mc.name ilike '%' || p_query || '%')
    and (p_set_id is null or cs.id = p_set_id)
    and (p_condition is null or h.condition = p_condition)
    and (p_graded is null
         or (p_graded and h.grading_state = 'graded')
         or (not p_graded and h.grading_state <> 'graded'))
    and (p_grader is null or h.grader = p_grader)
    and (p_favorite is null or h.is_favorite = p_favorite)
    and (p_language is null or coalesce(c.language, mc.language) = p_language)
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
    -- Low value / missing value: the per-item UNIT value (DATA_MODEL.md §5.2.2 — "is this specific
    -- card cheap" is per-printing, not "is my whole stack of it cheap").
    and (p_low_value is not true or (val.unit_value_nok_minor is not null and val.unit_value_nok_minor <= v_threshold))
    and (p_missing_value is not true or val.unit_value_nok_minor is null)
    and (
      p_cursor_holding_id is null
      or (
        (p_sort = 'name_asc' and (lower(coalesce(c.name, mc.name, '')), h.id)
           > (lower(coalesce(p_cursor_name, '')), p_cursor_holding_id))
        or (p_sort = 'name_desc' and (lower(coalesce(c.name, mc.name, '')), h.id)
           < (lower(coalesce(p_cursor_name, '')), p_cursor_holding_id))
        or (p_sort = 'set_asc' and (lower(coalesce(cs.name, mc.set_name, '')), h.id)
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
                and (lower(coalesce(c.name, mc.name, '')), h.id)
                    > (lower(coalesce(p_cursor_name, '')), p_cursor_holding_id))
          ))
          or (val.holding_value_nok_minor is null and coalesce(p_cursor_has_value, false))
          or (val.holding_value_nok_minor is null and not coalesce(p_cursor_has_value, false)
              and (lower(coalesce(c.name, mc.name, '')), h.id)
                  > (lower(coalesce(p_cursor_name, '')), p_cursor_holding_id))
        ))
        or (p_sort = 'value_asc' and (
          (val.holding_value_nok_minor is not null and coalesce(p_cursor_has_value, false) and (
            val.holding_value_nok_minor > coalesce(p_cursor_value_minor, 0)
            or (val.holding_value_nok_minor = coalesce(p_cursor_value_minor, 0)
                and (lower(coalesce(c.name, mc.name, '')), h.id)
                    > (lower(coalesce(p_cursor_name, '')), p_cursor_holding_id))
          ))
          or (val.holding_value_nok_minor is null and coalesce(p_cursor_has_value, false))
          or (val.holding_value_nok_minor is null and not coalesce(p_cursor_has_value, false)
              and (lower(coalesce(c.name, mc.name, '')), h.id)
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
    case when p_sort = 'set_asc' then lower(coalesce(cs.name, mc.set_name, '')) end asc,
    case when p_sort = 'name_desc' then lower(coalesce(c.name, mc.name, '')) end desc,
    lower(coalesce(c.name, mc.name, '')) asc,
    h.id asc
  limit v_limit;
end;
$$;

grant execute on function public.list_portfolio(
  public.portfolio_sort_order, int, text, uuid, public.card_condition, boolean, public.grader,
  boolean, text, boolean, uuid, uuid, uuid, boolean, boolean, uuid, text, text, bigint, date,
  timestamptz, bigint, boolean, text
) to authenticated;
revoke execute on function public.list_portfolio(
  public.portfolio_sort_order, int, text, uuid, public.card_condition, boolean, public.grader,
  boolean, text, boolean, uuid, uuid, uuid, boolean, boolean, uuid, text, text, bigint, date,
  timestamptz, bigint, boolean, text
) from public;

-- ── portfolio_counts: add priced/unpriced counts (prompt §43/§69/§104) ─────────────────────────

drop function if exists public.portfolio_counts();

create function public.portfolio_counts(p_custom_collection_id uuid default null)
returns table (
  physical_card_count text,
  unique_holding_count text,
  graded_count text,
  manual_count text,
  priced_holding_count text,
  unpriced_holding_count text,
  portfolio_value_nok_minor text
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
    coalesce(sum(unit_value_nok_minor * quantity) filter (where unit_value_nok_minor is not null), 0)::text
  from owned;
end;
$$;

grant execute on function public.portfolio_counts(uuid) to authenticated;
revoke execute on function public.portfolio_counts(uuid) from public;
