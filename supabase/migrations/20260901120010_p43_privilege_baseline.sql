-- P43 restates the complete privilege baseline (SECURITY.md §5.9). This milestone adds no tables
-- and exactly two browser-reachable functions: reset_my_portfolio_data(), the atomic
-- owner-scoped full reset (SECURITY DEFINER — see 20260901120000's header for why), and
-- list_history_events(text, boolean, int, timestamptz, uuid), the unified History read surface.
-- Everything else below is identical to `20260831120010_p28_privilege_baseline.sql`; only the
-- P43 additions are noted inline.
-- CI selects the lexicographically-latest `*_privilege_baseline.sql` automatically.

-- ── 1. Schema-level ──────────────────────────────────────────────────────────────────────────

grant usage on schema public to anon, authenticated;
revoke create on schema public from anon, authenticated;

-- ── 2. Default privileges: stop future objects arriving pre-granted ─────────────────────────

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

-- M6/M11: the atomic collection-writing surface, sealed intent included.
grant execute on function public.add_card_acquisition(
  uuid, uuid, public.grading_state, public.card_condition, public.grader, numeric,
  text, boolean, text, public.lot_origin, public.cost_basis_state, bigint, int, date, uuid, text,
  bigint, uuid, public.sealed_intent
) to authenticated;
grant execute on function public.set_manual_valuation(uuid, bigint, text, date) to authenticated;
grant execute on function public.void_acquisition_lot(uuid, text) to authenticated;
grant execute on function public.set_sealed_lot_intent(uuid, public.sealed_intent, int) to authenticated;

-- M7/M9/M11: Portfolio counts and browsing.
grant execute on function public.portfolio_counts(uuid) to authenticated;
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

-- P28: the Holding Detail quantity-correction surface (20260831120000).
grant execute on function public.reduce_holding_quantity(uuid, jsonb) to authenticated;

-- P43: the atomic full reset (SECURITY DEFINER; every statement filters by auth.uid() —
-- 20260901120000's header carries the full adversarial justification) and the unified History
-- read surface (SECURITY INVOKER, owner-only by construction).
grant execute on function public.reset_my_portfolio_data() to authenticated;
grant execute on function public.list_history_events(text, boolean, int, timestamptz, uuid)
  to authenticated;

-- M9/M9.1: the valuation resolver surface.
grant execute on function public.clear_manual_valuation(uuid) to authenticated;
grant execute on function public.resolve_variant_market_values(uuid[]) to authenticated;
grant execute on function public.get_holding_value_provenance(uuid) to authenticated;
grant execute on function public.get_card_variant_price_history(uuid, date) to authenticated;
grant execute on function public.get_market_movers(int, int, public.market_mover_sort) to authenticated;

-- M10: the signed largest-remainder wrapper and the sale-ledger write/void/summary surface.
grant execute on function public.allocate_largest_remainder_signed(bigint, bigint[]) to authenticated;
grant execute on function public.create_sale(
  date, text, jsonb, uuid, text, bigint, bigint, bigint, numeric, date, public.fx_source, text
) to authenticated;
grant execute on function public.update_sale(
  uuid, date, text, jsonb, text, bigint, bigint, bigint, numeric, date, public.fx_source, text
) to authenticated;
grant execute on function public.void_sale(uuid, text) to authenticated;
grant execute on function public.sales_summary() to authenticated;

-- M12: the dashboard read surface (20260830120030_m12_dashboard_reads.sql). Granted to
-- service_role as well: CI proved the suites exercise these reads under the service key, and
-- search_cards already established that precedent for shared infra callers. Browser surface is
-- the authenticated column only.
grant execute on function public.get_dashboard_summary() to authenticated, service_role;
grant execute on function public.get_portfolio_history(text, date, date) to authenticated, service_role;
grant execute on function public.get_monthly_spend(int) to authenticated, service_role;
grant execute on function public.get_recent_activity(int) to authenticated, service_role;

-- M12: get_dashboard_summary resolves its honest pending_recompute flag through this DEFINER
-- helper (the queue itself stays unreadable). PostgreSQL checks EXECUTE on functions referenced
-- from another function's SQL body — unlike implicit trigger firing — so authenticated MUST hold
-- it. Exposing it directly is harmless BY CONSTRUCTION: it answers exactly one boolean about
-- exactly auth.uid()'s own queue row and cannot be aimed at another user.
grant execute on function public.m12_recompute_pending_for_self() to authenticated;

-- M12 service/internal-only functions get NO browser grant beyond exactly what is stated above:
--   rebuild_portfolio_snapshots(uuid, date, date)      → service_role only
--   drain_portfolio_recompute_queue(int)               → service_role only
--   enqueue_portfolio_daily_maintenance()              → service_role only
--   enqueue_portfolio_recompute(uuid, date)            → nobody but the owner (trigger-called)
--   m12_recompute_pending_for_self()                   → authenticated ONLY (granted above —
--                                                        get_dashboard_summary calls it as a
--                                                        nested function call, which requires
--                                                        EXECUTE; safe by construction: no
--                                                        user-id parameter, hardcoded auth.uid(),
--                                                        answers one boolean about the caller's
--                                                        own queue row)
--   m12_*_dirties_history / m12_price_snapshot_enq_* / m12_fx_rate_enq_* → nobody (triggers)

-- ── 4. Tables: sweep, then grant back, with system-owned columns excluded ────────────────────

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

-- Service role holds full data-plane access, explicitly. Every table in this schema is created
-- by a migration running as postgres, and CI proved (M12, first db-tests run) that the stack's
-- implicit service_role coverage does NOT reliably reach migration-created tables — the
-- snapshot-cache suites failed with plain "permission denied" on SELECT under the service key
-- while every pre-existing table worked. service_role is trusted infrastructure (it already
-- bypasses RLS); stating its grant here makes the engine's access independent of whatever
-- platform default privileges happen to exist. The browser-reachable surface above is unchanged:
-- this grant names service_role only, and the audit checks anon/authenticated exclusively.
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;

grant select on
  public.card_series,
  public.card_sets,
  public.cards,
  public.card_variants
  to authenticated;

-- catalog_sync_runs/watched_card_variants/price_sync_runs get no grant at all, to anon or
-- authenticated — service-role/infra-only, unchanged since M5/M9. M12 adds
-- portfolio_recompute_queue and portfolio_recompute_runs to this same no-grant class.

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
  residual_nok_minor,
  notes,
  voided_at,
  storage_location_id,
  sealed_intent
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

grant select, insert, delete on public.custom_collections to authenticated;
grant update (name, description, sort_order, color) on public.custom_collections to authenticated;

grant select, insert, delete on public.custom_collection_members to authenticated;

grant select on public.fx_rates to authenticated;
grant select on public.price_snapshots to authenticated;

grant select on public.sales to authenticated;
grant select on public.sale_lines to authenticated;
grant select on public.lot_disposals to authenticated;

grant select on public.lot_cost_adjustments to authenticated;

-- M12: the snapshot cache is owner-readable ONLY (RLS policy portfolio_snapshots_select_own);
-- no INSERT/UPDATE/DELETE grant exists for any browser role — the recompute engine is the sole
-- writer (prompt §92).
grant select on public.portfolio_snapshots to authenticated;

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
-- public.portfolio_recompute_queue / portfolio_recompute_runs: same — no grant, ever (prompt §93).

-- ── 5. anon holds nothing but one function ───────────────────────────────────────────────────

-- The sweep above is the whole of anon's table privileges; invitation_status is the whole of its
-- function privileges — unchanged by M11/M12/P28.
