-- Synthetic-but-real catalog seed. Card names, set and TCGdex ids below are public facts,
-- verified against https://api.tcgdex.net/v2/en/sets/base1 on 2026-08-17 — safe to commit
-- per docs/TESTING.md §9. No purchase, holding or lot data lives here: those need real
-- auth.users rows, which the authorization and db test suites create dynamically per run
-- (see tests/db/setup.ts) rather than baking synthetic accounts into SQL.
--
-- Fixed ids (not gen_random_uuid()) so tests/db and tests/authorization can reference known
-- rows without a lookup query first.

insert into public.card_series (id, slug, name) values
  ('c0000000-0000-0000-0000-000000000001', 'base', 'Base')
on conflict (id) do nothing;

insert into public.card_sets (id, series_id, slug, name, language, tcgdex_set_id) values
  ('c0000000-0000-0000-0000-000000000101', 'c0000000-0000-0000-0000-000000000001',
   'base1', 'Base Set', 'en', 'base1')
on conflict (id) do nothing;

-- One chase card, one common, one Basic Energy — deliberately spans the value range the
-- "every physical card is trackable" rule (D-017) has to hold up for.
insert into public.cards (id, set_id, local_id, name, rarity, tcgdex_card_id) values
  ('c0000000-0000-0000-0000-000000000401', 'c0000000-0000-0000-0000-000000000101',
   '4', 'Charizard', 'Rare Holo', 'base1-4'),
  ('c0000000-0000-0000-0000-000000000581', 'c0000000-0000-0000-0000-000000000101',
   '58', 'Pikachu', 'Common', 'base1-58'),
  ('c0000000-0000-0000-0000-000000000991', 'c0000000-0000-0000-0000-000000000101',
   '99', 'Grass Energy', 'Common', 'base1-99')
on conflict (id) do nothing;

insert into public.card_variants (id, card_id, variant_type, size) values
  ('c0000000-0000-0000-0000-0000000a4001', 'c0000000-0000-0000-0000-000000000401', 'holo', 'standard'),
  ('c0000000-0000-0000-0000-0000000a5801', 'c0000000-0000-0000-0000-000000000581', 'normal', 'standard'),
  ('c0000000-0000-0000-0000-0000000a9901', 'c0000000-0000-0000-0000-000000000991', 'normal', 'standard')
on conflict (id) do nothing;

-- One curated sealed product (created_by_user_id null) — visible to every authenticated user.
insert into public.sealed_products (id, set_id, product_type, name, language) values
  ('c0000000-0000-0000-0000-00000000b001', 'c0000000-0000-0000-0000-000000000101',
   'booster_pack', 'Base Set Booster Pack', 'en')
on conflict (id) do nothing;
