-- M5 restates the complete privilege baseline, the same way 20260820140000_m41_privilege_baseline
-- restated M4's. Found necessary by CI, not by inspection: the hostile-grant convergence test
-- (.github/workflows/ci.yml, tests/db/sql/hostile_grants.sql) proves convergence by granting
-- privileges nothing asked for, then re-applying "the baseline migration" and asserting the audit
-- passes afterward. That re-applied file is a fixed name, and a sweep-then-grant statement
-- (`revoke execute on all routines in schema public from anon, authenticated`, in the M4.1 file)
-- revokes every function's grant, including ones that did not exist when M4.1 was written —
-- `search_cards` among them. Re-running only the M4.1 file therefore converges to a *stale*
-- surface, missing every grant a later milestone added.
--
-- The fix is this file: a new pure-privilege migration, containing nothing but the sweep and the
-- complete *current* grant list (M4.1's plus M5's), just as M4.1 did relative to M4's narrower
-- grants. CI is updated in the same commit to re-apply this file instead of M4.1's for the
-- convergence check. M4.1's file is untouched and still runs during ordinary migration
-- sequencing — this file is additive, not a correction of it.
--
-- THE RULE THIS RESTATES, again, because it is the one a future milestone must not forget: any
-- migration that creates a table, view or function in `public` ends with an explicit
-- revoke-then-grant, updates `scripts/grant-audit.sql`, **and** — if it adds anything
-- browser-reachable — this file becomes stale and needs the same restatement M5 just did. A
-- lighter alternative (teach the hostile-grant test to replay every privilege-bearing migration in
-- order) was considered and rejected: replaying migrations that also `CREATE TABLE` is not
-- idempotent, so "just re-run everything since M4.1" is not actually available as a shortcut.

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
-- 20260820140000_m41_privilege_baseline.sql §2 for the full reasoning, unchanged by M5.

-- ── 3. Functions: sweep, then grant back exactly the current reachable set ───────────────────

revoke execute on all routines in schema public from anon, authenticated;

grant execute on function public.invitation_status(text) to anon, authenticated;
grant execute on function public.is_admin() to authenticated;
grant execute on function public.create_invitation(text, int, text) to authenticated;
grant execute on function public.revoke_invitation(uuid) to authenticated;
grant execute on function public.card_condition_to_text(public.card_condition) to authenticated;
grant execute on function public.grader_to_text(public.grader) to authenticated;

-- M5: search_cards is the one addition to the browser-reachable function surface.
grant execute on function public.search_cards(text, text, int, int) to authenticated;

-- ── 4. Tables: sweep, then grant back, with system-owned columns excluded ────────────────────

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

grant select on
  public.card_series,
  public.card_sets,
  public.cards,
  public.card_variants
  to authenticated;

-- catalog_sync_runs (M5) gets no grant at all, to anon or authenticated — stated explicitly so
-- this file remains the complete surface rather than an omission. Service-role-only, same shape
-- as invitation_claims.

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
  voided_at
) on public.acquisition_lots to authenticated;

grant select, insert, delete on public.holdings to authenticated;
grant update (
  holding_kind,
  card_variant_id,
  sealed_product_id,
  condition,
  grading_state,
  grader,
  grade,
  cert_number,
  sealed_intent,
  storage_location_id,
  is_favorite,
  notes,
  deleted_at
) on public.holdings to authenticated;

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
-- function privileges — unchanged by M5.
