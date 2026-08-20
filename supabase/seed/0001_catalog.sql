-- Synthetic-but-real catalog seed. Card names, set and TCGdex ids below are public facts,
-- verified against https://api.tcgdex.net/v2/en/sets/base1 and /v2/ja/sets/PMCG1 on 2026-08-20 —
-- safe to commit per docs/TESTING.md §9. No purchase, holding or lot data lives here: those need
-- real auth.users rows, which the authorization and db test suites create dynamically per run
-- (see tests/db/setup.ts) rather than baking synthetic accounts into SQL.
--
-- Fixed ids (not gen_random_uuid()) so tests/db and tests/authorization can reference known
-- rows without a lookup query first.
--
-- Deliberately spans what M5's search and variant-model tests need to exercise without a live
-- TCGdex call: one English series/set, one Japanese series/set with a colliding provider slug/id
-- (`neo` / `neo1`, matching the real cross-language collision RESEARCH.md records), a card with
-- more than one variant across more than one dimension (finish + stamp + subtype), a Basic Energy,
-- and every card missing an image (image_base_url stays null throughout — the seed never needs a
-- real asset to be a valid fixture, and this doubles as the missing-image UI test case).

insert into public.card_series (id, slug, name, language, tcgdex_series_id) values
  ('c0000000-0000-0000-0000-000000000001', 'base', 'Base', 'en', 'base'),
  ('c0000000-0000-0000-0000-000000000002', 'neo', 'Neo', 'ja', 'neo')
on conflict (id) do nothing;

insert into public.card_sets (id, series_id, slug, name, language, tcgdex_set_id) values
  ('c0000000-0000-0000-0000-000000000101', 'c0000000-0000-0000-0000-000000000001',
   'base1', 'Base Set', 'en', 'base1'),
  ('c0000000-0000-0000-0000-000000000102', 'c0000000-0000-0000-0000-000000000002',
   'neo1', 'Neo Genesis (JA)', 'ja', 'neo1')
on conflict (id) do nothing;

-- One chase card (with real dimensional variant richness), one common, one Basic Energy — spans
-- the value range the "every physical card is trackable" rule (D-017) has to hold up for. Plus one
-- Japanese card for language-filter and Japanese-text search coverage.
insert into public.cards (id, set_id, local_id, name, rarity, category, language, tcgdex_card_id) values
  ('c0000000-0000-0000-0000-000000000401', 'c0000000-0000-0000-0000-000000000101',
   '4', 'Charizard', 'Rare Holo', 'Pokemon', 'en', 'base1-4'),
  ('c0000000-0000-0000-0000-000000000581', 'c0000000-0000-0000-0000-000000000101',
   '58', 'Pikachu', 'Common', 'Pokemon', 'en', 'base1-58'),
  ('c0000000-0000-0000-0000-000000000991', 'c0000000-0000-0000-0000-000000000101',
   '99', 'Grass Energy', 'Common', 'Energy', 'en', 'base1-99'),
  ('c0000000-0000-0000-0000-000000000701', 'c0000000-0000-0000-0000-000000000102',
   '001', 'フシギダネ', 'Common', 'Pokemon', 'ja', 'neo1-001')
on conflict (id) do nothing;

-- Charizard: two variants of the *same* card spanning finish, stamp and subtype at once — the
-- exact shape (holo + shadowless + 1st-edition vs. holo + unlimited) that the old single-enum
-- variant_type could not represent. See the M5 migration header for the real base1-4 response this
-- mirrors.
insert into public.card_variants (id, card_id, finish, stamp, subtype, size) values
  ('c0000000-0000-0000-0000-0000000a4001', 'c0000000-0000-0000-0000-000000000401',
   'holo', '', 'unlimited', 'standard'),
  ('c0000000-0000-0000-0000-0000000a4002', 'c0000000-0000-0000-0000-000000000401',
   'holo', '1st-edition', 'shadowless', 'standard'),
  ('c0000000-0000-0000-0000-0000000a5801', 'c0000000-0000-0000-0000-000000000581',
   'normal', '', '', 'standard'),
  ('c0000000-0000-0000-0000-0000000a9901', 'c0000000-0000-0000-0000-000000000991',
   'normal', '', '', 'standard'),
  ('c0000000-0000-0000-0000-0000000a7001', 'c0000000-0000-0000-0000-000000000701',
   'normal', '', '', 'standard')
on conflict (id) do nothing;

-- One curated sealed product (created_by_user_id null) — visible to every authenticated user.
insert into public.sealed_products (id, set_id, product_type, name, language) values
  ('c0000000-0000-0000-0000-00000000b001', 'c0000000-0000-0000-0000-000000000101',
   'booster_pack', 'Base Set Booster Pack', 'en')
on conflict (id) do nothing;
