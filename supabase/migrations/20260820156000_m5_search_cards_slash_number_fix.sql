-- M5 follow-up, found by browser-testing "Charizard 4/102" (a real, common way collectors write a
-- card — number 4 of a 102-card set). The trailing-token regex correctly captured "4/102" as one
-- token, but then filtered `local_id` against the literal string "4/102" — the printed local_id is
-- just "4"; the "/102" is the set's total card count, not part of the card's own number. Zero
-- results for a query the product spec (M5 prompt §44) names as a target example.
--
-- Fixed by splitting the number token on its first "/" and filtering local_id against the part
-- before it. A local_id that itself legitimately contains a slash (TCGdex does print some as
-- "001/165") still matches, because the WHERE clause's suffix/prefix ILIKE forms are unchanged —
-- only the exact-match equality and the ranking boost now compare against the split-off numerator.

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
  v_number text;
  v_text_query text;
  v_limit int := least(greatest(coalesce(p_limit, 40), 1), 100);
  v_offset int := greatest(coalesce(p_offset, 0), 0);
begin
  v_number_token := (regexp_match(v_query, '([A-Za-z0-9]*\d[A-Za-z0-9/]*)\s*$'))[1];
  if v_number_token is not null then
    v_text_query := btrim(left(v_query, length(v_query) - length(v_number_token)));
    -- "4/102" means card 4 of a 102-card set — match on the numerator, not the literal string.
    v_number := split_part(v_number_token, '/', 1);
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
      v_number is null
      or c.local_id ilike v_number || '%'
      or c.local_id ilike '%' || v_number
      or c.local_id ilike '%/' || v_number
      or c.local_id = v_number
    )
  order by
    (v_number is not null and c.local_id = v_number) desc,
    greatest(
      extensions.similarity(c.name, coalesce(nullif(v_text_query, ''), v_query)),
      extensions.similarity(s.name, coalesce(nullif(v_text_query, ''), v_query))
    ) desc,
    c.name asc,
    c.local_id asc
  limit v_limit offset v_offset;
end;
$$;
