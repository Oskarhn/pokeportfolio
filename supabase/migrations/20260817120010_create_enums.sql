-- Enum vocabulary for M3 scope only. Values tied to a feature that ships in a later milestone
-- (openings, trades, price snapshots, grading) are deliberately NOT added yet — they arrive via
-- `ALTER TYPE ... ADD VALUE` in the migration that introduces the table they support. See
-- DATA_MODEL.md and ROADMAP.md for the milestone that owns each deferred value.

-- Catalog
create type public.variant_type as enum (
  'normal', 'holo', 'reverse', 'first_edition', 'promo', 'stamped', 'other'
);

create type public.card_size as enum (
  'standard', 'oversized'
);

create type public.sealed_product_type as enum (
  'booster_pack', 'booster_bundle', 'booster_box', 'elite_trainer_box', 'collection_box',
  'tin', 'blister', 'ultra_premium_collection', 'other'
);

-- Profile / preference
create type public.theme_preference as enum ('system', 'light', 'dark');
create type public.collection_view as enum ('grid', 'list', 'table');

-- Organisation
create type public.storage_location_kind as enum (
  'binder', 'box', 'toploader_box', 'graded_case', 'shelf', 'other'
);

-- Card physical state
create type public.card_condition as enum ('MT', 'NM', 'EX', 'GD', 'LP', 'PL', 'PO');
create type public.grading_state as enum ('raw', 'pending', 'graded');
create type public.grader as enum ('psa', 'cgc', 'bgs', 'ace', 'sgc', 'tag', 'other');
create type public.sealed_intent as enum ('keep_sealed', 'planned_to_open', 'undecided');
create type public.holding_kind as enum ('raw_card', 'graded_card', 'sealed');

-- Money / FX
create type public.fx_source as enum ('norges_bank', 'manual');

-- Purchases
create type public.purchase_origin as enum ('manual', 'provisional_opening');
create type public.line_type as enum (
  'card', 'sealed', 'grading_fee', 'grading_shipping', 'bulk_lot', 'accessory',
  'shipping_standalone', 'customs_standalone', 'other'
);
create type public.spend_class as enum ('collectible', 'hobby');

-- Acquisition lots — M3 subset only. 'opening' and 'trade_in' are added by the migrations that
-- introduce the openings and trades tables (ROADMAP M16, M18), alongside the columns
-- (opening_id, trade_line_id) those origins require.
create type public.lot_origin as enum ('purchase', 'gift', 'found', 'pre_tracking', 'other');

-- Cost-basis state — M3 subset. 'unallocated_opening' and 'trade_in' are added alongside the
-- lot_origin values they pair with (M16, M18). See FINANCIAL_MODEL.md §1.1.
create type public.cost_basis_state as enum ('known', 'not_paid', 'unknown');
