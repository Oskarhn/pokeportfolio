-- M4, part 2 of 4: the invitation schema the invite-only flow needs.
--
-- What changes from M3's schema-only version (SECURITY.md §5, DATA_MODEL.md §7):
--
--   * invitations gains `email` — an invitation authorizes the creation of exactly one account,
--     for exactly one address. Knowing the address is not authorization; possessing the token is
--     (SECURITY.md §5). Binding the two means a stolen token cannot be redirected to an attacker's
--     own address, and a known address cannot be signed up for without the token.
--   * invitations.created_by becomes nullable — `null` means "issued out-of-band through
--     privileged database access", which is how the first administrator of an environment is
--     bootstrapped (DEVELOPMENT.md §7). There is no chicken-and-egg backdoor in the application.
--   * `invitation_claims` is new: the short-lived, server-only authorization record that makes
--     the auth.users backstop (invariant S2, part 4 of this series) possible without trusting
--     anything a client can send.
--   * `authenticated` loses blanket SELECT on invitations so `token_hash` can never be read
--     through the Data API, even by an admin.

-- gen_random_bytes() for invitation tokens. gen_random_uuid() is core, but a UUID is 122 bits of
-- entropy in a recognisable shape; an invitation token is 256 bits of opaque randomness.
create extension if not exists pgcrypto with schema extensions;

-- M3's invitations table was explicitly non-functional: no redemption path existed, so no
-- invitation in any environment can have meant anything. Clearing it lets `email` be added NOT
-- NULL directly instead of via a placeholder value that would then be a lie in the audit trail.
delete from public.invitation_redemptions;
delete from public.invitations;

alter table public.invitations
  add column email text not null,
  alter column created_by drop not null;

-- Stored normalized. GoTrue lowercases the email on every user-creation path
-- (supabase/auth internal/models/user.go: `strings.ToLower(email)`), so normalizing the same way
-- here is matching Auth's behaviour rather than inventing a competing rule — the backstop trigger
-- in part 4 compares against auth.users.email and the two must agree exactly.
alter table public.invitations
  add constraint invitations_email_normalized check (email = lower(btrim(email))),
  add constraint invitations_email_shape check (
    email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
  );

comment on column public.invitations.email is
  'The single address this invitation authorizes an account for. Normalized to lower(btrim(...)) to match GoTrue.';
comment on column public.invitations.created_by is
  'The admin who issued the invitation, or NULL for a bootstrap invitation issued through privileged database access (DEVELOPMENT.md §7).';
comment on column public.invitations.use_count is
  'Successful redemptions. Incremented only by finalize_invitation_redemption. Availability is computed from invitation_claims, not from this column.';

-- ── invitation_claims ────────────────────────────────────────────────────────────────────────
--
-- A claim is a two-minute authorization to create one auth.users row for one address. The
-- redeem-invitation Edge Function creates it under the service role after validating the token;
-- the auth.users BEFORE INSERT trigger consumes it. Nothing else can create or read one — the
-- table has RLS enabled and no policies at all, and no grants to anon or authenticated.
--
-- Why a separate table rather than a flag on invitations, or metadata on the signup request:
--   * Metadata on a signup request is attacker-controlled by definition (a public client can send
--     any user_metadata it likes), so it can never be the authorization.
--   * A flag on invitations would have to survive the window between "token validated" and "user
--     row inserted", which spans two transactions. A row with its own expiry makes the failure
--     mode deterministic: an abandoned attempt frees itself in two minutes with no cleanup job
--     and no way to leave an invitation permanently burnt (prompt §18).
create table public.invitation_claims (
  id uuid primary key default gen_random_uuid(),
  invitation_id uuid not null references public.invitations (id) on delete cascade,
  email text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  -- DEFERRABLE INITIALLY DEFERRED is required, not stylistic: the backstop trigger sets this
  -- column from a BEFORE INSERT trigger on auth.users, so the referenced row does not exist yet
  -- at the moment of the UPDATE. Deferring the check to commit makes that correct by
  -- construction rather than by relying on when a nested statement's after-triggers happen to
  -- fire.
  consumed_user_id uuid references auth.users (id) on delete cascade
    deferrable initially deferred,
  constraint invitation_claims_email_normalized check (email = lower(btrim(email))),
  constraint invitation_claims_consumed_shape check (
    (consumed_at is null and consumed_user_id is null)
    or (consumed_at is not null and consumed_user_id is not null)
  )
);

-- At most one live claim per address. Two concurrent redemptions of the same invitation cannot
-- both hold a claim, which is one of the two locks that make double redemption impossible (the
-- other is the FOR UPDATE on the invitation row in claim_invitation).
create unique index invitation_claims_one_live_per_email
  on public.invitation_claims (email) where consumed_at is null;

create index invitation_claims_invitation_idx on public.invitation_claims (invitation_id);

alter table public.invitation_claims enable row level security;

-- Deliberately no policies and no anon/authenticated grants: unreachable through the Data API
-- under every role the browser can hold. Only the service role, and the SECURITY DEFINER
-- functions in part 3, touch this table.
grant all on public.invitation_claims to service_role;

comment on table public.invitation_claims is
  'Short-lived server-side authorization to create one auth.users row. Consumed by the S2 backstop trigger. Never reachable from a browser.';

-- ── invitations: no token_hash through the Data API ──────────────────────────────────────────
--
-- The admin RLS policy from M3 restricts which *rows* an admin sees; it says nothing about
-- columns. A column-level grant does, and it holds at the SQL privilege level regardless of any
-- future policy mistake — the same reasoning as profiles.is_admin in M3.
revoke select on public.invitations from authenticated;
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

-- Direct INSERT/UPDATE/DELETE are withdrawn too. Invitations are created and revoked through the
-- RPCs in part 3, which are the only place a token is generated, and which keep the raw token out
-- of the database. A hand-rolled client INSERT could store an attacker-chosen token_hash.
revoke insert, update, delete on public.invitations from authenticated;

-- The admin management surface. `security_invoker` means the invitations RLS policy still
-- decides who sees rows — the view widens no access, it only hides token_hash structurally and
-- derives the status the admin UI shows.
create view public.invitation_overview
with (security_invoker = on) as
select
  i.id,
  i.email,
  i.label,
  i.created_by,
  i.created_at,
  i.expires_at,
  i.revoked_at,
  i.max_uses,
  i.use_count,
  case
    when i.revoked_at is not null then 'revoked'
    when i.use_count >= i.max_uses then 'redeemed'
    when i.expires_at <= now() then 'expired'
    else 'active'
  end as status
from public.invitations i;

grant select on public.invitation_overview to authenticated;

comment on view public.invitation_overview is
  'Admin invitation list. security_invoker, so the invitations admin-only RLS policy applies. Never exposes token_hash.';
