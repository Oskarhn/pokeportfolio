-- M8 restates the complete privilege baseline (SECURITY.md §5.9) — required because five new
-- routines exist (allocate_largest_remainder, create_purchase, update_purchase, void_purchase,
-- purchase_spending_summary) and one new table exists (fx_rates). CI selects the
-- lexicographically-latest `*_privilege_baseline.sql` automatically, so this file becoming the
-- newest one is what makes it "the" baseline from here — no CI edit needed. No purchases/
-- purchase_lines/acquisition_lots column list changes: M8 writes only through columns those
-- tables' grants already named.

-- ── 1. Schema-level ──────────────────────────────────────────────────────────────────────────

grant usage on schema public to anon, authenticated;
revoke create on schema public from anon, authenticated;

-- ── 2. Default privileges: stop future objects arriving pre-granted ──────────────────────────

alter default privileges for role postgres in schema public
  revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke all on functions from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke all on types from anon, authenticated;

alter default privileges for role postgres in schema public
  revoke execute on functions from public;

-- supabase_admin's default privileges are deliberately left alone here too — see
-- 20260820140000_m41_privilege_baseline.sql §2 for the full reasoning, unchanged since.

-- ── 3. Functions: sweep PUBLIC, then anon/authenticated, then grant back exactly the current set ─

revoke execute on all routines in schema public from public;

revoke execute on all routines in schema public from anon, authenticated;

grant execute on function public.invitation_status(text) to anon, authenticated;
grant execute on function public.is_admin() to authenticated;
grant execute on function public.create_invitation(text, int, text) to authenticated;
grant execute on function public.revoke_invitation(uuid) to authenticated;
grant execute on function public.card_condition_to_text(public.card_condition) to authenticated;
grant execute on function public.grader_to_text(public.grader) to authenticated;
grant execute on function public.search_cards(text, text, int, int) to authenticated, service_role;

-- M6: the atomic collection-writing surface.
grant execute on function public.add_card_acquisition(
  uuid, uuid, public.grading_state, public.card_condition, public.grader, numeric,
  text, boolean, text, public.lot_origin, public.cost_basis_state, bigint, int, date, uuid, text, bigint
) to authenticated;
grant execute on function public.set_manual_valuation(uuid, bigint, text, date) to authenticated;
grant execute on function public.void_acquisition_lot(uuid, text) to authenticated;

-- M7: Portfolio counts and the sorted/filtered/keyset-paginated browsing surface.
grant execute on function public.portfolio_counts() to authenticated;

-- M7.1: list_portfolio's current (post-number-sort) signature, and its natural-sort-key helper.
grant execute on function public.list_portfolio(
  public.portfolio_sort_order, int, text, uuid, public.card_condition, boolean, public.grader,
  boolean, text, boolean, uuid, uuid, uuid, boolean, boolean, uuid, text, text, bigint, date,
  timestamptz, bigint, boolean, text
) to authenticated;
grant execute on function public.natural_sort_key(text) to authenticated;

-- M8: the largest-remainder allocator and the purchase-ledger write/void/summary surface.
grant execute on function public.allocate_largest_remainder(bigint, bigint[]) to authenticated;
grant execute on function public.create_purchase(
  date, text, jsonb, uuid, bigint, bigint, bigint, numeric, date, public.fx_source, text
) to authenticated;
grant execute on function public.update_purchase(
  uuid, date, text, jsonb, uuid, bigint, bigint, bigint, numeric, date, public.fx_source, text
) to authenticated;
grant execute on function public.void_purchase(uuid, text) to authenticated;
grant execute on function public.purchase_spending_summary() to authenticated;

-- ── 4. Tables: sweep, then grant back, with system-owned columns excluded ────────────────────

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

grant select on
  public.card_series,
  public.card_sets,
  public.cards,
  public.card_variants
  to authenticated;

-- catalog_sync_runs gets no grant at all, to anon or authenticated — unchanged since M5.

