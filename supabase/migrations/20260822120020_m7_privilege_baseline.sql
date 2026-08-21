-- M7 restates the complete privilege baseline, the same way 20260821120100_m6_privilege_baseline
-- restated M5's, and for the identical reason (see that file's header): the hostile-grant
-- convergence check re-applies "the baseline migration" and a sweep-then-grant statement revokes
-- every function's grant including ones that did not exist when the previous baseline was written.
-- CI selects the lexicographically-latest `*_privilege_baseline.sql` automatically
-- (.github/workflows/ci.yml), so this file becoming the newest one is what makes it "the" baseline
-- from here — no CI edit needed.
--
-- NEW IN M7 — closing the PUBLIC-EXECUTE blind spot (M7 prompt §69-71, SECURITY.md §5.9's own
-- "M4 already revokes from public at creation" note generalized into something CI actually
-- checks). PostgreSQL grants EXECUTE on a newly created function to PUBLIC by default — a
-- separate ACL entry from anything granted or revoked from a *named* role. `grant-audit.sql`
-- through M6 only ever compared `anon`/`authenticated` grants against an expected list; a
-- function created without the M4/M6 convention of an explicit `revoke ... from public` at
-- creation time could carry a live PUBLIC grant that audit could not see. Section 6 below sweeps
-- every routine in `public` clear of PUBLIC's implicit grant, a new default-privilege statement
-- stops it recurring on a future function that forgets the explicit revoke, and
-- `scripts/grant-audit.sql` gains its own PUBLIC-grant check in the same commit — three
-- independent statements of "empty", exactly the shape SECURITY.md §5.9 already uses for the
-- named-role surface.

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

-- M7: a future function that omits the "revoke ... from public" step at creation no longer
-- arrives PUBLIC-executable either — this is PostgreSQL's own documented mechanism for turning
-- off the implicit PUBLIC EXECUTE grant functions otherwise receive at CREATE FUNCTION time.
alter default privileges for role postgres in schema public
  revoke execute on functions from public;

-- supabase_admin's default privileges are deliberately left alone here too — see
-- 20260820140000_m41_privilege_baseline.sql §2 for the full reasoning, unchanged by M7.

-- ── 3. Functions: sweep PUBLIC, then anon/authenticated, then grant back exactly the current set ─

-- M7: the PUBLIC sweep. Revoking from PUBLIC never touches a grant already held by a named role
-- (service_role, supabase_auth_admin) — those are separate ACL entries, untouched below.
revoke execute on all routines in schema public from public;

revoke execute on all routines in schema public from anon, authenticated;

grant execute on function public.invitation_status(text) to anon, authenticated;
grant execute on function public.is_admin() to authenticated;
grant execute on function public.create_invitation(text, int, text) to authenticated;
grant execute on function public.revoke_invitation(uuid) to authenticated;
grant execute on function public.card_condition_to_text(public.card_condition) to authenticated;
grant execute on function public.grader_to_text(public.grader) to authenticated;
-- service_role needs an explicit grant here too, newly so as of this migration: search_cards was
-- never revoked from PUBLIC before M7 (it predates the convention this migration now applies
-- project-wide), so tests/db/search_cards.test.ts's service-role client had been silently riding
-- PostgreSQL's implicit PUBLIC-EXECUTE default the whole time — exactly the blind spot D-042
-- closes. Closing it for real removes that free ride, so the grant it was standing in for needs
-- to become an explicit, deliberate one instead (same "service_role needs explicit grants too"
-- rule already applied to every table). search_cards is read-only and STABLE; no privilege is
-- being widened, only stated.
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
grant execute on function public.list_portfolio(
  public.portfolio_sort_order, int, text, uuid, public.card_condition, boolean, public.grader,
  boolean, text, boolean, uuid, uuid, uuid, boolean, boolean, uuid, text, text, bigint, date,
  timestamptz, bigint, boolean
) to authenticated;

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
-- function privileges — unchanged by M7.
