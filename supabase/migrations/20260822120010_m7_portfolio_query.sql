-- M7: the Portfolio's server-side sort/filter/pagination surface, plus the cheap aggregate counts
-- Home and the Portfolio header need. Both read directly from holdings/acquisition_lots rather
-- than through holding_summaries (M6), because the filter joins and keyset cursor this milestone
-- needs do not fit a plain view cleanly, and a second query shape over the same base tables costs
-- nothing extra in RLS terms — both run SECURITY INVOKER (M7 prompt §74), so RLS on the underlying
-- tables applies exactly as if the caller queried them directly. No caller-supplied user id
-- anywhere: every predicate below is auth.uid() or a bound parameter (M7 prompt §75).

-- ── 1. The intended permanent default sort, and the profile preference for it (M7 prompt §29/§32) ─
--
-- Ten choices, matching the visible "Sort by" control. 'value_desc' is listed first and is the
-- permanent intended default (D-023-adjacent: value is the primary figure once one exists) — see
-- the function body below for why it does not fabricate a value pre-M9.

create type public.portfolio_sort_order as enum (
  'value_desc',
  'value_asc',
  'name_asc',
  'name_desc',
  'set_asc',
  'quantity_desc',
  'acquired_newest',
  'acquired_oldest',
  'added_newest',
  'added_oldest'
);

alter table public.profiles
  add column collection_default_sort public.portfolio_sort_order not null default 'value_desc';

-- ── 2. portfolio_counts — the cheap aggregate Home and the Portfolio header read ────────────────
--
-- Replaces the client-side full-column pull `getCollectionCounts` used through M6 (one row per
-- holding fetched just to sum `quantity` in JavaScript — flagged as a scale defect in
-- DATA_MODEL.md §10.1's own "counts are single aggregate queries" rule). One query, four numbers,
-- regardless of collection size.

create or replace function public.portfolio_counts()
returns table (
  physical_card_count text,
  unique_holding_count text,
  graded_count text,
  manual_count text
)
language sql
stable
set search_path = ''
as $$
  -- Cast to text: PostgREST serializes a bare `bigint` OUT column as a JSON number, which is
  -- inexact above 2^53 — the same boundary src/data/money.ts's parseMinorUnits guards against
  -- (tests/db/money-boundary.test.ts). Never realistically hit for a card count, but the
  -- convention this project follows for every bigint the client reads is to cast here rather than
  -- assume the value will always stay small.
  select
    coalesce(sum(q.quantity), 0)::text,
    count(*) filter (where q.quantity > 0)::text,
    count(*) filter (where q.quantity > 0 and h.grading_state = 'graded')::text,
    count(*) filter (where q.quantity > 0 and h.manual_card_id is not null)::text
  from public.holdings h
  left join lateral (
    select coalesce(sum(l.quantity_remaining) filter (where l.voided_at is null), 0)::bigint
      as quantity
    from public.acquisition_lots l
    where l.holding_id = h.id
  ) q on true
  where h.deleted_at is null and h.user_id = (select auth.uid());
$$;

grant execute on function public.portfolio_counts() to authenticated;
revoke execute on function public.portfolio_counts() from public;

-- ── 3. list_portfolio — sorted, filtered, keyset-paginated Portfolio browsing ───────────────────
--
-- KEYSET, NOT OFFSET (M7 prompt §55/§116). The cursor is carried as several nullable typed
-- columns rather than one opaque token because the sort key differs by mode and PostgREST cannot
-- accept a polymorphic parameter — the client always supplies the cursor fields for whichever
-- sort is active (taken verbatim from the last row of the previous page) and leaves the rest null;
-- the WHERE clause below only reads the fields the active p_sort branch needs.
--
-- VALUE SORT BEFORE M9 (M7 prompt §30). No raw-card market price exists yet. "Value" here means
-- only a graded holding's active manual valuation (manual_valuations, shipped in M6) — a real,
-- known number, never a fabricated one and never the acquisition cost standing in for market
-- value. Every raw-card holding therefore has a NULL value and sorts into a second bucket ordered
-- by name, deterministically, never as if it were worth zero. When M9 adds a real resolved value
-- for raw cards, only the `mv.value_nok_minor` expression below needs to change to a fuller
-- resolver call — the sort contract, bucketing and cursor shape all stay exactly as they are.
--
-- SQL BRANCHES, NOT STRING CONCATENATION (M7 prompt §75). `p_sort` is a Postgres enum, so an
-- invalid value cannot reach the function body at all — Postgres rejects it at the call boundary.
-- Every ORDER BY/cursor comparison below is one explicit branch per enum value; nothing here
-- builds a query string from caller input.

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
  from public.holdings h
  join lateral (
    select
      coalesce(sum(l.quantity_remaining) filter (where l.voided_at is null), 0)::bigint as quantity,
      count(l.id) filter (where l.voided_at is null and l.quantity_remaining > 0) as lot_count,
      min(l.acquired_on) filter (where l.voided_at is null) as acquired_min,
      max(l.acquired_on) filter (where l.voided_at is null) as acquired_max,
      count(distinct l.storage_location_id) filter (
        where l.voided_at is null and l.storage_location_id is not null
      ) as storage_location_count
    from public.acquisition_lots l
    where l.holding_id = h.id
  ) q on true
  left join public.card_variants cv on cv.id = h.card_variant_id
  left join public.cards c on c.id = cv.card_id
  left join public.card_sets cs on cs.id = c.set_id
  left join public.manual_card_definitions mc on mc.id = h.manual_card_id
  left join public.manual_valuations mv on mv.holding_id = h.id and mv.superseded_at is null
  where h.deleted_at is null
    and h.user_id = v_user_id
    and q.quantity > 0
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

grant execute on function public.list_portfolio(
  public.portfolio_sort_order, int, text, uuid, public.card_condition, boolean, public.grader,
  boolean, text, boolean, uuid, uuid, uuid, boolean, boolean, uuid, text, text, bigint, date,
  timestamptz, bigint, boolean
) to authenticated;
revoke execute on function public.list_portfolio(
  public.portfolio_sort_order, int, text, uuid, public.card_condition, boolean, public.grader,
  boolean, text, boolean, uuid, uuid, uuid, boolean, boolean, uuid, text, text, bigint, date,
  timestamptz, bigint, boolean
) from public;

-- Profile preference joins the client-writable column list (M7 prompt §32/§66).
grant update (collection_default_sort) on public.profiles to authenticated;
