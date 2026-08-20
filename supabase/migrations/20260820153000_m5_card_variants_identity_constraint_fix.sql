-- M5 follow-up to 20260820150000: `card_variants_identity_key` was built as an *expression* index
-- (`coalesce(stamp, ''), coalesce(subtype, '')`) so two variants differing only by a NULL stamp
-- would not silently collide. That is correct in principle and wrong in practice: PostgREST's
-- upsert `on_conflict` parameter names bare columns and asks Postgres to match an existing unique
-- constraint or index by that literal column list — it cannot target an expression index, so the
-- ingest function's per-variant upsert (`onConflict: 'card_id,finish,stamp,subtype,size'`) would
-- fail every time against the index as first written.
--
-- Fixed the simpler way: `stamp`/`subtype` become `not null default ''` (empty string standing for
-- "provider did not report one" — safe here because TCGdex never returns an empty string for
-- either field, only omits it or gives a real one), and the identity constraint becomes a plain
-- table constraint on the literal columns, which both Postgres's ON CONFLICT inference and
-- PostgREST's upsert can target directly.

update public.card_variants set stamp = '' where stamp is null;
update public.card_variants set subtype = '' where subtype is null;

alter table public.card_variants
  alter column stamp set default '',
  alter column stamp set not null,
  alter column subtype set default '',
  alter column subtype set not null;

drop index public.card_variants_identity_key;
alter table public.card_variants
  add constraint card_variants_identity_key unique (card_id, finish, stamp, subtype, size);
