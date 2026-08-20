-- Invitations (DATA_MODEL.md §7, SECURITY.md §5). Schema only in M3 — this is the server-side
-- foundation for invite-only signup, prepared ahead of the M4 auth milestone.
--
-- KNOWN BOUNDARY (documented per prompt instruction to mark it explicitly rather than fake it):
-- the `auth.users` backstop trigger that rejects any signup lacking a redemption (invariant S2)
-- is NOT implemented in this migration. It ships in M4 together with the redeem-invitation Edge
-- Function it depends on. Enabling the backstop now, before that Edge Function exists, would
-- also reject the service-role-created synthetic users the M3 authorization test fixture needs
-- (tests/authorization/) unless they too were given fake redemption rows — adding complexity to
-- a mechanism that cannot be end-to-end tested until M4 anyway. `[auth] enable_signup = false`
-- is NOT a substitute in the meantime: confirmed empirically in CI, disabling it also disables
-- the email/password *login* grant type for every existing user, not just new self-registration
-- (a known GoTrue behaviour), which would break sign-in for legitimate redemption-created users
-- too. So it stays at the platform default, and nothing closes the public signup endpoint until
-- the S2 trigger ships in M4 — see DATA_MODEL.md §12.

create table public.invitations (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  created_by uuid not null references auth.users (id),
  label text,
  expires_at timestamptz not null,
  max_uses int not null default 1,
  use_count int not null default 0,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  constraint invitations_max_uses_positive check (max_uses > 0),
  constraint invitations_use_count_nonnegative check (use_count >= 0),
  constraint invitations_use_count_within_max check (use_count <= max_uses)
);

create index invitations_created_by_idx on public.invitations (created_by);

create table public.invitation_redemptions (
  id uuid primary key default gen_random_uuid(),
  invitation_id uuid not null references public.invitations (id),
  user_id uuid not null references auth.users (id) unique,
  redeemed_at timestamptz not null default now()
);

create index invitation_redemptions_invitation_id_idx on public.invitation_redemptions (invitation_id);

alter table public.invitations enable row level security;
alter table public.invitation_redemptions enable row level security;

-- System table, admin-managed. This is one of the few places `is_admin()` legitimately gates a
-- policy — invitations are not a user's private collection/spending data (the case SECURITY.md
-- §4 explicitly forbids `is_admin()` from touching); they are the admin's own management surface.
create policy invitations_admin_all on public.invitations
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy invitation_redemptions_admin_read on public.invitation_redemptions
  for select to authenticated
  using (public.is_admin());

grant select, insert, update, delete on public.invitations to authenticated;
grant select on public.invitation_redemptions to authenticated;

-- No INSERT policy on invitation_redemptions for `authenticated`: redemption rows are written
-- only by the M4 redeem-invitation Edge Function, using the service role, which bypasses RLS.

-- service_role needs explicit grants too — see the note in 20260817120020_create_catalog_tables.sql.
grant all on public.invitations, public.invitation_redemptions to service_role;
