-- M7.1 (prompt §41/§72): Portfolio "Card number low/high" sort, backed by real data — a holding's
-- catalog `local_id` or manual `collector_number` — never a fabricated ordering key.
--
-- Collector numbers are strings, not integers ("1", "001", "SV049", "TG12", "H31", "277") — casting
-- every local_id to int would fail outright on the alphanumeric ones and get the padding wrong on
-- the numeric ones ("9" sorting after "10" as plain text). natural_sort_key() below splits the
-- string into alternating digit/non-digit runs and zero-pads each digit run to a fixed width, which
-- gives numeric-feeling order within a run of digits ("4" < "31" < "102") and a stable lexical
-- fallback for the non-digit parts ("H" < "SV" < "TG") — a real, deterministic, honest ordering
-- over data the app already has, not a market-value proxy (D-041's same reasoning: never fabricate
-- what isn't there).
--
-- Examples this key is designed to order correctly (ascending):
--   "4"      -> "00000004"
--   "9"      -> "00000009"
--   "10"     -> "00000010"
--   "4/102"  -> "00000004/00000102"
--   "H4"     -> "h00000004"
--   "H31"    -> "h00000031"
--   "SV049"  -> "sv00000049"
--   "TG12"   -> "tg00000012"

create or replace function public.natural_sort_key(p_text text)
returns text
language sql
immutable
set search_path = ''
as $$
  select coalesce(
    string_agg(
      case when m[1] is not null then lpad(m[1], 8, '0') else lower(m[2]) end,
      '' order by ordinality
    ),
    ''
  )
  from regexp_matches(coalesce(p_text, ''), '([0-9]+)|([^0-9]+)', 'g')
    with ordinality as t(m, ordinality);
$$;

comment on function public.natural_sort_key(text) is
  'Deterministic natural-sort key for alphanumeric collector numbers. See migration header.';

grant execute on function public.natural_sort_key(text) to authenticated;
revoke execute on function public.natural_sort_key(text) from public;

-- ── list_portfolio: add the number_asc/number_desc branch and its keyset cursor field ───────────
--
-- Adding a new parameter changes the function's identity (Postgres identifies a function by name
-- + argument types, not just name), so CREATE OR REPLACE cannot be used here — it would create a
-- second overload alongside the old one rather than replace it, and a call matching both via
-- defaults would then fail with "function is not unique". Drop the exact old signature first.

drop function if exists public.list_portfolio(
  public.portfolio_sort_order, int, text, uuid, public.card_condition, boolean, public.grader,
  boolean, text, boolean, uuid, uuid, uuid, boolean, boolean, uuid, text, text, bigint, date,
  timestamptz, bigint, boolean
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
  resolved_value_nok_minor text,
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
    q.storage_location_count > 1,
    public.natural_sort_key(coalesce(c.local_id, mc.collector_number, ''))
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
        or (p_sort = 'number_asc' and (
          public.natural_sort_key(coalesce(c.local_id, mc.collector_number, '')), h.id
        ) > (coalesce(p_cursor_number_key, ''), p_cursor_holding_id))
        or (p_sort = 'number_desc' and (
          public.natural_sort_key(coalesce(c.local_id, mc.collector_number, '')), h.id
        ) < (coalesce(p_cursor_number_key, ''), p_cursor_holding_id))
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
