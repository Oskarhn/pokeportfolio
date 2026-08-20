-- M5 follow-up, found by browser-testing the real feature (M5 prompt §74's actual point): a query
-- like "Base Set 4" split correctly into text "Base Set" + number "4", but the WHERE clause's
-- `local_id ilike v_number_token || '%'` treats "4" and "43"/"44"/.../"49" as equally matching, and
-- ranking only considered name/set-name similarity — so the exact card (#4) landed fourth, behind
-- five common-rarity cards whose numbers merely start with the same digit.
--
-- Ranking now prefers an exact local_id match first, then falls back to the existing name
-- similarity — the WHERE clause is unchanged (prefix/suffix number matches stay included, so
-- "Base Set 4" still surfaces "Base Set 2" cards numbered 4x as lower-ranked matches rather than
-- excluding them, which is the right trade for a heuristic rather than a parser).

create or replace function public.search_cards(
  p_query text,
  p_language text default null,
  p_limit int default 40,
  p_offset int default 0
)
returns table (
  card_id uuid,
  name text,
  local_id text,
  rarity text,
  category text,
  illustrator text,
  image_base_url text,
  language text,
  set_id uuid,
  set_name text,
  variant_count bigint,
  total_count bigint
)
language plpgsql
stable
set search_path = ''
as $$
declare
  v_query text := btrim(coalesce(p_query, ''));
  v_number_token text;
  v_text_query text;
  v_limit int := least(greatest(coalesce(p_limit, 40), 1), 100);
  v_offset int := greatest(coalesce(p_offset, 0), 0);
begin
  v_number_token := (regexp_match(v_query, '([A-Za-z0-9]*\d[A-Za-z0-9/]*)\s*$'))[1];
  if v_number_token is not null then
    v_text_query := btrim(left(v_query, length(v_query) - length(v_number_token)));
  else
    v_text_query := v_query;
  end if;

  return query
  select
    c.id,
    c.name,
    c.local_id,
    c.rarity,
    c.category,
    c.illustrator,
    c.image_base_url,
    c.language,
    s.id,
    s.name,
    (select count(*) from public.card_variants v where v.card_id = c.id and v.is_active),
    count(*) over ()
  from public.cards c
  join public.card_sets s on s.id = c.set_id
  where
    (p_language is null or c.language = p_language)
    and c.is_active
    and (
      v_text_query = ''
      or c.name ilike '%' || v_text_query || '%'
      or s.name ilike '%' || v_text_query || '%'
      or extensions.similarity(c.name, v_text_query) > 0.15
      or extensions.similarity(s.name, v_text_query) > 0.15
    )
    and (
      v_number_token is null
      or c.local_id ilike v_number_token || '%'
      or c.local_id ilike '%' || v_number_token
      or c.local_id ilike '%/' || v_number_token
      or c.local_id = v_number_token
    )
  order by
    -- Exact collector-number match first — "Base Set 4" means card #4, not #43-#49.
    (v_number_token is not null and c.local_id = v_number_token) desc,
    greatest(
      extensions.similarity(c.name, coalesce(nullif(v_text_query, ''), v_query)),
      extensions.similarity(s.name, coalesce(nullif(v_text_query, ''), v_query))
    ) desc,
    c.name asc,
    c.local_id asc
  limit v_limit offset v_offset;
end;
$$;
