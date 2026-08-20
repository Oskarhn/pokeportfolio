-- M4, part 3 of 4: the invitation lifecycle, as database functions.
--
-- Three audiences, three privilege levels, and the grants are the boundary between them:
--
--   admin-callable (authenticated + is_admin check inside)
--     create_invitation, revoke_invitation
--   publicly callable (anon + authenticated), authorized by the token itself
--     invitation_status
--   service-role only, never reachable from a browser
--     claim_invitation, finalize_invitation_redemption, release_invitation_claim
--
-- Every function is SECURITY DEFINER with `set search_path = ''` and fully schema-qualified
-- references, contains no dynamic SQL, and is REVOKEd from PUBLIC before anything is granted —
-- PostgreSQL grants EXECUTE to PUBLIC by default and both `anon` and `authenticated` inherit it,
-- so relying on the default would silently publish the service-role functions.
--
-- Why invitation creation is an RPC and not an Edge Function: the only privileged thing it does
-- is generate a token and store its hash, which Postgres does natively. An Edge Function would
-- add a deployment surface and a service-role credential to protect for no gain. Redemption is
-- different — it must create an auth.users row, which requires the Auth Admin API — so that, and
-- only that, is an Edge Function.

-- ── Token hashing ────────────────────────────────────────────────────────────────────────────
--
-- SHA-256, not bcrypt/argon2. Password hashing is slow on purpose because a password has perhaps
-- 40 bits of entropy and must survive an offline dictionary attack. An invitation token here is
-- 256 bits from a CSPRNG: there is no dictionary, and no feasible offline attack for a slow hash
-- to slow down. A fast cryptographic hash gives the property that actually matters — the database
-- never holds anything that can be replayed as a token, even to someone with a full dump.
--
-- Lookup is by equality on the hash, using the unique index. That is the standard pattern and it
-- compares hashes, never the secret; no hand-written byte comparison is introduced.
create or replace function public.hash_invitation_token(p_token text)
returns text
language sql
immutable
set search_path = ''
as $$
  select encode(pg_catalog.sha256(pg_catalog.convert_to(p_token, 'UTF8')), 'hex')
$$;

revoke execute on function public.hash_invitation_token(text) from public;
grant execute on function public.hash_invitation_token(text) to service_role;

