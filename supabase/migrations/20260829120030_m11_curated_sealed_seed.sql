-- M11: a deliberately modest curated sealed_products seed (prompt §14-15).
--
-- PROVENANCE (verified by live web search against retailer/official listings at migration time,
-- not scraped at runtime, not guessed): every row below is a real product this session could find
-- named, priced or described by an official/retailer source. This is NOT a complete catalog of
-- every sealed product that exists for every set already in card_sets — it exists to prove the
-- shape (set-linked and non-set-linked products, pack/box/ETB/bundle/tin types, two languages), not
-- to be exhaustive. The "Add custom sealed product" flow is the intended way a user fills a real gap
-- this seed does not cover (prompt §12-13).
--
--   - Mega Evolution—Pitch Black (set slug 'me05', EN, released 2026-07-17): booster pack, the
--     standard 9-pack Elite Trainer Box, and the 36-pack booster box. Sources: tcg.pokemon.com/en-us
--     /expansions/pitch-black/, pokemon.com's Pitch Black product showcase, GameStop/Target/Amazon
--     ETB listings (9 packs + 1 promo + sleeves/energy/dice, standard version — the separate
--     Pokémon Center 11-pack ETB variant is deliberately not seeded, to keep this list modest).
--   - Mega Evolution—Phantasmal Flames (set slug 'me02', EN): the 36-pack booster box. Sources:
--     Walmart/ToyWiz/Flipside Gaming listings, each independently stating 36 packs.
--   - Mega Evolution—Chaos Rising (set slug 'me04', EN): the 6-pack booster bundle. Source: Amazon's
--     "Mega Evolution—Chaos Rising Booster Bundle (6 Booster Packs)" listing.
--   - Mega Moonlit Tin (EN, no single set — a standalone promo tin, not itself "part of" one numbered
--     expansion the way a booster box is): 4 booster packs plus a promo, released June 2026. Source:
--     PocketMonsters.Net's Mega Moonlit Tin coverage. Seeded with set_id null deliberately (prompt
--     §9/§15's "non-set/multi-set product" case).
--   - MEGA拡張パック「ムニキスゼロ」(set slug 'M3', JA, released 2026-01-23): the booster box.
--     Source: kakaku.com/価格.com's listing states a box price of ¥5,400 at ¥180/pack; 5400 ÷ 180 =
--     30 packs, matching the long-standing standard Japanese booster-box size — pack_count is
--     derived from that stated price arithmetic, not asserted from a source that states "30 packs"
--     in so many words, and is disclosed here as exactly that: a arithmetic derivation, not a guess.

insert into public.sealed_products (set_id, product_type, name, language, pack_count, created_by_user_id)
values
  (
    (select id from public.card_sets where slug = 'me05'),
    'booster_pack', 'Mega Evolution—Pitch Black Booster Pack', 'en', null, null
  ),
  (
    (select id from public.card_sets where slug = 'me05'),
    'elite_trainer_box', 'Mega Evolution—Pitch Black Elite Trainer Box', 'en', 9, null
  ),
  (
    (select id from public.card_sets where slug = 'me05'),
    'booster_box', 'Mega Evolution—Pitch Black Booster Box', 'en', 36, null
  ),
  (
    (select id from public.card_sets where slug = 'me02'),
    'booster_box', 'Mega Evolution—Phantasmal Flames Booster Box', 'en', 36, null
  ),
  (
    (select id from public.card_sets where slug = 'me04'),
    'booster_bundle', 'Mega Evolution—Chaos Rising Booster Bundle', 'en', 6, null
  ),
  (
    null,
    'tin', 'Mega Moonlit Tin', 'en', 4, null
  ),
  (
    (select id from public.card_sets where slug = 'M3'),
    'booster_box', 'MEGA拡張パック「ムニキスゼロ」BOX', 'ja', 30, null
  );