grant select, insert, delete on public.sealed_products to authenticated;
grant update (
  set_id,
  product_type,
  name,
  language,
  pack_count,
  image_url,
  cardmarket_product_id,
  tcgplayer_product_id
) on public.sealed_products to authenticated;

grant select, insert, delete on public.retailers to authenticated;
grant update (name, notes) on public.retailers to authenticated;

grant select, insert, delete on public.storage_locations to authenticated;
grant update (name, kind, sort_order) on public.storage_locations to authenticated;

grant select, insert, delete on public.tags to authenticated;
grant update (name) on public.tags to authenticated;

grant select, insert on public.purchases to authenticated;
grant update (
  purchased_on,
  retailer_id,
  currency,
  subtotal_minor,
  shipping_minor,
  customs_minor,
  discount_minor,
  total_minor,
  fx_rate_to_nok,
  fx_rate_date,
  fx_source,
  total_nok_minor,
  notes,
  voided_at
) on public.purchases to authenticated;

grant select, insert on public.purchase_lines to authenticated;
grant update (
  line_type,
  spend_class,
  description,
  card_variant_id,
  sealed_product_id,
  condition,
  quantity,
  unit_price_minor,
  line_total_minor,
  allocated_shipping_minor,
  allocated_customs_minor,
  allocated_discount_minor,
  attributable_cost_minor,
  attributable_cost_nok_minor
) on public.purchase_lines to authenticated;

grant select, insert on public.acquisition_lots to authenticated;
grant update (
  cost_basis_state,
  purchase_line_id,
  acquired_on,
  quantity,
  quantity_remaining,
  unit_cost_basis_minor,
  cost_basis_currency,
  unit_cost_basis_nok_minor,
  residual_minor,
  notes,
  voided_at,
  storage_location_id
) on public.acquisition_lots to authenticated;

grant select, insert, delete on public.holdings to authenticated;
grant update (
  holding_kind,
  card_variant_id,
  sealed_product_id,
  manual_card_id,
  condition,
  grading_state,
  grader,
  grade,
  cert_number,
  sealed_intent,
  is_favorite,
  notes,
  deleted_at
) on public.holdings to authenticated;

grant select, insert, delete on public.manual_card_definitions to authenticated;
grant update (
  name, set_name, collector_number, language, finish, stamp, subtype, size, notes
) on public.manual_card_definitions to authenticated;

grant select, insert, delete on public.holding_tags to authenticated;

grant select, insert on public.manual_valuations to authenticated;
grant update (superseded_at) on public.manual_valuations to authenticated;

grant select on public.holding_summaries to authenticated;

-- M7: custom collections and their membership join table (DATA_MODEL.md §5.2.1).
grant select, insert, delete on public.custom_collections to authenticated;
grant update (name, description, sort_order, color) on public.custom_collections to authenticated;

grant select, insert, delete on public.custom_collection_members to authenticated;

-- M8: the Norges Bank FX-rate cache — market data, read-only for the browser (DATA_MODEL.md §1),
-- written only by the fetch-fx-rate Edge Function under the service role.
grant select on public.fx_rates to authenticated;

grant select on public.profiles to authenticated;
grant update (
  display_name,
  locale,
  display_currency,
  theme,
  collection_grid_density,
  collection_default_view,
  collection_default_sort,
  low_value_threshold_minor,
  hide_low_value_by_default,
  default_condition,
  default_language,
  default_storage_location_id,
  hide_values,
  use_eu_pricing
) on public.profiles to authenticated;

grant select (
  id,
  email,
  label,
  expires_at,
  max_uses,
  use_count,
  revoked_at,
  created_at,
  created_by
) on public.invitations to authenticated;

grant select on public.invitation_overview to authenticated;
grant select on public.invitation_redemptions to authenticated;

-- public.invitation_claims: no grant, to any browser-reachable role, ever.

-- ── 5. anon holds nothing but one function ───────────────────────────────────────────────────

-- The sweep above is the whole of anon's table privileges; invitation_status is the whole of its
-- function privileges — unchanged by M8.
