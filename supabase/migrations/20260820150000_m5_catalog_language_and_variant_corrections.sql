-- M5: three schema corrections, made now because the catalog is still empty and this is the last
-- cheap point to fix them before M6 holdings attach to card_variants (DATA_MODEL.md §11).
--
-- All three are evidence, not preference — found by inspecting real TCGdex responses
-- (docs/RESEARCH.md records the probes and dates), not by guessing.
--
-- 1. PROVIDER IDS ARE NOT GLOBALLY UNIQUE ACROSS LANGUAGES. `/v2/en/sets` and `/v2/ja/sets` both
--    return a set with id `neo1` (English "Neo Genesis", Japanese "金、銀、新世界へ..."), and both
--    series lists contain a series id `neo`. The M3 schema put a *global* unique index on
--    `card_sets.tcgdex_set_id` and no provider-id column at all on `card_series`. Ingesting Japanese
--    Neo after English Neo would have thrown a unique-violation on the second row. Every provider-id
--    uniqueness constraint in this schema is now scoped by language, and `card_series` gains the
--    provider-id column it should have had from M3.
--
-- 2. FINISH, STAMP AND PRINT-RUN ARE THREE INDEPENDENT DIMENSIONS, NOT ONE ENUM. The M3
--    `variant_type` enum treats `holo` and `first_edition` as mutually exclusive values of the same
--    column. A real response disproves that: base1-4 (Charizard, Base Set) has a
--    `variants_detailed` entry with `type: "holo"`, `subtype: "shadowless"`,
--    `stamp: ["1st-edition"]` — holo, shadowless *and* first-edition simultaneously. The old enum
--    cannot represent that card at all; it would have to be lied about at ingest to fit one bucket.
--    `card_variants` now has three columns matching TCGdex's own dimensions: `finish` (a small enum
--    — normal/holo/reverse/other), `stamp` (free text — provider vocabulary here is not closed; we
--    have seen `1st-edition` and the `wPromo` boolean implies at least one more), `subtype` (free
--    text print-run/era marker — `shadowless`, `unlimited`, `1999-2000-copyright`, `no-rarity`
--    observed). Free text rather than enums for the latter two because a provider-controlled
--    vocabulary that grows without our involvement should not be able to fail an ingest.
--
-- 3. A CARDMARKET/TCGPLAYER PRODUCT ID IS NOT PER-VARIANT. swsh1-2 (Roselia) has both a `normal`
--    and a `reverse` variant; TCGdex's own pricing payload gives both finishes the *same* TCGplayer
--    `productId` (208268) — one marketplace listing, two priced finishes. The M3 schema's unique
--    index on `card_variants.tcgplayer_product_id` (and the Cardmarket equivalent) would reject the
--    second row. These become plain, non-unique, indexed columns: useful for lookup and for M9's
--    price ingest, never a claim of one-to-one identity. `tcgdex_variant_id` gets the same
--    treatment for a different reason — TCGdex returns the literal string `"generated"` for a
--    variant it has no real cross-reference for (observed on swsh1-1, swsh1-2, swshp-SWSH001), which
--    is not a value that identifies anything and repeats across unrelated cards. The provider
--    adapter stores NULL rather than that sentinel; the column keeps a plain index for the rows
--    where TCGdex does supply a real id.
--
-- Internal uuid identity remains canonical throughout (DATA_MODEL.md §3.4) — none of this changes
-- what a holding points at, only how provider facts map onto the catalog.

-- ── 1. card_series: language-scope identity, add the provider-id column M3 omitted ────────────

alter table public.card_series
  add column language text,
  add column tcgdex_series_id text,
  add column is_active boolean not null default true,
  add column last_seen_at timestamptz;

update public.card_series set language = 'en' where language is null;
alter table public.card_series alter column language set not null;

alter table public.card_series drop constraint card_series_slug_key;
create unique index card_series_language_slug_key on public.card_series (language, slug);
create unique index card_series_tcgdex_series_id_key
  on public.card_series (language, tcgdex_series_id) where tcgdex_series_id is not null;

-- ── 2. card_sets: scope the provider-id uniqueness by language; add staleness tracking ────────

drop index public.card_sets_tcgdex_set_id_key;
create unique index card_sets_tcgdex_set_id_key
  on public.card_sets (language, tcgdex_set_id) where tcgdex_set_id is not null;

alter table public.card_sets
  add column is_active boolean not null default true,
  add column last_seen_at timestamptz;

-- ── 3. cards: denormalize language from the parent set (needed for the same reason user_id is   ──
--    denormalized onto child tables elsewhere — a partial unique index cannot reach across a join)

alter table public.cards
  add column language text,
  add column is_active boolean not null default true,
  add column last_seen_at timestamptz;

update public.cards c set language = s.language from public.card_sets s where s.id = c.set_id;
alter table public.cards alter column language set not null;

create or replace function public.cards_language_matches_set()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.language <> (select language from public.card_sets where id = new.set_id) then
    raise exception 'cards.language (%) does not match card_sets.language for set %',
      new.language, new.set_id;
  end if;
  return new;
end;
$$;

comment on function public.cards_language_matches_set() is
  'Mirrors the user_id-matches-parent trigger pattern used on user-private child tables: a denormalized column must not drift from the parent it was copied from.';

create trigger cards_check_language_matches_set
  before insert or update of language, set_id on public.cards
  for each row execute function public.cards_language_matches_set();

drop index public.cards_tcgdex_card_id_key;
create unique index cards_tcgdex_card_id_key
  on public.cards (language, tcgdex_card_id) where tcgdex_card_id is not null;

create index cards_language_idx on public.cards (language);

-- ── 4. card_variants: finish / stamp / subtype replace the single variant_type enum ────────────

create type public.card_finish as enum ('normal', 'holo', 'reverse', 'other');

alter table public.card_variants
  add column finish public.card_finish,
  add column stamp text,
  add column subtype text,
  add column last_seen_at timestamptz;

-- The table is empty in every environment this migration will ever run against (M5 is the first
-- milestone to write to it), so there is no real data to remap — this default exists only to let
-- the NOT NULL land in the same statement without a two-phase backfill.
update public.card_variants set finish = 'other' where finish is null;
alter table public.card_variants alter column finish set not null;

alter table public.card_variants drop constraint card_variants_card_id_variant_type_size_key;
alter table public.card_variants drop column variant_type;
drop type public.variant_type;

create unique index card_variants_identity_key on public.card_variants (
  card_id, finish, coalesce(stamp, ''), coalesce(subtype, ''), size
);

drop index public.card_variants_tcgdex_variant_id_key;
create index card_variants_tcgdex_variant_id_idx
  on public.card_variants (tcgdex_variant_id) where tcgdex_variant_id is not null;

drop index public.card_variants_cardmarket_product_id_key;
create index card_variants_cardmarket_product_id_idx
  on public.card_variants (cardmarket_product_id) where cardmarket_product_id is not null;

drop index public.card_variants_tcgplayer_product_id_key;
create index card_variants_tcgplayer_product_id_idx
  on public.card_variants (tcgplayer_product_id) where tcgplayer_product_id is not null;

comment on column public.card_variants.finish is
  'The printed finish: normal, holo or reverse holo. TCGdex''s own `type` field on variants_detailed.';
comment on column public.card_variants.stamp is
  'Free-text stamp marker (e.g. 1st-edition). Provider vocabulary, not a closed set — see migration header.';
comment on column public.card_variants.subtype is
  'Free-text print-run/era marker (e.g. shadowless, unlimited). Provider vocabulary, not a closed set.';