-- ── create_invitation (admin) ────────────────────────────────────────────────────────────────
--
-- Returns the raw token exactly once, to the admin's own browser, over TLS. It is never stored,
-- never logged, and cannot be recovered afterwards — if the admin loses it, they revoke the
-- invitation and issue another.
--
-- Default expiry is 7 days (168 hours). Long enough that "I'll set it up this weekend" works,
-- short enough that a link forgotten in a chat history stops being a key. Configurable per
-- invitation between 1 hour and 30 days.
create or replace function public.create_invitation(
  p_email text,
  p_expires_in_hours int default 168,
  p_label text default null
)
returns table (invitation_id uuid, token text, invited_email text, expires_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_token text;
  v_id uuid;
  v_expires timestamptz;
begin
  if v_actor is null or not public.is_admin() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  if v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'invalid_email' using errcode = '22023';
  end if;

  if p_expires_in_hours is null or p_expires_in_hours < 1 or p_expires_in_hours > 720 then
    raise exception 'invalid_expiry' using errcode = '22023';
  end if;

  -- An admin already knows the addresses they invite, so telling them one is taken discloses
  -- nothing they did not supply. This check exists so an invitation that could never be redeemed
  -- is never issued — claim_invitation would reject it later anyway.
  if exists (select 1 from auth.users u where lower(u.email) = v_email) then
    raise exception 'account_exists' using errcode = '23505';
  end if;

  -- base64url over 32 random bytes: 43 characters, 256 bits, safe in a URL path with no encoding.
  v_token := replace(replace(
    rtrim(encode(extensions.gen_random_bytes(32), 'base64'), '='),
    '+', '-'), '/', '_');
  v_expires := now() + pg_catalog.make_interval(hours => p_expires_in_hours);

  insert into public.invitations (token_hash, email, created_by, label, expires_at)
  values (
    public.hash_invitation_token(v_token),
    v_email,
    v_actor,
    nullif(btrim(coalesce(p_label, '')), ''),
    v_expires
  )
  returning id into v_id;

  return query select v_id, v_token, v_email, v_expires;
end;
$$;

revoke execute on function public.create_invitation(text, int, text) from public;
grant execute on function public.create_invitation(text, int, text) to authenticated;

-- ── revoke_invitation (admin) ────────────────────────────────────────────────────────────────
--
-- Revoking also drops any live claim, so an invitation cannot be revoked "too late" while a
-- redemption is mid-flight. Already-consumed claims are left alone: they are the audit record of
-- an account that exists.
create or replace function public.revoke_invitation(p_invitation_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not public.is_admin() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  update public.invitations
     set revoked_at = now()
   where id = p_invitation_id
     and revoked_at is null;

  if not found then
    raise exception 'invitation_not_found' using errcode = 'P0002';
  end if;

  delete from public.invitation_claims
   where invitation_id = p_invitation_id
     and consumed_at is null;
end;
$$;

revoke execute on function public.revoke_invitation(uuid) from public;
grant execute on function public.revoke_invitation(uuid) to authenticated;

-- ── invitation_status (public, authorized by the token) ──────────────────────────────────────
--
-- Lets the invite page show the invited address before asking for a password, so the person can
-- see they are setting up the right account. Callable by `anon` because the invited person has no
-- account yet — but "publicly invokable" is not "unrestricted": the 256-bit token is the
-- credential, and without an exact hash match the function returns the same negative answer for
-- every input. It reveals nothing about invitations the caller does not already hold the token
-- for, and there is nothing to enumerate.
--
-- Every failure mode collapses into one answer (SECURITY.md, prompt §62). "Expired" and
-- "already used" are not distinguished for the public caller; the admin view distinguishes them.
create or replace function public.invitation_status(p_token text)
returns table (valid boolean, invited_email text)
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  v_inv public.invitations%rowtype;
  v_live int;
begin
  if p_token is null or length(p_token) < 16 or length(p_token) > 256 then
    return query select false, null::text;
    return;
  end if;

  select * into v_inv
    from public.invitations
   where token_hash = public.hash_invitation_token(p_token);

  if not found
     or v_inv.revoked_at is not null
     or v_inv.expires_at <= now()
     or exists (select 1 from auth.users u where lower(u.email) = v_inv.email)
  then
    return query select false, null::text;
    return;
  end if;

  select count(*) into v_live
    from public.invitation_claims c
   where c.invitation_id = v_inv.id
     and (c.consumed_at is not null or c.expires_at > now());

  if v_live >= v_inv.max_uses then
    return query select false, null::text;
    return;
  end if;

  return query select true, v_inv.email;
end;
$$;

revoke execute on function public.invitation_status(text) from public;
grant execute on function public.invitation_status(text) to anon, authenticated;

-- ── claim_invitation (service role only) ─────────────────────────────────────────────────────
--
-- Step one of redemption. Validates the token and issues the two-minute claim that the auth.users
-- backstop will demand. Concurrency is handled by the database, not by application code:
--
--   * `FOR UPDATE` on the invitation row serializes concurrent redemptions of the same token, so
--     the availability count below is evaluated by one transaction at a time.
--   * The partial unique index on invitation_claims(email) WHERE consumed_at IS NULL makes a
--     second live claim for the same address impossible even across different invitations.
--
-- Availability is counted from claims — consumed ones plus live unexpired ones — rather than from
-- a stored counter. That is what makes failure recovery deterministic: a redemption that dies
-- after claiming releases its hold when the claim expires, with no cleanup job, and there is no
-- sequence of failures that can burn an invitation permanently.
create or replace function public.claim_invitation(p_token text)
returns table (claim_id uuid, invited_email text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_inv public.invitations%rowtype;
  v_live int;
  v_claim uuid;
begin
  if p_token is null or length(p_token) < 16 or length(p_token) > 256 then
    raise exception 'invitation_invalid' using errcode = 'P0002';
  end if;

  select * into v_inv
    from public.invitations
   where token_hash = public.hash_invitation_token(p_token)
     for update;

  if not found or v_inv.revoked_at is not null or v_inv.expires_at <= now() then
    raise exception 'invitation_invalid' using errcode = 'P0002';
  end if;

  if exists (select 1 from auth.users u where lower(u.email) = v_inv.email) then
    raise exception 'invitation_invalid' using errcode = 'P0002';
  end if;

  -- Expired, never-consumed claims are dead weight; clearing them here keeps the availability
  -- count and the unique index consistent with each other.
  delete from public.invitation_claims
   where email = v_inv.email
     and consumed_at is null
     and expires_at <= now();

  select count(*) into v_live
    from public.invitation_claims c
   where c.invitation_id = v_inv.id
     and (c.consumed_at is not null or c.expires_at > now());

  if v_live >= v_inv.max_uses then
    raise exception 'invitation_invalid' using errcode = 'P0002';
  end if;

  begin
    insert into public.invitation_claims (invitation_id, email, expires_at)
    values (v_inv.id, v_inv.email, now() + interval '2 minutes')
    returning id into v_claim;
  exception when unique_violation then
    -- Another redemption for this address is in flight and has not finished or expired.
    raise exception 'invitation_pending' using errcode = '55006';
  end;

  return query select v_claim, v_inv.email;
end;
$$;

revoke execute on function public.claim_invitation(text) from public, anon, authenticated;
grant execute on function public.claim_invitation(text) to service_role;

-- ── finalize_invitation_redemption (service role only) ───────────────────────────────────────
--
-- Step three. Runs only after the Auth Admin API has actually created the user, and only accepts
-- a claim the backstop trigger already consumed for that exact user id — so the redemption record
-- cannot be written for an account the claim did not create. Idempotent: a retry after a
-- half-failed response does not double-count use_count.
create or replace function public.finalize_invitation_redemption(p_claim_id uuid, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_claim public.invitation_claims%rowtype;
  v_inserted uuid;
begin
  select * into v_claim
    from public.invitation_claims
   where id = p_claim_id
     for update;

  if not found then
    raise exception 'claim_not_found' using errcode = 'P0002';
  end if;

  if v_claim.consumed_at is null or v_claim.consumed_user_id is distinct from p_user_id then
    raise exception 'claim_not_consumed_by_user' using errcode = '42501';
  end if;

  insert into public.invitation_redemptions (invitation_id, user_id)
  values (v_claim.invitation_id, p_user_id)
  on conflict (user_id) do nothing
  returning id into v_inserted;

  if v_inserted is not null then
    update public.invitations
       set use_count = use_count + 1
     where id = v_claim.invitation_id;
  end if;
end;
$$;

revoke execute on function public.finalize_invitation_redemption(uuid, uuid) from public, anon, authenticated;
grant execute on function public.finalize_invitation_redemption(uuid, uuid) to service_role;

-- ── release_invitation_claim (service role only) ─────────────────────────────────────────────
--
-- The explicit half of failure recovery: when user creation fails (a rejected password, a
-- transient Auth error), the redemption path releases its hold immediately instead of leaving the
-- invited person locked out for two minutes. Only unconsumed claims can be released — a claim the
-- backstop already spent belongs to an account that exists.
create or replace function public.release_invitation_claim(p_claim_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.invitation_claims
   where id = p_claim_id
     and consumed_at is null;
end;
$$;

revoke execute on function public.release_invitation_claim(uuid) from public, anon, authenticated;
grant execute on function public.release_invitation_claim(uuid) to service_role;

-- invitation_redemptions is written only by finalize_invitation_redemption. M3 granted SELECT to
-- authenticated (gated to admins by RLS); nothing else should be reachable.
revoke insert, update, delete on public.invitation_redemptions from authenticated;
