-- M4.1: make the browser-reachable privilege surface converge, from any starting state.
--
-- 20260820120040 and 20260820120050 fixed the live escalation M4 found: a signed-in non-admin
-- could set `profiles.is_admin` on the deployed project, because the project auto-granted the Data
-- API roles broad privileges on every new table and `GRANT` adds rather than restricts. Those two
-- migrations are correct. This one closes what they left open, which is the harder half of the
-- question: *if a project starts with privileges we did not put there, do the migrations
-- deterministically end at the intended surface?*
--
-- Three gaps, in increasing order of how much they would have cost:
--
--   1. FUNCTIONS WERE ENUMERATED, NOT SWEPT. 20260820120040 revokes from a hand-written list of
--      sixteen functions. That converges the sixteen. It says nothing about a seventeenth that
--      arrived with a grant nobody wrote — which is exactly the shape of the bug being fixed.
--      Tables were already swept (`revoke all on all tables …`); functions were not. Now they are.
--
--   2. DEFAULT PRIVILEGES WERE NEVER NEUTRALIZED. `ALTER DEFAULT PRIVILEGES … GRANT … TO anon,
--      authenticated` is the other mechanism a Supabase project can carry for auto-exposing new
--      entities, and unlike the event trigger it is per-grantor state living in the database
--      rather than a project setting `supabase config push` can turn off. A sweep is a statement
--      about the objects that exist when it runs. Default privileges are a standing instruction
--      about every object created afterwards — including every table M5 is about to add. Revoking
--      them is the difference between fixing this bug and fixing this class of bug.
--
--   3. `UPDATE` WAS GRANTED WHOLE-TABLE ON EVERY USER-OWNED TABLE. `profiles` got a column list
--      because `is_admin` made the stakes obvious. Nothing else did, so a session could rewrite
--      `user_id`, `id`, `created_at` and the provenance columns of its own rows. RLS stops the
--      row moving to another user — `WITH CHECK (user_id = auth.uid())` is satisfied only by
--      yourself — so this is not the escalation `is_admin` was. It is the same *shape*: relying on
--      a policy for something a privilege should carry, on tables where the policy is the only
--      thing standing there. SECURITY.md §12 already says a restriction must be a revoke; §4 of
--      this file makes the system-owned columns explicit instead of implied.
--
-- WHAT THIS FILE IS NOT. It is not a rewrite of 20260820120050 — that migration is applied and
-- must not be edited. This is the next layer, written to be read as the complete intended surface
-- so that `tests/db/sql/assert_privilege_baseline.sql` can assert it as a whole, and CI can prove
-- convergence by granting hostile privileges first and running the hardening again
-- (`tests/db/sql/hostile_grants.sql`, wired into .github/workflows/ci.yml).
--
-- THE RULE, restated because it is the one thing a future migration must not forget: any migration
-- that creates a table, view or function in `public` ends with an explicit revoke-then-grant for
-- `anon` and `authenticated`, and updates the baseline assertion. A new object with no privilege
-- decision is a defect, not a default.

-- ── 1. Schema-level ──────────────────────────────────────────────────────────────────────────
--
-- USAGE is required: PostgREST resolves every request through it, so removing it would take the
-- API offline rather than secure it. CREATE is not, and a role that can create objects in a schema
-- can create ones nobody audited.

grant usage on schema public to anon, authenticated;
revoke create on schema public from anon, authenticated;

-- ── 2. Default privileges: stop future objects arriving pre-granted ──────────────────────────
--
-- Named `FOR ROLE postgres` rather than left implicit. Implicit means "the role running this
-- migration", which is postgres today for both `supabase db push` and `supabase db reset` — but
-- being explicit is free and this is precisely the kind of environment-dependent assumption that
-- produced the original bug.
--
-- `TYPES` is included for completeness. There are no user-defined domains or composite types with
-- meaningful privileges here today; the enums in this schema are usable by anyone regardless.

alter default privileges for role postgres in schema public
  revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke all on functions from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke all on types from anon, authenticated;

-- A hosted project may also carry default privileges granted by `supabase_admin`, which `postgres`
-- is not always a member of. Attempted, not assumed: if the grant cannot be reached from here it
-- is reported rather than silently skipped, and `scripts/grant-audit.sql` lists whatever remains
-- so the gap is visible instead of imagined.
-- One statement per iteration, each in its own exception scope: a block that wrapped all three
-- would roll the successful ones back along with the failure.
do $$
declare
  v_kind text;
begin
  foreach v_kind in array array['tables', 'sequences', 'functions'] loop
    begin
      execute format(
        'alter default privileges for role supabase_admin in schema public '
        || 'revoke all on %s from anon, authenticated',
        v_kind
      );
    exception
      when insufficient_privilege or undefined_object then
        raise notice
          'default privileges on % for supabase_admin were not reachable from this role (%). '
          'Run scripts/grant-audit.sql against the deployed project to confirm none remain.',
          v_kind, sqlerrm;
    end;
  end loop;
