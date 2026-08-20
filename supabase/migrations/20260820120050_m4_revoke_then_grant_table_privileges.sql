-- M4 follow-up 2: restate every table privilege as REVOKE ALL, then GRANT exactly what is
-- intended. Companion to 20260820120040, which did the same for functions.
--
-- WHY THIS EXISTS, AND WHY IT IS THE MOST IMPORTANT MIGRATION IN M4.
--
-- Running the security checks against the real dev project instead of against CI turned up a
-- privilege escalation that CI could not see: a signed-in, non-admin user could
-- `PATCH /rest/v1/profiles?id=eq.<their own id>` with `{"is_admin": true}` and PostgREST accepted
-- it. That is the one escalation SECURITY.md §4 and the authorization suite are most concerned
-- with, and the suite was green.
--
-- The cause is the same as 20260820120040's. A Supabase project can carry an event trigger that
-- grants the Data API roles broad privileges on every new public-schema table — the legacy
-- `auto_expose_new_tables` behaviour, off in the local stack CI uses and on in this project. So on
-- the remote, `authenticated` already held full `UPDATE` on `public.profiles` before M3's
-- carefully column-restricted grant ran.
--
-- And a GRANT is additive. M3 wrote:
--
--     grant update (display_name, locale, …) on public.profiles to authenticated;
--
-- intending it to mean "these columns and no others". It does not mean that. It adds those
-- columns to whatever the role already has. Where the role already had everything, it added
-- nothing and restricted nothing. The comment in that migration — "at the SQL privilege level, not
-- just by RLS, so it holds even if a future policy mistake widens the USING/WITH CHECK clause" —
-- was true of the intent and false of the deployment.
--
-- RLS did not save this. `profiles_update_own` has `USING (id = auth.uid())` and a matching
-- `WITH CHECK`, and the row being updated *is* the caller's own — the policy is satisfied. The
-- column grant was the only thing standing between a user and the admin flag, and on the remote it
-- was not standing.
--
-- THE RULE, which the security checklist now carries: never express a privilege restriction as a
-- narrow GRANT. Revoke everything from the role first, then grant back. A GRANT describes what to
-- add, never what to limit.
--
-- Written as revoke-then-grant for every table rather than only for `profiles`, because the
-- defect is not specific to `profiles` — it is specific to the assumption that a narrow grant
-- restricts. Anywhere that assumption was made, it was wrong.

-- ── Start from nothing ───────────────────────────────────────────────────────────────────────
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

-- ── Shared catalog and market data: readable by any session, written by nobody ───────────────
-- (SECURITY.md §3.1. Writes are a service-role/ingest concern and have no client grant at all.)
grant select on
  public.card_series,
  public.card_sets,
  public.cards,
  public.card_variants
  to authenticated;

-- sealed_products is the exception: users may add their own, so it keeps full CRUD, gated by RLS
-- to rows they created.
grant select, insert, update, delete on public.sealed_products to authenticated;

-- ── User-scoped reference data ───────────────────────────────────────────────────────────────
grant select, insert, update, delete on
  public.retailers,
  public.storage_locations,
  public.tags
  to authenticated;

-- ── Financial ledger: void semantics, never a raw client DELETE ──────────────────────────────
grant select, insert, update on public.purchases, public.purchase_lines to authenticated;
grant select, insert, update on public.acquisition_lots to authenticated;

-- holdings may be deleted: an empty, mistaken holding is not a financial record, and the FK from
-- acquisition_lots is NO ACTION, so one that has lots cannot be deleted anyway.
grant select, insert, update, delete on public.holdings to authenticated;

-- ── profiles: the column list is now genuinely a restriction ─────────────────────────────────
-- id, is_admin, created_at, disabled_at and updated_at are absent on purpose. This is what M3
-- intended and what only now holds on a project where the role started with more.
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

-- ── Invitations: read-only, and never the token hash ─────────────────────────────────────────
-- Rows are still gated to admins by RLS; this decides which columns exist to be read at all.
-- Writes go through create_invitation / revoke_invitation, which are the only place a token is
-- generated and the only place its hash is stored.
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

-- public.invitation_claims is deliberately absent: no grant, to any browser-reachable role, ever.

-- ── anon holds nothing at all ────────────────────────────────────────────────────────────────
-- The only thing an anonymous caller may do is ask whether an invitation token is valid, and that
-- is a function grant (20260820120040), not a table one. Stated here as an assertion rather than
-- an omission: the revoke above is the whole of anon's table privileges.

-- ── service_role is unaffected ───────────────────────────────────────────────────────────────
-- The revoke above names anon and authenticated only. service_role keeps the explicit grants each
-- M3 migration gave it; it is trusted server-side infrastructure, and SECURITY.md §4 already
-- discloses that operating the deployment implies database access.
