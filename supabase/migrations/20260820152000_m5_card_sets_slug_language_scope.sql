-- M5 follow-up to 20260820150000: card_sets.slug had the identical cross-language collision bug
-- as tcgdex_set_id (a global `unique` constraint), just missed on the first pass because it reads
-- as an internal identifier rather than a provider field. It is not internal — the ingest adapter
-- populates it from the same provider set id (`base1`, `neo1`, ...) that collides across
-- languages, for the same reason: it is the natural, readable slug and there is no reason to
-- invent a second one. Scoped the same way as its sibling columns.

alter table public.card_sets drop constraint card_sets_slug_key;
create unique index card_sets_language_slug_key on public.card_sets (language, slug);