end;
$$;

-- ── 3. Functions: sweep, then grant back exactly four ────────────────────────────────────────
--
-- ROUTINES rather than FUNCTIONS: in PostgreSQL `ALL FUNCTIONS IN SCHEMA` does not cover
-- procedures, and "the object type we did not think of" is the failure mode this file exists to
-- remove. There are no procedures in this schema today. That is not a reason to write a sweep that
-- would miss one.
--
-- service_role, supabase_auth_admin and postgres are untouched: the revoke names anon and
-- authenticated and nothing else. `before_user_created` in particular keeps its grant to
-- supabase_auth_admin — revoking that would disable gate 1 of the invite-only model.

revoke execute on all routines in schema public from anon, authenticated;

-- The complete set of functions a browser may call, and why each one is on the list. Anything not
-- named here is unreachable from any session, which currently means the eleven server-only and
-- trigger functions.
grant execute on function public.invitation_status(text) to anon, authenticated;
grant execute on function public.is_admin() to authenticated;
grant execute on function public.create_invitation(text, int, text) to authenticated;
grant execute on function public.revoke_invitation(uuid) to authenticated;

-- Evaluated as part of the holdings_identity index expression on every write to holdings, so
-- `authenticated` needs EXECUTE for ordinary inserts to work at all. Not an API surface: they are
-- pure casts over an enum.
grant execute on function public.card_condition_to_text(public.card_condition) to authenticated;
grant execute on function public.grader_to_text(public.grader) to authenticated;

-- ── 4. Tables: sweep, then grant back, with system-owned columns excluded ────────────────────
--
-- `REVOKE ALL ON <table>` also drops that role's column privileges on the table
-- (PostgreSQL REVOKE, Description), so this genuinely starts from nothing rather than layering
-- over whatever was there. `ALL TABLES IN SCHEMA` covers views and foreign tables as well as
-- tables — it does not cover materialized views, and this schema has none. If M5 adds one, it
-- needs its own line here.

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

-- Shared catalog: readable by any session, written by nobody. Ingest is a service-role concern
-- and deliberately has no client grant of any kind (SECURITY.md §3.1).
grant select on
  public.card_series,
  public.card_sets,
  public.cards,
  public.card_variants
  to authenticated;

-- ── The system-owned columns, and why each is system-owned ───────────────────────────────────
--
-- Excluded from every UPDATE grant below:
--
--   id           A primary key is an identity, not a field. Nothing in the product re-keys a row.
--   user_id      Ownership. RLS already refuses to let it point at another user; taking it out of
--                the grant means that refusal no longer has to be the only one.
--   created_at   Provenance. A row that can rewrite when it was created cannot be audited.
--   updated_at   Maintained by the set_updated_at trigger, which overwrites any client value —
--                so granting it would be granting something that does not work.
--
-- Plus, per table: the parent foreign key on child rows (re-parenting a purchase line or an
-- acquisition lot silently corrupts allocation, and the product has no operation that does it),
-- `purchases.origin` and `acquisition_lots.origin` (what created a record, fixed at creation —
-- a manual purchase does not later become a provisional one, D-021), and
-- `sealed_products.created_by_user_id` (NULL means "curated catalog row"; a user able to write it
-- could push a private row into the shared catalog, and today only the RLS WITH CHECK stops that).
--
-- INSERT stays whole-table. On insert `user_id` must be writable — RLS is what constrains it to
-- the caller, and that is the correct mechanism for a value the client legitimately supplies.
-- Narrowing insert would buy only `created_at`, at the cost of a column list that has to be
-- maintained for a property no attack depends on.

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

-- Financial ledger: no client DELETE anywhere. Records are voided, never removed (D-021,
-- FINANCIAL_MODEL §7) — `voided_at` is therefore a legitimate user-writable column and stays in
-- the grant.
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

-- holdings keeps DELETE: an empty holding created by mistake is not a financial record, and one
-- that has lots cannot be deleted anyway (the FK from acquisition_lots is NO ACTION).
-- `deleted_at` is a user action — soft delete — and stays writable.
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

-- profiles: unchanged from 20260820120050, restated so this file is the whole surface rather than
-- a diff against it. id, is_admin, created_at, disabled_at and updated_at are absent on purpose.
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

-- Invitations: read-only, never the token hash, and writes only through the RPCs.
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

-- public.invitation_claims is deliberately absent, as it has been since it was created: no grant,
-- to any browser-reachable role, ever.

-- ── 5. anon holds nothing but one function ───────────────────────────────────────────────────
--
-- Stated as an assertion rather than an omission. The sweep above is the whole of anon's table
-- privileges; `invitation_status` is the whole of its function privileges, because the invited
-- person has no account yet and the 256-bit token in their link is the credential.
