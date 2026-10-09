-- P201: collector-number matching in search_cards.
--
-- Two defects, both reproduced against the local stack (tests/db/p201_search_number_matching.test.ts):
--
-- 1. LEADING ZEROS. A collector number is printed zero-padded on modern cards ("058/102") and stored
--    by the provider either way ("58" in older sets, "058" in newer ones). `search_cards` compared the
--    typed number to `local_id` as TEXT, so "Charizard 004" found nothing when the set stores "4",
--    "Pikachu 058" found nothing when it stores "58", and the "exact number first" ranking missed an
--    exact match that differed only in padding — "Pikachu 25" could not rank the real number 25
--    above 125 and 250 in a set that stores "025".
--
-- 2. THE SET SIZE WAS THROWN AWAY. "58/102" was reduced to "58": the 102 — which identifies WHICH set's
--    card 58 is — was discarded, so the same name and number in two sets (reprints) tied on every
--    ranking key and landed in arbitrary order. A typed or scanned "58/102" now ranks the card whose
--    set has `card_count_official = 102` first. The ranking only ORDERS rows; no row is excluded
--    because of the denominator (a card whose set size differs is still a number match).
--
-- Matching rule: two numbers are equal when they are equal after removing leading zeros that are
-- followed by a digit ("004" = "4", "000" = "0", "SV004" is untouched — a letter prefix is part of
-- the number). The existing prefix / suffix predicates are kept as they were (typing "5" still offers
-- "58", "TG05"), as are the signature, the return columns, `stable`, SECURITY INVOKER,
-- `set search_path = ''` and the grants (CREATE OR REPLACE keeps the ACL), so no client changes.
--
-- Deployment order: this migration first; it is additive and backward compatible.

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
  v_number_norm text;
  v_denominator int;
  v_text_query text;
  v_limit int := least(greatest(coalesce(p_limit, 40), 1), 100);
  v_offset int := greatest(coalesce(p_offset, 0), 0);
begin
  v_number_token := (regexp_match(v_query, '([A-Za-z0-9]*\d[A-Za-z0-9/]*)\s*$'))[1];
  if v_number_token is not null then
    v_text_query := btrim(left(v_query, length(v_query) - length(v_number_token)));
    -- "4/102" means card 4 of a 102-card set: the numerator is the number ...
    v_number := split_part(v_number_token, '/', 1);
    v_number_norm := regexp_replace(v_number, '^0+(?=\d)', '');
    -- ... and the denominator, when it is a plain number that fits, names the set by its size.
    if v_number_token ~ '/\d{1,5}$' then
      v_denominator := (regexp_match(v_number_token, '/(\d{1,5})$'))[1]::int;
    end if;
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
      or regexp_replace(c.local_id, '^0+(?=\d)', '') = v_number_norm
    )
  order by
    (v_number is not null and regexp_replace(c.local_id, '^0+(?=\d)', '') = v_number_norm) desc,
    (v_denominator is not null and s.card_count_official = v_denominator) desc,
    greatest(
      extensions.similarity(c.name, coalesce(nullif(v_text_query, ''), v_query)),
      extensions.similarity(s.name, coalesce(nullif(v_text_query, ''), v_query))
    ) desc,
    c.name asc,
    c.local_id asc,
    -- Unique: a complete tie (same name, same number, other set) must still order the same way on
    -- every page, or OFFSET paging repeats and skips rows (P173).
    c.id asc
  limit v_limit offset v_offset;
end;
$$;
