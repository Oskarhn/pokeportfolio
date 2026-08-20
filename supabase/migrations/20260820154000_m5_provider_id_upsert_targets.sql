-- M5 follow-up, found by actually running the ingest function against the remote project (which
-- is exactly why M5 prompt §12 makes now the right time for schema corrections): every provider-id
-- unique index added in 20260820150000 was built `WHERE <col> IS NOT NULL` — reasonable-looking,
-- wrong in the same way as the card_variants identity index. PostgREST's upsert `on_conflict`
-- parameter asks Postgres to match a unique constraint or index by its literal column list with no
-- predicate, so it cannot target a partial index, and every series/set/card upsert in
-- sync-catalog failed with "no unique or exclusion constraint matching the ON CONFLICT
-- specification" on first real use.
--
-- The partial predicate was never actually buying anything: a plain (non-partial) unique
-- constraint on nullable columns already permits any number of NULLs in Postgres — each NULL is
-- unequal to every other value, including another NULL — so `UNIQUE (language, tcgdex_set_id)`
-- and `UNIQUE (language, tcgdex_set_id) WHERE tcgdex_set_id IS NOT NULL` accept exactly the same
-- rows. Dropping the predicate loses nothing and makes the constraint upsert-targetable.

drop index public.card_series_tcgdex_series_id_key;
alter table public.card_series
  add constraint card_series_tcgdex_series_id_key unique (language, tcgdex_series_id);

drop index public.card_sets_tcgdex_set_id_key;
alter table public.card_sets
  add constraint card_sets_tcgdex_set_id_key unique (language, tcgdex_set_id);

drop index public.cards_tcgdex_card_id_key;
alter table public.cards
  add constraint cards_tcgdex_card_id_key unique (language, tcgdex_card_id);
