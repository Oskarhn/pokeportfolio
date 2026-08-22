-- M11 restates the complete privilege baseline (SECURITY.md §5.9) — required because this milestone
-- adds one new function (set_sealed_lot_intent), changes two existing functions' signatures
-- (add_card_acquisition gained p_sealed_product_id/p_sealed_intent; list_portfolio gained
-- p_holding_kind/p_sealed_product_type/p_sealed_intent and a new return-column set), and moves
-- sealed_intent from holdings' UPDATE column grant to acquisition_lots'. Everything else below is
-- identical to `20260828120020_m10_privilege_baseline.sql`; only the additions noted inline changed.
-- CI selects the lexicographically-latest `*_privilege_baseline.sql` automatically, so this file
-- becoming the newest one is what makes it "the" baseline from here.

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
-- M11: add_card_acquisition gained p_sealed_product_id/p_sealed_intent (20260829120020) — a
-- DROP+CREATE, since adding a parameter changes a function's identity for Postgres's own matching
-- rules, so the OLD 17-parameter signature no longer exists to grant.
grant execute on function public.add_card_acquisition(
  uuid, uuid, public.grading_state, public.card_condition, public.grader, numeric,
  text, boolean, text, public.lot_origin, public.cost_basis_state, bigint, int, date, uuid, text,
  bigint, uuid, public.sealed_intent
) to authenticated;
grant execute on function public.set_manual_valuation(uuid, bigint, text, date) to authenticated;
grant execute on function public.void_acquisition_lot(uuid, text) to authenticated;

-- M11: the sealed-lot intent surface (20260829120000) — organisational only, never touches cost
-- basis, spend or market value (FINANCIAL_MODEL.md §1.1, prompt §20/§80).
grant execute on function public.set_sealed_lot_intent(uuid, public.sealed_intent, int) to authenticated;

-- M7: Portfolio counts and the sorted/filtered/keyset-paginated browsing surface.
-- M9: portfolio_counts gained an optional p_custom_collection_id argument (scoped value figure).
-- M11: portfolio_counts' signature is unchanged (still one uuid argument) — only its return columns
-- grew (cards/sealed value segment, sealed-scoped priced/unpriced/unit counts, 20260829120010).
grant execute on function public.portfolio_counts(uuid) to authenticated;

-- M7.1: list_portfolio's post-number-sort signature. M9/M9.1 changed only its body/return columns
-- (DROP+CREATE, same arg types as M7.1). M11 (20260829120010) appends p_holding_kind/
-- p_sealed_product_type/p_sealed_intent and grows the return-column set — another DROP+CREATE, so
-- this is the signature to grant from here on.
grant execute on function public.list_portfolio(
  public.portfolio_sort_order, int, text, uuid, public.card_condition, boolean, public.grader,
  boolean, text, boolean, uuid, uuid, uuid, boolean, boolean, uuid, text, text, bigint, date,
  timestamptz, bigint, boolean, text, public.holding_kind, public.sealed_product_type, public.sealed_intent
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

-- M8.1: the bulk-safe Remove from Portfolio surface.
grant execute on function public.remove_holdings_from_portfolio(uuid[]) to authenticated;

-- M9: the valuation resolver surface (FINANCIAL_MODEL.md §6, DECISIONS.md D-052).
grant execute on function public.clear_manual_valuation(uuid) to authenticated;
grant execute on function public.resolve_variant_market_values(uuid[]) to authenticated;
grant execute on function public.get_holding_value_provenance(uuid) to authenticated;
grant execute on function public.get_card_variant_price_history(uuid, date) to authenticated;

-- M9.1: get_market_movers gained p_sort (market_mover_sort).
grant execute on function public.get_market_movers(int, int, public.market_mover_sort) to authenticated;

-- M10: the signed largest-remainder wrapper and the sale-ledger write/void/summary surface
-- (20260828120010_m10_sales_rpc.sql).
grant execute on function public.allocate_largest_remainder_signed(bigint, bigint[]) to authenticated;
grant execute on function public.create_sale(
  date, text, jsonb, uuid, text, bigint, bigint, bigint, numeric, date, public.fx_source, text
) to authenticated;
grant execute on function public.update_sale(
  uuid, date, text, jsonb, text, bigint, bigint, bigint, numeric, date, public.fx_source, text
) to authenticated;
grant execute on function public.void_sale(uuid, text) to authenticated;
grant execute on function public.sales_summary() to authenticated;

-- ── 4. Tables: sweep, then grant back, with system-owned columns excluded ────────────────────

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

grant select on
  public.card_series,
  public.card_sets,
  public.cards,
  public.card_variants
  to authenticated;

-- catalog_sync_runs/watched_card_variants/price_sync_runs get no grant at all, to anon or
-- authenticated — service-role/infra-only, unchanged since M5/M9.

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
-- M11: sealed_intent joins the directly-writable column set (20260829120000) — it now lives here,
-- not on holdings. set_sealed_lot_intent (SECURITY INVOKER) needs this grant to write it; a client
-- could in principle PATCH it directly too, same trust model this table already applies to
-- quantity/unit_cost_basis_minor/etc. — correctness is enforced by acquisition_lots_check_owner's
-- scope check (sealed lot -> not null, everything else -> null), not by withholding the grant.
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
  residual_nok_minor,
  notes,
  voided_at,
  storage_location_id,
  sealed_intent
) on public.acquisition_lots to authenticated;

grant select, insert, delete on public.holdings to authenticated;
-- M11: sealed_intent no longer exists on this table (moved to acquisition_lots, 20260829120000) —
-- removed from the grant list accordingly.
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
-- written only by the fetch-fx-rate/ingest-fx Edge Functions under the service role.
grant select on public.fx_rates to authenticated;

-- M9: shared price-history market data, read-only for the browser, written only by ingest-prices
-- under the service role.
grant select on public.price_snapshots to authenticated;

-- M10: the sale ledger. SELECT only for authenticated — no INSERT/UPDATE/DELETE grant on any of
-- the three tables. create_sale/update_sale/void_sale are SECURITY DEFINER specifically so frozen
-- cost basis, allocated amounts and realized result (prompt §107) are unreachable by any direct
-- write, not merely policed after the fact (20260828120010_m10_sales_rpc.sql's header).
grant select on public.sales to authenticated;
grant select on public.sale_lines to authenticated;
grant select on public.lot_disposals to authenticated;

-- M10 prerequisite: the never-shipped lot_cost_adjustments table (20260828115000). SELECT only —
-- no controlled write RPC exists yet (M17 owns it); service_role can seed rows until then.
grant select on public.lot_cost_adjustments to authenticated;

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
-- function privileges — unchanged by M10/M11.
