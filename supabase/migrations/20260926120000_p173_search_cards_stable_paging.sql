-- P173 (P169 finding F1): search_cards paged with OFFSET over a NON-unique ORDER BY.
--
-- The ranking ended in `c.name asc, c.local_id asc`. Two cards with the same name and the same
-- collector number in different sets ("Pikachu #025" in the base set and in a reprint) tie on every
-- sort key, and the order among tied rows is whatever the plan happens to produce. Two OFFSET pages
-- of the same query can then disagree about which of those rows they hold: a card can appear on both
-- pages while another appears on neither. The native app paged 25 rows at a time and could only hide
-- the repeat (de-duplication by card id); it could not recover the row that was skipped.
--
-- The fix is a final, unique sort key: `c.id asc`. The order of every pair of rows that already
-- differed is unchanged (the new key is only reached on a complete tie), so ordinary results, the
-- "exact number first" rule and the similarity ranking are exactly as before.
--
-- Deliberately unchanged, and checked by tests/db/search_cards_paging.test.ts and the existing
-- authorization suite:
--   - the signature, the return columns and their types (a client of the previous version keeps
--     working; the released web and native clients need no change and no coordinated release),
--   - `stable`, SECURITY INVOKER (no `security definer`) and `set search_path = ''`: the function
--     still runs with the caller's own rights, so row-level security on cards / card_sets /
--     card_variants applies exactly as before,
--   - the grants: CREATE OR REPLACE keeps the function's ACL, so the privilege baseline
--     (20260915120010_p133_privilege_baseline.sql) still describes it.
--
-- Deployment order: this migration first, then any client. It is additive and backward compatible,
-- so there is no window in which a released client and this function disagree.

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
    c.local_id asc,
    -- Unique: a complete tie (same name, same number, other set) must still order the same way on
    -- every page, or OFFSET paging repeats and skips rows.
    c.id asc
  limit v_limit offset v_offset;
end;
$$;
