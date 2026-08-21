-- M6 restates the complete privilege baseline, the same way 20260820157000_m5_privilege_baseline
-- restated M4.1's, and for the identical reason (see that file's header): the hostile-grant
-- convergence check re-applies "the baseline migration" and a sweep-then-grant statement
-- (`revoke execute on all routines in schema public from anon, authenticated`) revokes every
-- function's grant including ones that did not exist when the previous baseline was written.
-- Re-running only M5's file would converge to a surface missing every M6 grant.
--
-- CI's convergence step no longer hardcodes this filename either (M6 prompt §14 / SECURITY.md
-- §5.9's own flagged fragility) — it now selects the lexicographically-latest
-- `*_privilege_baseline.sql` migration and fails outright if none is found, so a future milestone
-- that adds this file's M7 successor does not also require an out-of-band CI edit to stay correct.
-- See .github/workflows/ci.yml's "Convergence from a hostile privilege state" step.
--
-- THE RULE THIS RESTATES, again: any migration that creates a table, view or function in `public`
-- ends with an explicit revoke-then-grant, updates `scripts/grant-audit.sql`, and — if it adds
-- anything browser-reachable — makes this file stale, needing the same restatement M6 just did.

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

-- supabase_admin's default privileges are deliberately left alone here too — see
-- 20260820140000_m41_privilege_baseline.sql §2 for the full reasoning, unchanged by M6.

-- ── 3. Functions: sweep, then grant back exactly the current reachable set ───────────────────

revoke execute on all routines in schema public from anon, authenticated;

grant execute on function public.invitation_status(text) to anon, authenticated;
grant execute on function public.is_admin() to authenticated;
grant execute on function public.create_invitation(text, int, text) to authenticated;
grant execute on function public.revoke_invitation(uuid) to authenticated;
grant execute on function public.card_condition_to_text(public.card_condition) to authenticated;
grant execute on function public.grader_to_text(public.grader) to authenticated;
grant execute on function public.search_cards(text, text, int, int) to authenticated;

-- M6: the atomic collection-writing surface.
grant execute on function public.add_card_acquisition(
  uuid, uuid, public.grading_state, public.card_condition, public.grader, numeric,
  text, boolean, text, public.lot_origin, public.cost_basis_state, bigint, int, date, uuid, text, bigint
) to authenticated;
grant execute on function public.set_manual_valuation(uuid, bigint, text, date) to authenticated;
grant execute on function public.void_acquisition_lot(uuid, text) to authenticated;

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

-- acquisition_lots: storage_location_id joins the client-writable column list (relocated here from
-- holdings this milestone — 20260821120020_m6_holdings_and_lots_extensions.sql).
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

-- holdings: manual_card_id joins the list; storage_location_id leaves it (moved to
-- acquisition_lots above).
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

-- M6: manual card fallback (user-private, never the shared catalog — DATA_MODEL.md §5.4's note).
grant select, insert, delete on public.manual_card_definitions to authenticated;
grant update (
  name, set_name, collector_number, language, finish, stamp, subtype, size, notes
) on public.manual_card_definitions to authenticated;

-- M6: holding tags (many-to-many). No UPDATE — a membership row is inserted or deleted, not edited.
grant select, insert, delete on public.holding_tags to authenticated;

-- M6: manual valuations. Append-only from the client; superseded_at is the one field a client ever
-- writes after insert (via set_manual_valuation, invoker rights).
grant select, insert on public.manual_valuations to authenticated;
grant update (superseded_at) on public.manual_valuations to authenticated;

-- M6: the Collection list's one-query view (20260821120060). Read-only by construction — a view
-- over an aggregate has no meaningful INSERT/UPDATE/DELETE target.
grant select on public.holding_summaries to authenticated;

grant select on public.profiles to authenticated;
grant update (
  display_name,
  locale,
  display_currency,
  theme,
  collection_grid_density,
  collection_default_view,
  low_value_threshold_minor,
  hide_low_value_by_default,
  default_condition,
  default_language,
  default_storage_location_id
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
-- function privileges — unchanged by M6.
