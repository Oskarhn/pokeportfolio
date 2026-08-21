-- M7 performance fix, found by the actual 10,000-lot benchmark against pokeportfolio-dev, not by
-- CI (docs/TESTING.md §7's own distinction: CI proves correctness on ephemeral data, not
-- performance at scale). `list_portfolio`'s original body joined a `LATERAL` aggregate subquery
-- per holding row — `join lateral (select sum(...) ... where l.holding_id = h.id) q on true` —
-- which structurally forces PostgreSQL into a nested-loop plan: one correlated subquery execution
-- per holding, 7 500 of them for the seeded benchmark account. At that scale two of six tested
-- sort modes (`value_desc`, `added_newest`) actually timed out (`57014 canceling statement due to
-- statement timeout`) and the rest took 5.5-8 seconds for a single first page — completely
-- unacceptable for a mobile app and a direct failure of the "stays interactive on a phone" gate
-- (M7 prompt §53/§57).
--
-- THE FIX. The exact same aggregation, computed once via a plain `LEFT JOIN ... GROUP BY` inside
-- a materialized CTE, restricted to this user's holdings *before* the join to
-- `acquisition_lots` — the same general shape `holding_summaries` (M6) already uses, and the
-- reason a correlated LATERAL and an ordinary GROUP BY are not interchangeable even though they
-- can express the same result: a GROUP BY lets the planner pick a hash join and a single hash
-- aggregate pass over both tables, where a LATERAL forces re-evaluation per outer row. Every
-- filter, cursor comparison and ORDER BY expression is unchanged — this migration touches only
-- how the aggregate columns (`quantity`, `lot_count`, `acquired_min`, `acquired_max`,
-- `storage_location_count`) are computed, never what the function accepts, returns or means.
--
-- `create or replace function` keeps the exact same signature (parameter and return types), so no
-- grant needs restating — PostgreSQL identifies a function's privileges by its argument types,
-- which have not changed.

create or replace function public.list_portfolio(
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
  p_cursor_has_value boolean default null
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
  resolved_value_nok_minor text,
  acquired_on_min date,
  acquired_on_max date,
  has_multiple_storage_locations boolean
)
language plpgsql
stable
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_limit int := least(greatest(coalesce(p_limit, 30), 1), 100);
  v_threshold bigint;
begin
  if v_user_id is null then
    raise exception 'not authenticated';
  end if;

  select p.low_value_threshold_minor into v_threshold
    from public.profiles p where p.id = v_user_id;

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
    mv.value_nok_minor::text,
    q.acquired_min,
    q.acquired_max,
    q.storage_location_count > 1
  from lot_agg q
  join public.holdings h on h.id = q.holding_id
  left join public.card_variants cv on cv.id = h.card_variant_id
  left join public.cards c on c.id = cv.card_id
  left join public.card_sets cs on cs.id = c.set_id
  left join public.manual_card_definitions mc on mc.id = h.manual_card_id
  left join public.manual_valuations mv on mv.holding_id = h.id and mv.superseded_at is null
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
    -- Low value: a *known* value at or under the threshold. A missing value is never "low" —
    -- DATA_MODEL.md §5.2.2's low-value/no-price distinction, restated here for the manual-value
    -- case that exists before M9 (F8.3/§37).
    and (p_low_value is not true or (mv.value_nok_minor is not null and mv.value_nok_minor <= v_threshold))
    and (p_missing_value is not true or mv.value_nok_minor is null)
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
        or (p_sort = 'value_desc' and (
          (mv.value_nok_minor is not null and coalesce(p_cursor_has_value, false) and (
            mv.value_nok_minor < coalesce(p_cursor_value_minor, 0)
            or (mv.value_nok_minor = coalesce(p_cursor_value_minor, 0)
                and (lower(coalesce(c.name, mc.name, '')), h.id)
                    > (lower(coalesce(p_cursor_name, '')), p_cursor_holding_id))
          ))
          or (mv.value_nok_minor is null and coalesce(p_cursor_has_value, false))
          or (mv.value_nok_minor is null and not coalesce(p_cursor_has_value, false)
              and (lower(coalesce(c.name, mc.name, '')), h.id)
                  > (lower(coalesce(p_cursor_name, '')), p_cursor_holding_id))
        ))
        or (p_sort = 'value_asc' and (
          (mv.value_nok_minor is not null and coalesce(p_cursor_has_value, false) and (
            mv.value_nok_minor > coalesce(p_cursor_value_minor, 0)
            or (mv.value_nok_minor = coalesce(p_cursor_value_minor, 0)
                and (lower(coalesce(c.name, mc.name, '')), h.id)
                    > (lower(coalesce(p_cursor_name, '')), p_cursor_holding_id))
          ))
          or (mv.value_nok_minor is null and coalesce(p_cursor_has_value, false))
          or (mv.value_nok_minor is null and not coalesce(p_cursor_has_value, false)
              and (lower(coalesce(c.name, mc.name, '')), h.id)
                  > (lower(coalesce(p_cursor_name, '')), p_cursor_holding_id))
        ))
      )
    )
  order by
    case when p_sort in ('value_desc', 'value_asc') and mv.value_nok_minor is not null then 0
         when p_sort in ('value_desc', 'value_asc') then 1
         else 0 end,
    case when p_sort = 'value_desc' then mv.value_nok_minor end desc,
    case when p_sort = 'value_asc' then mv.value_nok_minor end asc,
    case when p_sort = 'quantity_desc' then q.quantity end desc,
    case when p_sort = 'added_newest' then h.created_at end desc,
    case when p_sort = 'added_oldest' then h.created_at end asc,
    case when p_sort = 'acquired_newest' then coalesce(q.acquired_max, h.created_at::date) end desc,
    case when p_sort = 'acquired_oldest' then coalesce(q.acquired_min, h.created_at::date) end asc,
    case when p_sort = 'set_asc' then lower(coalesce(cs.name, mc.set_name, '')) end asc,
    case when p_sort = 'name_desc' then lower(coalesce(c.name, mc.name, '')) end desc,
    lower(coalesce(c.name, mc.name, '')) asc,
    h.id asc
  limit v_limit;
end;
$$;
