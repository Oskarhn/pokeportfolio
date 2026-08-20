-- M4, part 4 of 4: the invite-only gate. Two independent server-side controls, both of which
-- must pass before an account can exist.
--
-- The property being enforced (SECURITY.md §5):
--
--   No auth.users row can come into existence except as the result of redeeming an invitation
--   token that the redeeming party actually possesses.
--
-- It has to hold against someone who knows the project URL, holds the publishable key, knows an
-- invited person's address, ignores our frontend entirely, and calls /auth/v1/signup directly
-- with any body they like.
--
-- ── Why two mechanisms, and why these two ────────────────────────────────────────────────────
--
-- GATE 1 — the Before User Created auth hook. Verified against supabase/auth at master: every
-- public account-creation path in GoTrue calls triggerBeforeUserCreated — signup.go,
-- anonymous.go, mail.go, external.go (OAuth), web3.go, samlacs.go, token_oidc.go, invite.go.
-- internal/api/admin.go, which serves the Auth Admin API that `auth.admin.createUser` reaches,
-- contains no hook invocation at all. That asymmetry is exactly the shape this application needs,
-- so the hook does not inspect anything: it rejects unconditionally. There is no metadata to
-- forge, no email to be "on the list", no window to race — the public signup endpoint simply has
-- no success path any more.
--
-- Rejecting unconditionally is also the safer failure direction. If a future GoTrue release
-- started calling the hook from the Admin API too, redemption would stop working and the
-- authorization suite would fail loudly, rather than the gate quietly opening.
--
-- GATE 2 — a BEFORE INSERT trigger on auth.users (invariant S2), which demands a live claim row.
-- The hook is configuration: it lives in supabase/config.toml and is pushed to a project with
-- `supabase config push`. A trigger travels with the migrations and cannot be left un-toggled in
-- an environment. It also closes what the hook does not — creating a user through the Auth Admin
-- API or the Supabase dashboard — so even service-role access cannot mint an account outside the
-- redemption flow without deliberately writing a claim first.
--
-- Neither gate can be satisfied by anything a browser can send. A claim is created only by
-- claim_invitation, which is REVOKEd from anon and authenticated and granted to service_role
-- alone, and which issues one only in exchange for a token whose SHA-256 matches a stored hash.
--
-- ── Why not an "allow if this email has an invitation" hook ──────────────────────────────────
--
-- Because it would be a hole. If the hook permitted public signup for any address with an
-- outstanding invitation, anyone who knew that address could call /auth/v1/signup and choose the
-- password themselves before the invited person ever opened their link. Knowing an address is not
-- possessing the token. Making the hook deny everything, and creating accounts only through a
-- server-side path that proves token possession first, removes that attack rather than narrowing
-- its window.

-- ── Gate 1: the Before User Created hook ─────────────────────────────────────────────────────
--
-- Contract per Supabase's Auth Hooks documentation: the function receives the event as jsonb and
-- returns jsonb. `{}` allows creation; an `error` object with an http_code and a message rejects
-- it, and the message is what the caller sees.
create or replace function public.before_user_created(event jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
begin
  -- `event` is intentionally unread. See the header: this hook is not a filter, it is a closed
  -- door on every self-service account-creation path GoTrue exposes.
  return jsonb_build_object(
    'error',
    jsonb_build_object(
      'http_code', 403,
      'message', 'This application is invite-only. Accounts are created only by redeeming an invitation link.'
    )
  );
end;
$$;

comment on function public.before_user_created(jsonb) is
  'Supabase Before User Created hook. Rejects every self-service signup unconditionally; see SECURITY.md §5.';

-- The hook is invoked by GoTrue as the supabase_auth_admin role.
grant usage on schema public to supabase_auth_admin;
grant execute on function public.before_user_created(jsonb) to supabase_auth_admin;
revoke execute on function public.before_user_created(jsonb) from public, anon, authenticated;

-- ── Gate 2: the auth.users backstop (invariant S2) ───────────────────────────────────────────
--
-- SECURITY DEFINER because it runs as supabase_auth_admin, which has no rights on
-- public.invitation_claims — and must not be given any, or the hook role would become a way to
-- read the claim table.
--
-- The trigger consumes the claim in the same transaction as the insert it authorizes. If GoTrue
-- rolls the insert back, the consumption rolls back with it; if it commits, the claim is spent
-- and cannot authorize a second account. Combined with the partial unique index on live claims,
-- that makes "one claim, one account" true by construction rather than by a check-then-act in
-- application code.
create or replace function public.enforce_invited_signup()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text := lower(btrim(coalesce(new.email, '')));
  v_claim_id uuid;
begin
  if v_email = '' then
    raise exception 'account creation requires a valid invitation'
      using errcode = '42501';
  end if;

  select id into v_claim_id
    from public.invitation_claims
   where email = v_email
     and consumed_at is null
     and expires_at > now()
     for update;

  if v_claim_id is null then
    raise exception 'account creation requires a valid invitation'
      using errcode = '42501';
  end if;

  update public.invitation_claims
     set consumed_at = now(),
         consumed_user_id = new.id
   where id = v_claim_id;

  return new;
end;
$$;

comment on function public.enforce_invited_signup() is
  'Invariant S2: no auth.users row without a live invitation claim. Backstop behind the Before User Created hook.';

revoke execute on function public.enforce_invited_signup() from public;

-- Fires before handle_new_user's AFTER INSERT profile creation, so a rejected signup never leaves
-- an orphan profile behind.
create trigger enforce_invited_signup_before_insert
  before insert on auth.users
  for each row execute function public.enforce_invited_signup();
